const supabase = require('../supabaseClient');
const { isValidUUID } = require('../middleware/sanitize');

// POST /api/reports/generate
// Computes and upserts a term_report for a student from their grade_records
exports.generate = async (req, res) => {
  const { student_id, class_id, term, academic_year } = req.body;

  if (!isValidUUID(student_id)) return res.status(400).json({ error: 'valid student_id required.' });
  if (!isValidUUID(class_id))   return res.status(400).json({ error: 'valid class_id required.' });
  if (!term)         return res.status(400).json({ error: 'term is required.' });
  if (!academic_year) return res.status(400).json({ error: 'academic_year is required.' });

  // Fetch grade records for this student this term
  const { data: grades, error: gErr } = await supabase
    .from('grade_records')
    .select('total_score, grade_point, subject_id')
    .eq('school_id', req.schoolId)
    .eq('student_id', student_id)
    .eq('term', term)
    .eq('academic_year', academic_year);

  if (gErr) return res.status(500).json({ error: gErr.message });

  const total_subjects = grades.length;
  const average_score  = total_subjects > 0
    ? parseFloat((grades.reduce((s, g) => s + Number(g.total_score || 0), 0) / total_subjects).toFixed(2))
    : 0;
  const aggregate_score = parseFloat(
    grades.reduce((s, g) => s + Number(g.grade_point || 9), 0).toFixed(1)
  );

  // Determine overall grade band from average
  let overall_grade = 'F9';
  if (average_score >= 80) overall_grade = 'A1';
  else if (average_score >= 70) overall_grade = 'B2';
  else if (average_score >= 60) overall_grade = 'B3';
  else if (average_score >= 55) overall_grade = 'C4';
  else if (average_score >= 50) overall_grade = 'C5';
  else if (average_score >= 45) overall_grade = 'C6';
  else if (average_score >= 40) overall_grade = 'D7';
  else if (average_score >= 35) overall_grade = 'E8';

  // Attendance rate this term
  const { data: attData } = await supabase
    .from('attendance')
    .select('status')
    .eq('school_id', req.schoolId)
    .eq('student_id', student_id)
    .eq('term', term);

  const attTotal   = attData?.length || 0;
  const attPresent = attData?.filter(r => r.status === 'present').length || 0;
  const attendance_rate = attTotal > 0 ? parseFloat(((attPresent / attTotal) * 100).toFixed(2)) : 0;

  // Class size
  const { count: class_size } = await supabase
    .from('students')
    .select('*', { count: 'exact', head: true })
    .eq('school_id', req.schoolId)
    .eq('class_id', class_id)
    .eq('status', 'active');

  // Upsert the report (position calculated separately via generateClassReports)
  const { data: report, error: rErr } = await supabase
    .from('term_reports')
    .upsert({
      school_id: req.schoolId,
      student_id, class_id, term, academic_year,
      total_subjects, aggregate_score, average_score, overall_grade,
      attendance_rate, class_size: class_size || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'school_id,student_id,term,academic_year' })
    .select()
    .single();

  if (rErr) return res.status(400).json({ error: rErr.message });
  res.status(201).json({ report });
};

// POST /api/reports/generate-class
// Generates/updates term reports for all students in a class, then ranks them
exports.generateClass = async (req, res) => {
  const { class_id, term, academic_year } = req.body;
  if (!isValidUUID(class_id)) return res.status(400).json({ error: 'valid class_id required.' });
  if (!term || !academic_year) return res.status(400).json({ error: 'term and academic_year required.' });

  // Get all active students in this class
  const { data: students, error: sErr } = await supabase
    .from('students')
    .select('id')
    .eq('school_id', req.schoolId)
    .eq('class_id', class_id)
    .in('status', ['active']);

  if (sErr) return res.status(500).json({ error: sErr.message });

  const class_size = students.length;
  const results = [];

  for (const student of students) {
    // Fetch grades
    const { data: grades } = await supabase
      .from('grade_records')
      .select('total_score, grade_point')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('term', term)
      .eq('academic_year', academic_year);

    const total_subjects = grades?.length || 0;
    const average_score  = total_subjects > 0
      ? parseFloat((grades.reduce((s, g) => s + Number(g.total_score || 0), 0) / total_subjects).toFixed(2))
      : 0;
    const aggregate_score = parseFloat(
      (grades || []).reduce((s, g) => s + Number(g.grade_point || 9), 0).toFixed(1)
    );

    let overall_grade = 'F9';
    if (average_score >= 80) overall_grade = 'A1';
    else if (average_score >= 70) overall_grade = 'B2';
    else if (average_score >= 60) overall_grade = 'B3';
    else if (average_score >= 55) overall_grade = 'C4';
    else if (average_score >= 50) overall_grade = 'C5';
    else if (average_score >= 45) overall_grade = 'C6';
    else if (average_score >= 40) overall_grade = 'D7';
    else if (average_score >= 35) overall_grade = 'E8';

    const { data: attData } = await supabase
      .from('attendance')
      .select('status')
      .eq('school_id', req.schoolId)
      .eq('student_id', student.id)
      .eq('term', term);

    const attTotal   = attData?.length || 0;
    const attPresent = attData?.filter(r => r.status === 'present').length || 0;
    const attendance_rate = attTotal > 0 ? parseFloat(((attPresent / attTotal) * 100).toFixed(2)) : 0;

    results.push({ student_id: student.id, average_score, aggregate_score, overall_grade, total_subjects, attendance_rate, class_size });
  }

  // Rank by average_score descending
  results.sort((a, b) => b.average_score - a.average_score);

  const upsertPayload = results.map((r, idx) => ({
    school_id: req.schoolId,
    student_id: r.student_id,
    class_id, term, academic_year,
    total_subjects: r.total_subjects,
    aggregate_score: r.aggregate_score,
    average_score: r.average_score,
    overall_grade: r.overall_grade,
    class_position: idx + 1,
    class_size: r.class_size,
    attendance_rate: r.attendance_rate,
    updated_at: new Date().toISOString(),
  }));

  const { error: uErr } = await supabase
    .from('term_reports')
    .upsert(upsertPayload, { onConflict: 'school_id,student_id,term,academic_year' });

  if (uErr) return res.status(400).json({ error: uErr.message });
  res.json({ generated: upsertPayload.length, class_id, term, academic_year });
};

