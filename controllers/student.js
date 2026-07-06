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
