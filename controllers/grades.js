const supabase = require('../supabaseClient');
const { isValidUUID, isValidScore, isSafeText, MAX_REMARK_LENGTH } = require('../middleware/sanitize');

// ── WAEC Ghana GES grade computation ─────────────────────────
function computeWaecGrade(ca, exam) {
  const total = Number(ca || 0) + Number(exam || 0);
  if (total >= 80) return { grade: 'A1', grade_point: 1.0 };
  if (total >= 70) return { grade: 'B2', grade_point: 2.0 };
  if (total >= 60) return { grade: 'B3', grade_point: 3.0 };
  if (total >= 55) return { grade: 'C4', grade_point: 4.0 };
  if (total >= 50) return { grade: 'C5', grade_point: 5.0 };
  if (total >= 45) return { grade: 'C6', grade_point: 6.0 };
  if (total >= 40) return { grade: 'D7', grade_point: 7.0 };
  if (total >= 35) return { grade: 'E8', grade_point: 8.0 };
  return { grade: 'F9', grade_point: 9.0 };
}

// GET /api/grades?class_id=&subject_id=&term=&year=
exports.list = async (req, res) => {
  const { class_id, subject_id, student_id, term, year } = req.query;

  let query = supabase
    .from('grade_records')
    .select(`
      *,
      students(first_name, last_name),
      subjects(name, code),
      classes(name)
    `)
    .eq('school_id', req.schoolId)
    .order('created_at', { ascending: false });

  if (class_id)   query = query.eq('class_id', class_id);
  if (subject_id) query = query.eq('subject_id', subject_id);
  if (student_id) query = query.eq('student_id', student_id);
  if (term)       query = query.eq('term', term);
  if (year)       query = query.eq('academic_year', year);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const records = data.map(r => ({
    ...r,
    student_name: r.students ? `${r.students.first_name} ${r.students.last_name}` : null,
    subject_name: r.subjects?.name || null,
    subject_code: r.subjects?.code || null,
    class_name:   r.classes?.name || null,
    students: undefined, subjects: undefined, classes: undefined,
  }));

  res.json({ records });
};

// GET /api/grades/student/:student_id — full academic history
exports.studentHistory = async (req, res) => {
  if (!isValidUUID(req.params.student_id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { data, error } = await supabase
    .from('grade_records')
    .select('*, subjects(name, code), classes(name)')
    .eq('school_id', req.schoolId)
    .eq('student_id', req.params.student_id)
    .order('academic_year', { ascending: true })
    .order('term', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Group by academic_year → term
  const grouped = {};
  for (const r of data) {
    const key = `${r.academic_year}||${r.term}`;
    if (!grouped[key]) grouped[key] = { academic_year: r.academic_year, term: r.term, subjects: [] };
    grouped[key].subjects.push({
      subject_name:        r.subjects?.name || '—',
      subject_code:        r.subjects?.code || '',
      class_name:          r.classes?.name || '—',
      ca_score:            r.ca_score,
      exam_score:          r.exam_score,
      participation_score: r.participation_score,
      project_score:       r.project_score,
      mock_score:          r.mock_score,
      total_score:         r.total_score,
      grade:               r.grade,
      grade_point:         r.grade_point,
      remarks:             r.remarks,
    });
  }

  res.json({ history: Object.values(grouped) });
};

// POST /api/grades — teacher posts/upserts a grade record
exports.upsert = async (req, res) => {
  const {
    student_id, subject_id, class_id, term, academic_year,
    ca_score = 0, exam_score = 0,
    participation_score = 0, project_score = 0, mock_score = 0,
    remarks,
  } = req.body;

  if (!student_id || !isValidUUID(student_id)) return res.status(400).json({ error: 'valid student_id required.' });
  if (!subject_id || !isValidUUID(subject_id)) return res.status(400).json({ error: 'valid subject_id required.' });
  if (!class_id   || !isValidUUID(class_id))   return res.status(400).json({ error: 'valid class_id required.' });
  if (!term)        return res.status(400).json({ error: 'term is required.' });
  if (!academic_year) return res.status(400).json({ error: 'academic_year is required.' });
  if (!isSafeText(term, 20))          return res.status(400).json({ error: 'Invalid term value.' });
  if (!isSafeText(academic_year, 12)) return res.status(400).json({ error: 'Invalid academic_year value.' });
  if (!isValidScore(ca_score, 0, 30))            return res.status(400).json({ error: 'ca_score must be 0–30.' });
  if (!isValidScore(exam_score, 0, 70))          return res.status(400).json({ error: 'exam_score must be 0–70.' });
  if (!isValidScore(participation_score, 0, 10)) return res.status(400).json({ error: 'participation_score must be 0–10.' });
  if (!isValidScore(project_score, 0, 10))       return res.status(400).json({ error: 'project_score must be 0–10.' });
  if (!isValidScore(mock_score, 0, 10))          return res.status(400).json({ error: 'mock_score must be 0–10.' });
  if (remarks && typeof remarks === 'string' && remarks.length > MAX_REMARK_LENGTH) {
    return res.status(400).json({ error: `Remarks cannot exceed ${MAX_REMARK_LENGTH} characters.` });
  }

  const { grade, grade_point } = computeWaecGrade(ca_score, exam_score);

  const payload = {
    school_id: req.schoolId,
    student_id, subject_id, class_id, term, academic_year,
    ca_score:            Math.min(30, Math.max(0, Number(ca_score))),
    exam_score:          Math.min(70, Math.max(0, Number(exam_score))),
    participation_score: Math.min(10, Math.max(0, Number(participation_score))),
    project_score:       Math.min(10, Math.max(0, Number(project_score))),
    mock_score:          Math.min(10, Math.max(0, Number(mock_score))),
    grade, grade_point,
    remarks: remarks || null,
    posted_by: req.profile?.id || null,
  };

  const { data, error } = await supabase
    .from('grade_records')
    .upsert(payload, {
      onConflict: 'school_id,student_id,subject_id,term,academic_year',
      ignoreDuplicates: false,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ record: data });
};

// POST /api/grades/bulk — upsert multiple grade records at once
exports.bulkUpsert = async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required.' });
  }

  const payload = records.map(r => {
    const { grade, grade_point } = computeWaecGrade(r.ca_score, r.exam_score);
    return {
      school_id:           req.schoolId,
      student_id:          r.student_id,
      subject_id:          r.subject_id,
      class_id:            r.class_id,
      term:                r.term,
      academic_year:       r.academic_year,
      ca_score:            Math.min(30, Math.max(0, Number(r.ca_score || 0))),
      exam_score:          Math.min(70, Math.max(0, Number(r.exam_score || 0))),
      participation_score: Math.min(10, Math.max(0, Number(r.participation_score || 0))),
      project_score:       Math.min(10, Math.max(0, Number(r.project_score || 0))),
      mock_score:          Math.min(10, Math.max(0, Number(r.mock_score || 0))),
      grade, grade_point,
      remarks:             r.remarks || null,
      posted_by:           req.profile?.id || null,
    };
  });

  const { data, error } = await supabase
    .from('grade_records')
    .upsert(payload, {
      onConflict: 'school_id,student_id,subject_id,term,academic_year',
      ignoreDuplicates: false,
    })
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ records: data, count: data.length });
};

