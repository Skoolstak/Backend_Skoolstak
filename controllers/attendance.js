const supabase = require('../supabaseClient');
const { isValidUUID, capLimit, isValidDate, isSafeText } = require('../middleware/sanitize');

const VALID_STATUSES = ['present', 'absent', 'late'];

exports.list = async (req, res) => {
  const { class_id, student_id, date, term, year, limit = 50 } = req.query;

  let query = supabase
    .from('attendance')
    .select('*, students(first_name,last_name), classes(name)')
    .eq('school_id', req.schoolId)
    .order('date', { ascending: false })
    .limit(capLimit(limit, 50, 500));

  if (class_id)   query = query.eq('class_id',   class_id);
  if (student_id) query = query.eq('student_id', student_id);
  if (date)       query = query.eq('date', date);
  if (term)       query = query.eq('term', term);
  if (year)       query = query.eq('academic_year', year);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // If fetching by class+date return summary too
  let records = data.map(r => ({
    ...r,
    student_first_name: r.students?.first_name,
    student_last_name:  r.students?.last_name,
    class_name:         r.classes?.name,
  }));

  if (class_id && date) {
    const present = records.filter(r=>r.status==='present').length;
    const absent  = records.filter(r=>r.status==='absent').length;
    return res.json({ records, summary: { present, absent, total: records.length } });
  }

  // For student-scoped (student portal / parent portal): compute summary
  if (student_id && term) {
    const total   = records.length;
    const present = records.filter(r=>r.status==='present').length;
    const absent  = records.filter(r=>r.status==='absent').length;
    const rate    = total>0 ? Math.round((present/total)*100) : 0;
    return res.json({ records, summary: { total, present, absent, rate } });
  }

  res.json({ records });
};

exports.save = async (req, res) => {
  const { class_id, date, records, term = 1, academic_year } = req.body;

  if (!class_id || !isValidUUID(class_id)) {
    return res.status(400).json({ error: 'A valid class_id is required.' });
  }
  if (!date || !isValidDate(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });
  }
  // Reject dates more than 1 year in the future (prevents data pollution)
  const dateObj = new Date(date);
  if (dateObj > new Date(Date.now() + 366 * 24 * 60 * 60 * 1000)) {
    return res.status(400).json({ error: 'date cannot be more than 1 year in the future.' });
  }
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records must be a non-empty array.' });
  }
  if (records.length > 500) {
    return res.status(400).json({ error: 'Cannot submit more than 500 attendance records at once.' });
  }

  const year = academic_year || new Date().getFullYear();

  // Whitelist each record: only accept student_id, status, remark
  const rows = [];
  for (const r of records) {
    if (!r.student_id || !isValidUUID(r.student_id)) {
      return res.status(400).json({ error: `Invalid student_id in records array.` });
    }
    if (!VALID_STATUSES.includes(r.status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
    }
    // Cap remark length
    const remark = typeof r.remark === 'string' ? r.remark.slice(0, 300) : null;
    rows.push({
      school_id:     req.schoolId,
      class_id,
      student_id:    r.student_id,
      date,
      status:        r.status,
      term,
      academic_year: year,
      remark:        typeof r.remark === 'string' ? r.remark.slice(0, 255) : null,
    });
  }

  const { error } = await supabase
    .from('attendance')
    .upsert(rows, { onConflict: 'school_id,class_id,student_id,date' });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, count: rows.length });
};
