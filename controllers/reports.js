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

  try {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="report-${report.id}.pdf"`);
    doc.pipe(res);

    doc.fontSize(18).text(schoolName, { align: 'center' });
    doc.fontSize(11).fillColor('#555').text('Student Academic Report Card', { align: 'center' });
    doc.text(`${report.term} · Academic Year: ${report.academic_year}`, { align: 'center' });
    doc.fillColor('#000').moveDown(1.5);

    doc.fontSize(11);
    doc.text(`Student Name: ${studentName}`);
    doc.text(`Class: ${className}`);
    doc.text(`Class Position: ${report.class_position ? `${report.class_position} / ${report.class_size}` : '—'}`);
    doc.text(`Attendance Rate: ${report.attendance_rate ?? '—'}%`);
    doc.moveDown();

    doc.fontSize(12).text(
      `Subjects: ${report.total_subjects ?? 0}    Average: ${report.average_score ?? '—'}    ` +
      `Aggregate: ${report.aggregate_score ?? '—'}    Overall Grade: ${report.overall_grade ?? '—'}`
    );
    doc.moveDown();

    // Grades table
    const colX = { subject: 50, ca: 260, exam: 320, total: 390, grade: 450, remarks: 500 };
    const tableTop = doc.y;
    doc.fontSize(10).fillColor('#fff');
    doc.rect(50, tableTop, 500, 20).fill('#1e3a5f');
    doc.fillColor('#fff');
    doc.text('Subject', colX.subject + 5, tableTop + 5);
    doc.text('CA', colX.ca, tableTop + 5);
    doc.text('Exam', colX.exam, tableTop + 5);
    doc.text('Total', colX.total, tableTop + 5);
    doc.text('Grade', colX.grade, tableTop + 5);
    doc.fillColor('#000');

    let y = tableTop + 20;
    for (const g of grades || []) {
      if (y > 720) { doc.addPage(); y = 50; }
      doc.fontSize(9);
      doc.text(g.subjects?.name || '—', colX.subject + 5, y + 5, { width: 200 });
      doc.text(String(g.ca_score ?? '—'), colX.ca, y + 5);
      doc.text(String(g.exam_score ?? '—'), colX.exam, y + 5);
      doc.text(String(g.total_score ?? '—'), colX.total, y + 5);
      doc.text(g.grade || '—', colX.grade, y + 5);
      doc.moveTo(50, y + 20).lineTo(550, y + 20).strokeColor('#e5e7eb').stroke();
      y += 20;
    }
    doc.y = y + 15;

    doc.fontSize(11).text('Class Teacher\'s Remarks:', 50, doc.y);
    doc.fontSize(10).text(report.teacher_remarks || 'No remarks added.', { width: 500 });
    doc.moveDown();
    doc.fontSize(11).text('Principal\'s Remarks:');
    doc.fontSize(10).text(report.principal_remarks || 'No remarks added.', { width: 500 });

    doc.fontSize(8).fillColor('#9ca3af').text(
      `Generated by Skoolstak · ${new Date().toLocaleDateString('en-GH', { year: 'numeric', month: 'long', day: 'numeric' })}`,
      50, 780, { align: 'center', width: 500 }
    );

    doc.end();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ error: 'PDF library not installed. Run: npm install pdfkit' });
    }
    console.error('Report PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
};