// GET /api/reports?student_id=&term=&year=
exports.list = async (req, res) => {
  const { student_id, class_id, term, year } = req.query;

  let query = supabase
    .from('term_reports')
    .select('*, students(first_name, last_name), classes(name)')
    .eq('school_id', req.schoolId)
    .order('academic_year', { ascending: false })
    .order('term', { ascending: false });

  if (student_id) query = query.eq('student_id', student_id);
  if (class_id)   query = query.eq('class_id', class_id);
  if (term)       query = query.eq('term', term);
  if (year)       query = query.eq('academic_year', year);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const reports = data.map(r => ({
    ...r,
    student_name: r.students ? `${r.students.first_name} ${r.students.last_name}` : null,
    class_name:   r.classes?.name || null,
    students: undefined, classes: undefined,
  }));

  res.json({ reports });
};

// GET /api/reports/:id
exports.getOne = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { data: report, error: rErr } = await supabase
    .from('term_reports')
    .select('*, students(first_name, last_name, dob, photo_url), classes(name)')
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .single();

  if (rErr || !report) return res.status(404).json({ error: 'Report not found.' });

  const { data: grades } = await supabase
    .from('grade_records')
    .select('*, subjects(name, code)')
    .eq('school_id', req.schoolId)
    .eq('student_id', report.student_id)
    .eq('term', report.term)
    .eq('academic_year', report.academic_year)
    .order('subjects(name)');

  res.json({
    report: {
      ...report,
      student_name: report.students ? `${report.students.first_name} ${report.students.last_name}` : null,
      class_name:   report.classes?.name || null,
      students: undefined, classes: undefined,
    },
    grades: (grades || []).map(g => ({
      subject_name: g.subjects?.name || '—',
      subject_code: g.subjects?.code || '',
      ca_score: g.ca_score,
      exam_score: g.exam_score,
      total_score: g.total_score,
      grade: g.grade,
      grade_point: g.grade_point,
      remarks: g.remarks,
    })),
  });
};

// PUT /api/reports/:id — update remarks / publish
exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { teacher_remarks, principal_remarks } = req.body;

  const { data, error } = await supabase
    .from('term_reports')
    .update({ teacher_remarks, principal_remarks, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ report: data });
};

// PUT /api/reports/:id/publish
exports.publish = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { data, error } = await supabase
    .from('term_reports')
    .update({ is_published: true, published_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ report: data });
};

// PUT /api/reports/:id/unpublish
exports.unpublish = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { data, error } = await supabase
    .from('term_reports')
    .update({ is_published: false, published_at: null })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ report: data });
};