// PUT /api/grades/:id — update a single grade record
exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { ca_score, exam_score, participation_score, project_score, mock_score, remarks } = req.body;
  const { grade, grade_point } = computeWaecGrade(ca_score, exam_score);

  const { data, error } = await supabase
    .from('grade_records')
    .update({
      ca_score:            Math.min(30, Math.max(0, Number(ca_score || 0))),
      exam_score:          Math.min(70, Math.max(0, Number(exam_score || 0))),
      participation_score: Math.min(10, Math.max(0, Number(participation_score || 0))),
      project_score:       Math.min(10, Math.max(0, Number(project_score || 0))),
      mock_score:          Math.min(10, Math.max(0, Number(mock_score || 0))),
      grade, grade_point,
      remarks: remarks || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ record: data });
};

// DELETE /api/grades/:id — admin only
exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { error } = await supabase
    .from('grade_records')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};

// POST /api/grades/sync — receive offline-queued grade records
exports.syncOffline = async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.json({ synced: 0 });
  }

  // Log sync action
  await supabase.from('sync_log').insert({
    school_id:   req.schoolId,
    user_id:     req.profile?.id || null,
    action_type: 'grade',
    payload:     { count: records.length },
    device_id:   req.headers['x-device-id'] || null,
  });

  // Reuse bulk upsert logic inline
  const payload = records.map(r => {
    const { grade, grade_point } = computeWaecGrade(r.ca_score, r.exam_score);
    return {
      school_id: req.schoolId,
      student_id: r.student_id, subject_id: r.subject_id,
      class_id: r.class_id, term: r.term, academic_year: r.academic_year,
      ca_score:            Math.min(30, Math.max(0, Number(r.ca_score || 0))),
      exam_score:          Math.min(70, Math.max(0, Number(r.exam_score || 0))),
      participation_score: Math.min(10, Math.max(0, Number(r.participation_score || 0))),
      project_score:       Math.min(10, Math.max(0, Number(r.project_score || 0))),
      mock_score:          Math.min(10, Math.max(0, Number(r.mock_score || 0))),
      grade, grade_point,
      remarks: r.remarks || null,
      posted_by: req.profile?.id || null,
    };
  });

  const { data, error } = await supabase
    .from('grade_records')
    .upsert(payload, { onConflict: 'school_id,student_id,subject_id,term,academic_year' })
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: data.length });
};
