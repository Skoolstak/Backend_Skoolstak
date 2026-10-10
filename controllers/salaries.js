'use strict';
const supabase = require('../supabaseClient');
const { isValidUUID } = require('../middleware/sanitize');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const ROLE_LABELS = { teacher: 'Teacher', school_admin: 'School Admin' };
const MAX_SALARY = 9999999999; // NUMERIC(12,2) limit

const SETUP_MESSAGE = 'Salary records are not set up yet. Run migration 012_staff_salaries.sql in Supabase, then try again.';
const isMissingTable = (err) => !!err && (
  err.code === '42P01' || err.code === 'PGRST205' ||
  (/staff_salaries/.test(err.message || '') && /does not exist|schema cache/.test(err.message || ''))
);
const fail = (res, err) => (
  isMissingTable(err)
    ? res.status(503).json({ error: SETUP_MESSAGE })
    : res.status(500).json({ error: err.message })
);

const currentMonth = () => new Date().toISOString().slice(0, 7);
const monthLabel = (month) => {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
};
const formatDate = (d) => {
  const iso = d.toISOString().slice(0, 10).split('-');
  return `${iso[2]}/${iso[1]}/${iso[0]}`;
};
const money = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * GET /api/finance/salaries
 * Every staff member in this school with their monthly salary (null when not set yet).
 */
exports.listSalaries = async (req, res) => {
  const { data: staff, error } = await supabase
    .from('staff')
    .select('id, staff_id, designation, department, user_profiles!user_profile_id(first_name, last_name, role)')
    .eq('school_id', req.schoolId)
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });

  const { data: salaries, error: salaryErr } = await supabase
    .from('staff_salaries')
    .select('staff_id, amount')
    .eq('school_id', req.schoolId);
  if (salaryErr) return fail(res, salaryErr);

  const amountByStaff = new Map((salaries || []).map((s) => [s.staff_id, Number(s.amount)]));
  const rows = (staff || [])
    .map((s) => ({
      id:          s.id,
      staff_id:    s.staff_id || '',
      first_name:  s.user_profiles?.first_name || '',
      last_name:   s.user_profiles?.last_name || '',
      role:        s.user_profiles?.role || '',
      designation: s.designation || '',
      department:  s.department || '',
      salary:      amountByStaff.has(s.id) ? amountByStaff.get(s.id) : null,
    }))
    .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));

  res.json({ staff: rows });
};

/**
 * PUT /api/finance/salaries/:id   (id = staff.id)
 * Body: { amount } — a blank amount removes the salary.
 */
exports.setSalary = async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format.' });

  const { data: staffRow } = await supabase
    .from('staff').select('id').eq('id', id).eq('school_id', req.schoolId).maybeSingle();
  if (!staffRow) return res.status(404).json({ error: 'Staff member not found.' });

  const raw = req.body.amount;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    const { error } = await supabase.from('staff_salaries').delete().eq('staff_id', id).eq('school_id', req.schoolId);
    if (error) return fail(res, error);
    return res.json({ success: true, salary: null });
  }

  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_SALARY) {
    return res.status(400).json({ error: 'Salary must be a number of 0 or more.' });
  }
  const rounded = Math.round(amount * 100) / 100;

  const { error } = await supabase
    .from('staff_salaries')
    .upsert({ staff_id: id, school_id: req.schoolId, amount: rounded, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' });
  if (error) return fail(res, error);

  res.json({ success: true, salary: rounded });
};

/**
 * GET /api/finance/salary-notice/:id/pdf?month=YYYY-MM   (id = staff.id)
 * Printable salary notice for one staff member and month.
 */
exports.generateSalaryNoticePDF = async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format.' });

    const month = req.query.month || currentMonth();
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must look like 2026-10.' });

    const { data: staff } = await supabase
      .from('staff')
      .select('id, staff_id, designation, department, user_profiles!user_profile_id(first_name, last_name, role)')
      .eq('id', id)
      .eq('school_id', req.schoolId)
      .maybeSingle();
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    const { data: salary, error: salaryErr } = await supabase
      .from('staff_salaries').select('amount').eq('staff_id', id).eq('school_id', req.schoolId).maybeSingle();
    if (salaryErr) return fail(res, salaryErr);
    if (!salary) return res.status(404).json({ error: 'No salary has been set for this staff member yet.' });

    const { data: school } = await supabase.from('schools').select('name').eq('id', req.schoolId).maybeSingle();

    const profile = staff.user_profiles || {};
    const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
    const reference = `SAL-${staff.staff_id || id.slice(0, 8)}-${month.replace('-', '')}`;
    const period = monthLabel(month);
    const amount = Number(salary.amount);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${reference.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`);
    doc.pipe(res);

    const left = 50;
    const right = 545;

    // Header
    doc.fontSize(20).text(school?.name || 'School', left, 50, { width: right - left, align: 'center' });
    doc.fontSize(11).text('SALARY NOTICE', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();

    // Notice details
    let y = doc.y + 18;
    doc.fontSize(10);
    doc.text(`Reference: ${reference}`, left, y);
    doc.text(`Pay period: ${period}`, left, y + 16);
    doc.text(`Date issued: ${formatDate(new Date())}`, left, y + 32);

    // Staff details
    y += 70;
    doc.fontSize(12).text('Issued To:', left, y);
    doc.fontSize(10);
    doc.text(`Name: ${fullName}`, left, y + 20);
    doc.text(`Staff ID: ${staff.staff_id || 'N/A'}`, left, y + 36);
    doc.text(`Role: ${ROLE_LABELS[profile.role] || profile.role || 'N/A'}`, left, y + 52);
    doc.text(`Designation: ${staff.designation || 'N/A'}`, left, y + 68);
    doc.text(`Department: ${staff.department || 'N/A'}`, left, y + 84);

    // Salary table
    y += 125;
    doc.fontSize(12).text('Description', left, y);
    doc.text('Amount (GHS)', 400, y, { width: right - 400, align: 'right' });
    doc.moveTo(left, y + 18).lineTo(right, y + 18).stroke();
    doc.fontSize(10).text(`Monthly salary - ${period}`, left, y + 28);
    doc.text(money(amount), 400, y + 28, { width: right - 400, align: 'right' });

    doc.moveTo(left, y + 52).lineTo(right, y + 52).stroke();
    doc.fontSize(12).text('Net Pay:', 330, y + 64);
    doc.fontSize(14).text(`GHS ${money(amount)}`, 400, y + 62, { width: right - 400, align: 'right' });

    // Signatures
    const signY = y + 160;
    doc.moveTo(left, signY).lineTo(left + 200, signY).stroke();
    doc.moveTo(right - 200, signY).lineTo(right, signY).stroke();
    doc.fontSize(9).text('Authorised by', left, signY + 6);
    doc.text('Received by', right - 200, signY + 6);

    doc.fontSize(8).text('This notice confirms the monthly salary payable for the pay period shown.', left, 740, { width: right - left, align: 'center' });

    doc.end();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ error: 'PDF library not installed. Run: npm install pdfkit' });
    }
    console.error('Salary notice PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate salary notice.' });
  }
};