// GET /api/reports/:id/pdf — generate HTML that browser can print as PDF
// (Uses HTML/CSS — no extra library needed; browser Print → Save as PDF)
exports.pdf = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID.' });

  const { data: report, error: rErr } = await supabase
    .from('term_reports')
    .select('*, students(first_name, last_name, dob), classes(name), schools(name, logo_url)')
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .single();

  if (rErr || !report) return res.status(404).json({ error: 'Report not found.' });

  const { data: grades } = await supabase
    .from('grade_records')
    .select('*, subjects(name, code)')
    .eq('school_id', req.schoolId)
    .eq('student_id', report.student_id)
    .eq('term', report.term)
    .eq('academic_year', report.academic_year)
    .order('subjects(name)');

  const studentName = report.students
    ? `${report.students.first_name} ${report.students.last_name}`
    : 'Student';
  const className   = report.classes?.name || '—';
  const schoolName  = report.schools?.name || 'School';
  const gradeRows   = (grades || []).map(g => `
    <tr>
      <td>${g.subjects?.name || '—'}</td>
      <td class="center">${g.ca_score ?? '—'}</td>
      <td class="center">${g.exam_score ?? '—'}</td>
      <td class="center"><strong>${g.total_score ?? '—'}</strong></td>
      <td class="center"><span class="grade grade-${(g.grade || 'F9').replace(/\d/, '')}">${g.grade || '—'}</span></td>
      <td>${g.remarks || ''}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Report Card — ${studentName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1a1a1a; padding: 30px; }
    .header { text-align: center; border-bottom: 3px solid #1e3a5f; padding-bottom: 16px; margin-bottom: 20px; }
    .header h1 { font-size: 22px; color: #1e3a5f; }
    .header p  { font-size: 13px; color: #555; margin-top: 4px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 20px; }
    .info-grid div { display: flex; gap: 8px; }
    .info-grid label { font-weight: 600; min-width: 130px; color: #1e3a5f; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th { background: #1e3a5f; color: #fff; padding: 8px 10px; text-align: left; font-size: 12px; }
    td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; }
    tr:nth-child(even) td { background: #f9fafb; }
    .center { text-align: center; }
    .grade { padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 12px; }
    .grade-A { background: #d1fae5; color: #065f46; }
    .grade-B { background: #dbeafe; color: #1e40af; }
    .grade-C { background: #fef9c3; color: #854d0e; }
    .grade-D { background: #ffedd5; color: #9a3412; }
    .grade-E { background: #ffe4e6; color: #9f1239; }
    .grade-F { background: #fee2e2; color: #7f1d1d; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .summary-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; text-align: center; }
    .summary-box .val { font-size: 20px; font-weight: 700; color: #1e3a5f; }
    .summary-box .lbl { font-size: 11px; color: #6b7280; margin-top: 2px; }
    .remarks { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
    .remark-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
    .remark-box h4 { font-size: 12px; color: #6b7280; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    .remark-box p { font-size: 13px; min-height: 36px; }
    .footer { text-align: center; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px; }
    @media print { body { padding: 15px; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${schoolName}</h1>
    <p>Student Academic Report Card</p>
    <p>${report.term} &bull; Academic Year: ${report.academic_year}</p>
  </div>

  <div class="info-grid">
    <div><label>Student Name:</label><span>${studentName}</span></div>
    <div><label>Class:</label><span>${className}</span></div>
    <div><label>Term:</label><span>${report.term}</span></div>
    <div><label>Academic Year:</label><span>${report.academic_year}</span></div>
    <div><label>Class Position:</label><span>${report.class_position ? `${report.class_position} / ${report.class_size}` : '—'}</span></div>
    <div><label>Attendance Rate:</label><span>${report.attendance_rate ?? '—'}%</span></div>
  </div>

  <div class="summary">
    <div class="summary-box"><div class="val">${report.total_subjects}</div><div class="lbl">Subjects</div></div>
    <div class="summary-box"><div class="val">${report.average_score ?? '—'}</div><div class="lbl">Average Score</div></div>
    <div class="summary-box"><div class="val">${report.aggregate_score ?? '—'}</div><div class="lbl">Aggregate</div></div>
    <div class="summary-box"><div class="val">${report.overall_grade ?? '—'}</div><div class="lbl">Overall Grade</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Subject</th>
        <th class="center">CA (30)</th>
        <th class="center">Exam (70)</th>
        <th class="center">Total (100)</th>
        <th class="center">Grade</th>
        <th>Remarks</th>
      </tr>
    </thead>
    <tbody>${gradeRows}</tbody>
  </table>

  <div class="remarks">
    <div class="remark-box">
      <h4>Class Teacher's Remarks</h4>
      <p>${report.teacher_remarks || 'No remarks added.'}</p>
    </div>
    <div class="remark-box">
      <h4>Principal's Remarks</h4>
      <p>${report.principal_remarks || 'No remarks added.'}</p>
    </div>
  </div>

  <div class="footer">
    <p>Generated by Skoolstak &bull; ${new Date().toLocaleDateString('en-GH', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    <p style="margin-top:4px;color:#d1d5db;">GRADING: A1=80-100 &bull; B2=70-79 &bull; B3=60-69 &bull; C4=55-59 &bull; C5=50-54 &bull; C6=45-49 &bull; D7=40-44 &bull; E8=35-39 &bull; F9=0-34</p>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};
