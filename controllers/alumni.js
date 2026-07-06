const supabase = require('../supabaseClient');
const { isValidUUID } = require('../middleware/sanitize');

// GET /api/alumni?search=&year=&class_name=&page=&limit=
exports.list = async (req, res) => {
  const { search, year, limit = 50, page = 1 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let query = supabase
    .from('alumni')
    .select(`
      *,
      students(first_name, last_name, dob, photo_url, status)
    `, { count: 'exact' })
    .eq('school_id', req.schoolId)
    .order('graduation_year', { ascending: false })
    .order('archived_at', { ascending: false })
    .range(offset, offset + Number(limit) - 1);

  if (year) query = query.eq('graduation_year', year);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  let alumni = data.map(a => ({
    ...a,
    first_name:  a.students?.first_name || '',
    last_name:   a.students?.last_name  || '',
    full_name:   a.students ? `${a.students.first_name} ${a.students.last_name}` : '—',
    dob:         a.students?.dob || null,
    photo_url:   a.students?.photo_url || null,
    students:    undefined,
  }));

  // In-memory search filter (keeps query simple)
  if (search) {
    const q = search.toLowerCase();
    alumni = alumni.filter(a =>
      a.full_name.toLowerCase().includes(q) ||
      (a.final_class_name || '').toLowerCase().includes(q)
    );
  }

  res.json({ alumni, total: count, page: Number(page), limit: Number(limit) });
};

// GET /api/alumni/:id — full history of a past student
exports.getOne = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { data: alum, error: aErr } = await supabase
    .from('alumni')
    .select('*, students(id, first_name, last_name, dob, photo_url)')
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .single();

  if (aErr || !alum) return res.status(404).json({ error: 'Alumni record not found.' });

  const studentId = alum.students?.id;

  // Fetch all grades grouped by term
  const { data: grades } = await supabase
    .from('grade_records')
    .select('*, subjects(name, code), classes(name)')
    .eq('school_id', req.schoolId)
    .eq('student_id', studentId)
    .order('academic_year', { ascending: true })
    .order('term', { ascending: true });

  // Fetch all term reports
  const { data: reports } = await supabase
    .from('term_reports')
    .select('*')
    .eq('school_id', req.schoolId)
    .eq('student_id', studentId)
    .order('academic_year', { ascending: true })
    .order('term', { ascending: true });

  // Fetch attendance summary
  const { data: attData } = await supabase
    .from('attendance')
    .select('status')
    .eq('school_id', req.schoolId)
    .eq('student_id', studentId);

  const attTotal   = attData?.length || 0;
  const attPresent = attData?.filter(r => r.status === 'present').length || 0;
  const attendance_rate = attTotal > 0 ? Math.round((attPresent / attTotal) * 100) : 0;

  // Fetch fee summary
  const { data: invoices } = await supabase
    .from('fee_invoices')
    .select('amount, amount_paid')
    .eq('school_id', req.schoolId)
    .eq('student_id', studentId);

  const fees_total     = (invoices || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const fees_paid      = (invoices || []).reduce((s, i) => s + Number(i.amount_paid || 0), 0);
  const fees_outstanding = Math.max(0, fees_total - fees_paid);

  // Group grades by term
  const gradesByTerm = {};
  for (const g of grades || []) {
    const key = `${g.academic_year}||${g.term}`;
    if (!gradesByTerm[key]) gradesByTerm[key] = { academic_year: g.academic_year, term: g.term, subjects: [] };
    gradesByTerm[key].subjects.push({
      subject_name: g.subjects?.name || '—',
      subject_code: g.subjects?.code || '',
      class_name:   g.classes?.name  || '—',
      ca_score: g.ca_score, exam_score: g.exam_score,
      total_score: g.total_score, grade: g.grade, grade_point: g.grade_point,
    });
  }

  res.json({
    alumni: {
      ...alum,
      full_name:  alum.students ? `${alum.students.first_name} ${alum.students.last_name}` : '—',
      dob:        alum.students?.dob || null,
      photo_url:  alum.students?.photo_url || null,
      students:   undefined,
    },
    academic_history: Object.values(gradesByTerm),
    term_reports:     reports || [],
    attendance:       { total: attTotal, present: attPresent, rate: attendance_rate },
    fees:             { total: fees_total, paid: fees_paid, outstanding: fees_outstanding },
  });
};

// POST /api/alumni/graduate — graduate a student (admin action)
exports.graduate = async (req, res) => {
  const { student_id, graduation_year, graduation_term, notes, certificate_issued = false } = req.body;

  if (!isValidUUID(student_id)) return res.status(400).json({ error: 'valid student_id required.' });
  if (!graduation_year) return res.status(400).json({ error: 'graduation_year is required.' });

  // Fetch current student + class name (snapshot)
  const { data: student, error: sErr } = await supabase
    .from('students')
    .select('id, first_name, last_name, status, class_id, classes(name)')
    .eq('id', student_id)
    .eq('school_id', req.schoolId)
    .single();

  if (sErr || !student) return res.status(404).json({ error: 'Student not found.' });
  if (student.status === 'alumni') return res.status(400).json({ error: 'Student is already graduated.' });

  const final_class_name = student.classes?.name || null;

  // Set student status to alumni
  const { error: uErr } = await supabase
    .from('students')
    .update({ status: 'alumni' })
    .eq('id', student_id)
    .eq('school_id', req.schoolId);

  if (uErr) return res.status(400).json({ error: uErr.message });

  // Create alumni record
  const { data: alum, error: aErr } = await supabase
    .from('alumni')
    .upsert({
      school_id: req.schoolId,
      student_id,
      graduation_year: String(graduation_year),
      graduation_term: graduation_term || null,
      final_class_name,
      certificate_issued,
      notes: notes || null,
      archived_at: new Date().toISOString(),
    }, { onConflict: 'school_id,student_id' })
    .select()
    .single();

  if (aErr) return res.status(400).json({ error: aErr.message });
  res.status(201).json({ alumni: alum, student_name: `${student.first_name} ${student.last_name}` });
};

// PUT /api/alumni/:id — update notes / certificate_issued
exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { notes, certificate_issued } = req.body;

  const { data, error } = await supabase
    .from('alumni')
    .update({ notes, certificate_issued })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ alumni: data });
};

// GET /api/alumni/years — distinct graduation years for filter dropdown
exports.years = async (req, res) => {
  const { data, error } = await supabase
    .from('alumni')
    .select('graduation_year')
    .eq('school_id', req.schoolId)
    .order('graduation_year', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  const years = [...new Set((data || []).map(r => r.graduation_year))];
  res.json({ years });
};
