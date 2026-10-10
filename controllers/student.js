const supabase = require('../supabaseClient');
const { termOf } = require('../utils/term');

async function getStudentId(req) {
  const { data } = await supabase.from('students').select('id, class_id, first_name, last_name').eq('school_id', req.schoolId).eq('user_profile_id', req.profile?.id).single();
  return data;
}

exports.timetable = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({ slots: [] });

  const { data, error } = await supabase.from('timetable_slots')
    .select('*, user_profiles!teacher_id(first_name,last_name)')
    .eq('school_id', req.schoolId).eq('class_id', student.class_id).order('period');

  if (error) return res.status(500).json({ error: error.message });
  const slots = (data||[]).map(s => ({ ...s, subject_name: s.subject, teacher_name: s.user_profiles?`${s.user_profiles.first_name} ${s.user_profiles.last_name}`:null }));
  res.json({ slots });
};

exports.attendance = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({ records: [], summary: null });
  const { term, year } = req.query;

  let query = supabase.from('attendance').select('date, status, remark, classes(name)')
    .eq('school_id', req.schoolId).eq('student_id', student.id).order('date', { ascending: false });
  if (term) query = query.eq('term', term);
  if (year) query = query.eq('academic_year', year);

  const { data } = await query;
  const records  = (data||[]).map(r=>({ ...r, class_name: r.classes?.name }));
  const total    = records.length;
  const present  = records.filter(r=>r.status==='present').length;
  const absent   = records.filter(r=>r.status==='absent').length;
  const rate     = total>0 ? Math.round((present/total)*100) : 0;

  res.json({ records, summary: { total, present, absent, rate } });
};

exports.fees = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({ invoices: [], summary: null });
  const { term, year } = req.query;

  let query = supabase.from('fee_invoices').select('*, fee_types(name)')
    .eq('school_id', req.schoolId).eq('student_id', student.id).order('created_at', { ascending: false });
  if (term) query = query.eq('term', term);
  if (year) query = query.eq('academic_year', year);

  const { data } = await query;
  const invoices = (data||[]).map(i=>({ ...i, fee_type_name: i.fee_types?.name, balance: Math.max(0, Number(i.amount)-Number(i.amount_paid||0)) }));
  const summary  = {
    total_billed:      invoices.reduce((s,i)=>s+Number(i.amount),0),
    total_paid:        invoices.reduce((s,i)=>s+Number(i.amount_paid||0),0),
    total_outstanding: invoices.reduce((s,i)=>s+i.balance,0),
    invoice_count:     invoices.length,
  };

  res.json({ invoices, summary });
};

exports.academicHistory = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({ history: [] });

  const { data, error } = await supabase
    .from('grade_records')
    .select('*, subjects(name, code), classes(name)')
    .eq('school_id', req.schoolId)
    .eq('student_id', student.id)
    .order('academic_year', { ascending: true })
    .order('term', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const grouped = {};
  for (const r of data || []) {
    const key = `${r.academic_year}||${r.term}`;
    if (!grouped[key]) grouped[key] = { academic_year: r.academic_year, term: r.term, subjects: [] };
    grouped[key].subjects.push({
      subject_name: r.subjects?.name || '—',
      subject_code: r.subjects?.code || '',
      class_name:   r.classes?.name  || '—',
      ca_score: r.ca_score, exam_score: r.exam_score,
      total_score: r.total_score, grade: r.grade, grade_point: r.grade_point,
      remarks: r.remarks,
    });
  }

  res.json({ history: Object.values(grouped) });
};

exports.library = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({ loans: [] });

  const { data } = await supabase.from('book_loans').select('*, books(title, author)')
    .eq('school_id', req.schoolId).eq('student_id', student.id).order('issued_at', { ascending: false });

  const loans = (data||[]).map(l=>({ ...l, book_title: l.books?.title, book_author: l.books?.author }));
  res.json({ loans });
};

