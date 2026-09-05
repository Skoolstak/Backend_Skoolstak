const supabase = require('../supabaseClient');

exports.myClasses = async (req, res) => {
  const teacherProfileId = req.profile?.id; // classes.teacher_id references user_profiles.id

  let query = supabase
    .from('classes')
    .select('id, name, room, students(count), timetable_slots(subject)')
    .eq('school_id', req.schoolId)
    .eq('teacher_id', teacherProfileId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const classes = data.map(c => ({
    id:            c.id,
    name:          c.name,
    room:          c.room,
    student_count: c.students?.[0]?.count || 0,
    subject_count: new Set((c.timetable_slots || []).map(t => t.subject)).size,
  }));

  res.json({ classes });
};

exports.classStats = async (req, res) => {
  const { id } = req.params;
  const teacherProfileId = req.profile?.id;

  try {
    // Verify teacher has access to this class
    const { data: classData, error: classError } = await supabase
      .from('classes')
      .select('id, name')
      .eq('school_id', req.schoolId)
      .eq('id', id)
      .eq('teacher_id', teacherProfileId)
      .single();

    if (classError || !classData) {
      return res.status(403).json({ error: 'Access denied or class not found' });
    }

    const currentYear = new Date().getFullYear();
    const currentTerm = Math.ceil((new Date().getMonth() + 1) / 4);

    // Get total students
    const { count: total_students } = await supabase
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('school_id', req.schoolId)
      .eq('class_id', id);

    // Get total subjects for this class
    const { data: subjects } = await supabase
      .from('timetable_slots')
      .select('subject')
      .eq('school_id', req.schoolId)
      .eq('class_id', id);

    const total_subjects = new Set((subjects || []).map(s => s.subject)).size;

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

    // Get average score
    const { data: grades } = await supabase
      .from('grade_records')
      .select('total_score')
      .eq('school_id', req.schoolId)
      .eq('class_id', id)
      .eq('academic_year', currentYear)
      .eq('term', currentTerm);

    let avg_score = null;
    if (grades && grades.length > 0) {
      const validScores = grades.filter(g => g.total_score !== null);
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
  let query = supabase
    .from('assignments')
    .select('*, subjects(name), classes(name)')
    .eq('school_id', req.schoolId)
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

  // Verify the class belongs to this school
  const { data: classRow, error: classError } = await supabase
    .from('classes').select('id').eq('id', class_id).eq('school_id', req.schoolId).single();
  if (classError || !classRow) return res.status(404).json({ error: 'Class not found.' });

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
  const { error } = await supabase
    .from('assignments')
    .delete()
    .eq('id', id)
    .eq('school_id', req.schoolId);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};

