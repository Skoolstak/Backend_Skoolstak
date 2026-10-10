const supabase = require('../supabaseClient');
const { pickChild, parentChildren } = require('../utils/access');

const getChild = (req) => pickChild(req);

exports.children = async (req, res) => {
  const list = await parentChildren(req, 'id, first_name, last_name, classes(name)');
  res.json({ children: list.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, class_name: c.classes?.name || null })) });
};

exports.attendance = async (req, res) => {
  const child = await getChild(req);
  if (!child) return res.json({ records: [], summary: null });
  const { term, year } = req.query;

  let query = supabase.from('attendance').select('date, status, remark')
    .eq('school_id', req.schoolId).eq('student_id', child.id).order('date', { ascending: false });
  if (term) query = query.eq('term', term);
  if (year) query = query.eq('academic_year', year);

  const { data } = await query;
  const records = data || [];
  const total   = records.length;
  const present = records.filter(r=>r.status==='present').length;
  const absent  = records.filter(r=>r.status==='absent').length;
  const rate    = total>0 ? Math.round((present/total)*100) : 0;

  res.json({ records, summary: { total, present, absent, rate } });
};

exports.fees = async (req, res) => {
  const child = await getChild(req);
  if (!child) return res.json({ invoices: [], summary: null });
  const { term, year } = req.query;

  let query = supabase.from('fee_invoices').select('*, fee_types(name)')
    .eq('school_id', req.schoolId).eq('student_id', child.id).order('created_at', { ascending: false });
  if (term) query = query.eq('term', term);
  if (year) query = query.eq('academic_year', year);

  const { data } = await query;
  const invoices = (data||[]).map(i=>({ ...i, fee_type_name: i.fee_types?.name, balance: Math.max(0,Number(i.amount)-Number(i.amount_paid||0)) }));
  const summary  = {
    total_billed:      invoices.reduce((s,i)=>s+Number(i.amount),0),
    total_paid:        invoices.reduce((s,i)=>s+Number(i.amount_paid||0),0),
    total_outstanding: invoices.reduce((s,i)=>s+i.balance,0),
    invoice_count:     invoices.length,
  };

  res.json({ invoices, summary });
};