exports.dashboardSummary = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({});

  try {
    // Attendance is stored under the Ghana-calendar term of its date (see utils/term.js)
    const { term: currentTerm, year: currentYear } = termOf();

    // Grades come from the most recent term that has any. They are stored as "Term 1" / "2026/2027",
    // so a computed term number would never match them and the dashboard would always be empty.
    const { data: gradeRows } = await supabase
      .from('grade_records')
      .select('*, subjects(name)')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .order('created_at', { ascending: false })
      .limit(200);
    const latest = (gradeRows || [])[0];
    const grades = latest
      ? gradeRows.filter(g => g.term === latest.term && g.academic_year === latest.academic_year)
      : [];

    // Average grade point (a number, so the page can format it)
    const validGrades = grades.filter(g => g.grade_point != null);
    const gpa = validGrades.length > 0
      ? Number((validGrades.reduce((sum, g) => sum + Number(g.grade_point), 0) / validGrades.length).toFixed(2))
      : null;

    const termLabel = (t) => (/^\d+$/.test(String(t)) ? `Term ${t}` : String(t));
    const recent_grades = grades.slice(0, 4).map(g => ({
      subject_name: g.subjects?.name || '—',
      total_score: g.total_score,
      grade: g.grade,
      term: termLabel(g.term),
      academic_year: g.academic_year,
    }));

    // Get class position (simplified - would need proper ranking logic)
    const class_position = '—'; // TODO: Implement ranking

    // Subjects for the student's class: the Subjects list, or the timetable if none are set up yet.
    // (Counting timetable slots would count every period, not every subject.)
    let total_subjects = 0;
    if (student.class_id) {
      const { count: subjectCount } = await supabase
        .from('subjects')
        .select('*', { count: 'exact', head: true })
        .eq('school_id', req.schoolId)
        .eq('class_id', student.class_id)
        .eq('is_active', true);
      total_subjects = subjectCount || 0;
      if (total_subjects === 0) {
        const { data: slotSubjects } = await supabase
          .from('timetable_slots')
          .select('subject')
          .eq('school_id', req.schoolId)
          .eq('class_id', student.class_id);
        total_subjects = new Set((slotSubjects || []).map(s => s.subject)).size;
      }
    }

    // Get attendance stats
    const { data: attendanceRecords } = await supabase
      .from('attendance')
      .select('status')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm);

    const total_days = (attendanceRecords || []).length;
    const present_days = (attendanceRecords || []).filter(r => r.status === 'present').length;
    const absent_days = (attendanceRecords || []).filter(r => r.status === 'absent').length;
    const attendance_rate = total_days > 0 ? Math.round((present_days / total_days) * 100) : 0;

    res.json({
      student_name: `${student.first_name} ${student.last_name}`,
      gpa,
      class_position,
      total_subjects: total_subjects || 0,
      attendance_rate,
      present_days,
      absent_days,
      total_days,
      recent_grades,
      important_notice: null, // Can be set based on admin announcements
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.attendanceSummary = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({});

  const { term, year } = req.query;
  const cur = termOf();
  const currentYear = year || cur.year;
  const currentTerm = term || cur.term;

  try {
    const { data: records } = await supabase
      .from('attendance')
      .select('status, date, remark')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm)
      .order('date', { ascending: false });

    const total_days = (records || []).length;
    const present_days = (records || []).filter(r => r.status === 'present').length;
    const absent_days = (records || []).filter(r => r.status === 'absent').length;
    const late_days = (records || []).filter(r => r.status === 'late').length;
    const attendance_rate = total_days > 0 ? Math.round((present_days / total_days) * 100) : 0;

    res.json({
      present_days,
      absent_days,
      late_days,
      total_days,
      attendance_rate,
      records: (records || []).map(r => ({
        date: r.date,
        status: r.status,
        remarks: r.remark,
      })),
    });
  } catch (error) {
    console.error('Attendance summary error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.assignments = async (req, res) => {
  const student = await getStudentId(req);
  if (!student) return res.json({ assignments: [] });

  const { term, year } = req.query;
  const cur = termOf();
  const currentYear = year || cur.year;
  const currentTerm = term || cur.term;

  try {
    const { data, error } = await supabase
      .from('assignments')
      .select('*, subjects(name), user_profiles!teacher_id(first_name, last_name)')
      .eq('school_id', req.schoolId)
      .eq('class_id', student.class_id)
      .eq('academic_year', String(currentYear))
      .eq('term', String(currentTerm))
      .order('due_date', { ascending: true });

    if (error) {
      console.warn('Assignments query failed:', error.message);
      return res.json({ assignments: [] });
    }

    // Only THIS student's submissions (an assignment has one submission per student in the class)
    const submissionByAssignment = {};
    const assignmentIds = (data || []).map(a => a.id);
    if (assignmentIds.length > 0) {
      const { data: submissions } = await supabase
        .from('assignment_submissions')
        .select('assignment_id, status, submission_date, score')
        .eq('school_id', req.schoolId)
        .eq('student_id', student.id)
        .in('assignment_id', assignmentIds);
      for (const s of submissions || []) submissionByAssignment[s.assignment_id] = s;
    }

    const assignments = (data || []).map(a => {
      const submission = submissionByAssignment[a.id];
      const now = new Date();
      const dueDate = new Date(a.due_date);
      let status = 'Pending';
      
      if (submission) {
        status = submission.status === 'graded' ? 'Graded' : 'Submitted';
      } else if (dueDate < now) {
        status = 'Overdue';
      }

      return {
        id: a.id,
        title: a.title,
        description: a.description,
        subject_name: a.subjects?.name || '—',
        teacher_name: a.user_profiles ? `${a.user_profiles.first_name} ${a.user_profiles.last_name}` : '—',
        due_date: a.due_date,
        max_score: a.max_score,
        status,
        submission_date: submission?.submission_date,
        score: submission?.score,
        attachment_url: a.attachment_url,
        submission_url: submission?.submission_url,
      };
    });

    res.json({ assignments });
  } catch (error) {
    console.error('Assignments error:', error);
    // Return empty array if table doesn't exist
    res.json({ assignments: [] });
  }
};

