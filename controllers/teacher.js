const supabase = require('../supabaseClient');
const { teacherClassIds } = require('../utils/access');

// Counts active students per class for the given class ids
async function activeStudentCounts(schoolId, classIds) {
  const counts = {};
  if (classIds.length === 0) return counts;
  const { data } = await supabase
    .from('students')
    .select('class_id')
    .eq('school_id', schoolId)
    .eq('status', 'active')
    .in('class_id', classIds);
  for (const s of data || []) counts[s.class_id] = (counts[s.class_id] || 0) + 1;
  return counts;
}

// The classes a teacher works with: class teacher, or assigned a subject / timetable slot there
exports.myClasses = async (req, res) => {
  const classIds = await teacherClassIds(req);
  if (classIds.length === 0) return res.json({ classes: [] });

  const { data, error } = await supabase
    .from('classes')
    .select('id, name, timetable_slots(subject)')
    .eq('school_id', req.schoolId)
    .in('id', classIds)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });

  const { data: subjectRows } = await supabase
    .from('subjects')
    .select('class_id, name')
    .eq('school_id', req.schoolId)
    .eq('is_active', true)
    .in('class_id', classIds);
  const subjectsByClass = {};
  for (const s of subjectRows || []) {
    (subjectsByClass[s.class_id] ||= new Set()).add(s.name);
  }

  const counts = await activeStudentCounts(req.schoolId, classIds);

  const classes = data.map(c => ({
    id:            c.id,
    name:          c.name,
    student_count: counts[c.id] || 0,
    subject_count: subjectsByClass[c.id]?.size || new Set((c.timetable_slots || []).map(t => t.subject)).size,
  }));

  res.json({ classes });
};

exports.classStats = async (req, res) => {
  const { id } = req.params;

  try {
    // Verify the teacher works with this class
    const classIds = await teacherClassIds(req);
    if (!classIds.includes(id)) {
      return res.status(403).json({ error: 'Access denied or class not found' });
    }

    const currentYear = new Date().getFullYear();
    const currentTerm = Math.ceil((new Date().getMonth() + 1) / 4);

    // Active students in the class
    const { count: total_students } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('school_id', req.schoolId)
      .eq('class_id', id)
      .eq('status', 'active');

    // Subjects for this class: the Subjects list, or the timetable if none are set up yet
    const { count: subjectCount } = await supabase
      .from('subjects')
      .select('*', { count: 'exact', head: true })
      .eq('school_id', req.schoolId)
      .eq('class_id', id)
      .eq('is_active', true);
    let total_subjects = subjectCount || 0;
    if (total_subjects === 0) {
      const { data: slotSubjects } = await supabase
        .from('timetable_slots')
        .select('subject')
        .eq('school_id', req.schoolId)
        .eq('class_id', id);
      total_subjects = new Set((slotSubjects || []).map(s => s.subject)).size;
    }

    // Get attendance stats
    const { data: attendanceRecords } = await supabase
      .from('attendance')
      .select('status, student_id')
      .eq('school_id', req.schoolId)
      .eq('class_id', id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm);

    let avg_attendance = null;
    if (attendanceRecords && attendanceRecords.length > 0) {
      const studentAttendance = {};
      attendanceRecords.forEach(record => {
        if (!studentAttendance[record.student_id]) {
          studentAttendance[record.student_id] = { present: 0, total: 0 };
        }
        studentAttendance[record.student_id].total++;
        if (record.status === 'present') {
          studentAttendance[record.student_id].present++;
        }
      });

      const rates = Object.values(studentAttendance).map(s => (s.present / s.total) * 100);
      avg_attendance = rates.length > 0 
        ? Math.round(rates.reduce((sum, r) => sum + r, 0) / rates.length)
        : 0;
    }

    // Average score for the most recent term that has grades (grades are stored as "Term 1" / "2026/2027",
    // so matching against a computed term number would never find them)
    const { data: grades } = await supabase
      .from('grade_records')
      .select('total_score, term, academic_year')
      .eq('school_id', req.schoolId)
      .eq('class_id', id)
      .order('created_at', { ascending: false })
      .limit(1000);

    let avg_score = null;
    if (grades && grades.length > 0) {
      const latest = grades[0];
      const validScores = grades.filter(g =>
        g.term === latest.term && g.academic_year === latest.academic_year && g.total_score !== null);
      if (validScores.length > 0) {
        avg_score = Math.round(
          validScores.reduce((sum, g) => sum + Number(g.total_score), 0) / validScores.length
        );
      }
    }

    res.json({
      total_students: total_students || 0,
      total_subjects,
      avg_attendance,
      avg_score,
    });
  } catch (error) {
    console.error('Class stats error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.listAssignments = async (req, res) => {
  const { class_id, term, year } = req.query;
  // A teacher sees the assignments they posted
  let query = supabase
    .from('assignments')
    .select('*, subjects(name), classes(name)')
    .eq('school_id', req.schoolId)
    .eq('teacher_id', req.profile?.id)
    .order('due_date', { ascending: false });

  if (class_id) query = query.eq('class_id', class_id);
  if (term)     query = query.eq('term', String(term));
  if (year)     query = query.eq('academic_year', String(year));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const assignments = (data || []).map(a => ({
    ...a,
    subject_name: a.subjects?.name || null,
    class_name:   a.classes?.name || null,
    subjects: undefined,
    classes:  undefined,
  }));
  res.json({ assignments });
};

exports.createAssignment = async (req, res) => {
  const { class_id, subject_id, title, description, due_date, max_score, term, academic_year } = req.body;

  if (!class_id || !title?.trim() || !due_date) {
    return res.status(400).json({ error: 'class_id, title, and due_date are required.' });
  }

  // The class must be one this teacher works with (and belong to this school)
  const myClasses = await teacherClassIds(req);
  if (!myClasses.includes(class_id)) {
    return res.status(403).json({ error: 'You can only set assignments for your own classes.' });
  }

  const { data, error } = await supabase
    .from('assignments')
    .insert({
      school_id: req.schoolId,
      class_id,
      subject_id: subject_id || null,
      teacher_id: req.profile?.id || null,
      title: title.trim(),
      description: description || null,
      due_date,
      max_score: max_score != null && max_score !== '' ? Number(max_score) : null,
      term: term != null ? String(term) : null,
      academic_year: academic_year != null ? String(academic_year) : null,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ assignment: data });
};

exports.deleteAssignment = async (req, res) => {
  const { id } = req.params;
  // A teacher can only delete assignments they posted themselves
  const { data, error } = await supabase
    .from('assignments')
    .delete()
    .eq('id', id)
    .eq('school_id', req.schoolId)
    .eq('teacher_id', req.profile?.id)
    .select('id');

  if (error) return res.status(400).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Assignment not found.' });
  res.json({ success: true });
};

