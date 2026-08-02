const supabase = require('../supabaseClient');

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
    // Get current term and year (you may want to make this dynamic)
    const currentYear = new Date().getFullYear();
    const currentTerm = Math.ceil((new Date().getMonth() + 1) / 4); // Term 1-3 based on month

    // Get grades for GPA and recent performance
    const { data: grades } = await supabase
      .from('grade_records')
      .select('*, subjects(name)')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm)
      .order('created_at', { ascending: false });

    // Calculate GPA (assuming grade_point exists)
    const validGrades = (grades || []).filter(g => g.grade_point);
    const gpa = validGrades.length > 0 
      ? (validGrades.reduce((sum, g) => sum + Number(g.grade_point || 0), 0) / validGrades.length).toFixed(2)
      : null;

    // Get recent grades for display
    const recent_grades = (grades || []).slice(0, 4).map(g => ({
      subject_name: g.subjects?.name || '—',
      total_score: g.total_score,
      grade: g.grade,
      term: `Term ${g.term}`,
      academic_year: g.academic_year,
    }));

    // Get class position (simplified - would need proper ranking logic)
    const class_position = '—'; // TODO: Implement ranking

    // Get total subjects
    const { count: total_subjects } = await supabase
      .from('timetable_slots')
      .select('subject', { count: 'exact', head: true })
      .eq('school_id', req.schoolId)
      .eq('class_id', student.class_id);

    // Get attendance stats
    const { data: attendanceRecords } = await supabase
      .from('attendance')
      .select('status')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm);

    const total_days = (attendanceRecords || []).length;
    const present_days = (attendanceRecords || []).filter(r => r.status === 'Present').length;
    const absent_days = (attendanceRecords || []).filter(r => r.status === 'Absent').length;
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
  const currentYear = year || new Date().getFullYear();
  const currentTerm = term || Math.ceil((new Date().getMonth() + 1) / 4);

  try {
    const { data: records } = await supabase
      .from('attendance')
      .select('status, date, remarks')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm)
      .order('date', { ascending: false });

    const total_days = (records || []).length;
    const present_days = (records || []).filter(r => r.status === 'Present').length;
    const absent_days = (records || []).filter(r => r.status === 'Absent').length;
    const late_days = (records || []).filter(r => r.status === 'Late').length;
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
        remarks: r.remarks,
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
  const currentYear = year || new Date().getFullYear();
  const currentTerm = term || Math.ceil((new Date().getMonth() + 1) / 4);

  try {
    // Note: This assumes an 'assignments' table exists. If not, return empty array for now.
    const { data, error } = await supabase
      .from('assignments')
      .select('*, subjects(name), user_profiles!teacher_id(first_name, last_name), assignment_submissions(status, submission_date, score)')
      .eq('school_id', req.schoolId)
      .eq('class_id', student.class_id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm)
      .order('due_date', { ascending: true });

    if (error) {
      // If table doesn't exist, return empty array
      console.warn('Assignments table might not exist:', error.message);
      return res.json({ assignments: [] });
    }

    const assignments = (data || []).map(a => {
      const submission = (a.assignment_submissions || [])[0];
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

