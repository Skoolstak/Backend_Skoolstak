'use strict';
const supabase = require('../supabaseClient');
const { isValidUUID } = require('../middleware/sanitize');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const ROLE_LABELS = { teacher: 'Teacher', school_admin: 'School Admin' };
const KIND_LABELS = { allowance: 'Allowance', bonus: 'Bonus', deduction: 'Deduction' };
const MAX_AMOUNT = 9999999999; // NUMERIC(12,2) limit

const SETUP_MESSAGE = 'Salary records are not set up yet. Run migration 013_staff_salary_pay.sql in Supabase, then try again.';
const isMissingTable = (err) => !!err
  && (err.code === '42P01' || err.code === 'PGRST205'
    || (/staff_salary_history|staff_pay_adjustments/.test(err.message || '') && /does not exist|schema cache/.test(err.message || '')));
const fail = (res, err) => (
  isMissingTable(err)
    ? res.status(503).json({ error: SETUP_MESSAGE })
    : res.status(500).json({ error: err.message })
);

const currentMonth = () => new Date().toISOString().slice(0, 7);
const monthLabel = (m) => `${MONTH_NAMES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const formatDate = (d) => {
  const [y, mo, da] = d.toISOString().slice(0, 10).split('-');
  return `${da}/${mo}/${y}`;
};
const money = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ghs = (n) => `GHS ${money(n)}`; // Ghana cedis; PDF fonts have no cedi symbol, so the code is printed
const r2 = (n) => Math.round(n * 100) / 100;

function parseAmount(raw) {
  const n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return r2(n);
}

/**
 * Pay for one month, from the salary history and the allowances / bonuses / deductions.
 *  - basic: the latest salary whose effective month is on or before `month`
 *  - an adjustment applies when start_month <= month and (end_month is empty or >= month)
 */
function calcPay(history, adjustments, month) {
  let basicEntry = null;
  for (const h of history) {
    if (h.effective_month <= month && (!basicEntry || h.effective_month > basicEntry.effective_month)) basicEntry = h;
  }
  const active = adjustments.filter((a) => a.start_month <= month && (!a.end_month || a.end_month >= month));
  const earnings = active.filter((a) => a.kind !== 'deduction');
  const deductions = active.filter((a) => a.kind === 'deduction');
  const sum = (rows) => r2(rows.reduce((s, a) => s + Number(a.amount), 0));

  const basic = basicEntry ? Number(basicEntry.amount) : null;
  const totalEarnings = sum(earnings);
  const totalDeductions = sum(deductions);
  const gross = basic === null ? null : r2(basic + totalEarnings);
  const net = gross === null ? null : r2(gross - totalDeductions);
  return { basicEntry, basic, earnings, deductions, totalEarnings, totalDeductions, gross, net };
}

async function findStaff(schoolId, id, select = 'id') {
  const { data } = await supabase.from('staff').select(select).eq('id', id).eq('school_id', schoolId).maybeSingle();
  return data || null;
}

/**
 * Every staff member in the school with their pay for one month (null pay when no salary applies yet).
 * Shared by the salary table and the bank payroll list so they always agree.
 * Returns { rows } or { error }.
 */
async function loadMonthRows(schoolId, month) {
  const { data: staff, error } = await supabase
    .from('staff')
    .select('id, staff_id, designation, department, user_profiles!user_profile_id(first_name, last_name, role)')
    .eq('school_id', schoolId)
    .limit(2000);
  if (error) return { error };

  const { data: history, error: historyErr } = await supabase
    .from('staff_salary_history').select('staff_id, amount, effective_month').eq('school_id', schoolId);
  if (historyErr) return { error: historyErr };
  const { data: adjustments, error: adjErr } = await supabase
    .from('staff_pay_adjustments').select('staff_id, kind, amount, start_month, end_month').eq('school_id', schoolId);
  if (adjErr) return { error: adjErr };

  const group = (rows) => {
    const map = new Map();
    for (const r of rows || []) { if (!map.has(r.staff_id)) map.set(r.staff_id, []); map.get(r.staff_id).push(r); }
    return map;
  };
  const historyBy = group(history);
  const adjustmentsBy = group(adjustments);

  const rows = (staff || []).map((s) => {
    const pay = calcPay(historyBy.get(s.id) || [], adjustmentsBy.get(s.id) || [], month);
    return {
      id:               s.id,
      staff_id:         s.staff_id || '',
      first_name:       s.user_profiles?.first_name || '',
      last_name:        s.user_profiles?.last_name || '',
      role:             s.user_profiles?.role || '',
      designation:      s.designation || '',
      basic:            pay.basic,
      allowances_total: pay.totalEarnings,
      deductions_total: pay.totalDeductions,
      net:              pay.net,
    };
  }).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));

  return { rows };
}

/**
 * GET /api/finance/salaries?month=YYYY-MM
 * Every staff member with their pay for the month (null pay when no salary applies yet).
 */
exports.listSalaries = async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must look like 2026-10.' });

  const result = await loadMonthRows(req.schoolId, month);
  if (result.error) return fail(res, result.error);
  res.json({ month, staff: result.rows });
};

/**
 * GET /api/finance/payroll-list/pdf?month=YYYY-MM
 * Printable payroll list for the bank: every staff member with a salary that month, with basic
 * salary and net pay (basic + allowances and bonuses - deductions), and the totals.
 */
exports.generatePayrollListPDF = async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const month = req.query.month || currentMonth();
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must look like 2026-10.' });

    const result = await loadMonthRows(req.schoolId, month);
    if (result.error) return fail(res, result.error);
    const people = result.rows.filter((r) => r.basic !== null);
    if (people.length === 0) {
      return res.status(404).json({ error: `No staff have a salary for ${monthLabel(month)} yet.` });
    }

    const { data: school } = await supabase.from('schools').select('name').eq('id', req.schoolId).maybeSingle();
    const totalBasic = r2(people.reduce((s, p) => s + p.basic, 0));
    const totalNet = r2(people.reduce((s, p) => s + p.net, 0));
    const period = monthLabel(month);

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payroll-list-${month}.pdf"`);
    doc.pipe(res);

    const left = 50;
    const right = 545;
    const cols = { no: 50, id: 80, name: 172, basic: 345, net: 445 };
    let y;

    const header = () => {
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('No.', cols.no, y, { width: 26 });
      doc.text('Staff ID', cols.id, y, { width: 90 });
      doc.text('Name', cols.name, y, { width: 165 });
      doc.text('Basic Salary (GHS)', cols.basic, y, { width: 95, align: 'right' });
      doc.text('Net Pay (GHS)', cols.net, y, { width: 100, align: 'right' });
      doc.font('Helvetica');
      y += 16;
      doc.moveTo(left, y).lineTo(right, y).stroke();
      y += 6;
    };

    doc.fontSize(20).text(school?.name || 'School', left, 50, { width: right - left, align: 'center' });
    doc.fontSize(11).text('STAFF PAYROLL LIST', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    y = doc.y + 14;
    doc.fontSize(10);
    doc.text(`Pay period: ${period}`, left, y);
    doc.text(`Date issued: ${formatDate(new Date())}`, left, y + 15);
    doc.text(`Number of staff: ${people.length}`, 330, y, { width: right - 330, align: 'right' });
    y += 42;
    header();

    people.forEach((p, i) => {
      if (y > 735) { doc.addPage(); y = 60; header(); }
      doc.fontSize(10);
      doc.text(String(i + 1), cols.no, y, { width: 26 });
      doc.text(p.staff_id || '—', cols.id, y, { width: 90, lineBreak: false });
      doc.text(`${p.first_name} ${p.last_name}`.trim(), cols.name, y, { width: 165, height: 12, ellipsis: true });
      doc.text(money(p.basic), cols.basic, y, { width: 95, align: 'right' });
      doc.text(money(p.net), cols.net, y, { width: 100, align: 'right' });
      y += 18;
    });

    if (y > 700) { doc.addPage(); y = 60; }
    doc.moveTo(left, y).lineTo(right, y).stroke();
    y += 8;
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text(`TOTAL (${people.length} staff)`, cols.no, y, { width: 290 });
    doc.text(money(totalBasic), cols.basic, y, { width: 95, align: 'right' });
    doc.text(money(totalNet), cols.net, y, { width: 100, align: 'right' });
    doc.font('Helvetica');
    y += 22;
    doc.fontSize(8).fillColor('#555555');
    doc.text('Net pay = basic salary + allowances and bonuses - deductions for the month.', left, y, { width: right - left });
    doc.fillColor('#000000');
    y += 36;

    if (y > 720) { doc.addPage(); y = 60; }
    doc.moveTo(left, y).lineTo(left + 200, y).stroke();
    doc.moveTo(right - 200, y).lineTo(right, y).stroke();
    doc.fontSize(9).text('Prepared by', left, y + 6);
    doc.text('Approved by', right - 200, y + 6);

    // Page numbers once the page count is known
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).text(`Page ${i + 1} of ${range.count}`, left, 770, { width: right - left, align: 'center', lineBreak: false });
    }

    doc.end();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ error: 'PDF library not installed. Run: npm install pdfkit' });
    }
    console.error('Payroll list PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate the payroll list.' });
  }
};

/**
 * GET /api/finance/salaries/:id   (id = staff.id)
 * Full pay record for one person: salary history and every allowance / bonus / deduction.
 */
exports.getStaffPay = async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format.' });
  if (!(await findStaff(req.schoolId, id))) return res.status(404).json({ error: 'Staff member not found.' });

  const { data: history, error: historyErr } = await supabase
    .from('staff_salary_history')
    .select('id, amount, effective_month, reason')
    .eq('staff_id', id).eq('school_id', req.schoolId);
  if (historyErr) return fail(res, historyErr);
  const { data: adjustments, error: adjErr } = await supabase
    .from('staff_pay_adjustments')
    .select('id, kind, label, amount, start_month, end_month')
    .eq('staff_id', id).eq('school_id', req.schoolId);
  if (adjErr) return fail(res, adjErr);

  res.json({
    history:     (history || []).map((h) => ({ ...h, amount: Number(h.amount) })).sort((a, b) => b.effective_month.localeCompare(a.effective_month)),
    adjustments: (adjustments || []).map((a) => ({ ...a, amount: Number(a.amount) })).sort((a, b) => b.start_month.localeCompare(a.start_month)),
  });
};

/**
 * POST /api/finance/salaries/:id/history   Body: { amount, effective_month, reason? }
 * Records a new basic salary from a month onward (a raise, or a cut). Setting the same month again replaces it.
 */
exports.addSalaryRevision = async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format.' });
  if (!(await findStaff(req.schoolId, id))) return res.status(404).json({ error: 'Staff member not found.' });

  const amount = parseAmount(req.body.amount);
  if (amount === null) return res.status(400).json({ error: 'Salary must be a number greater than 0.' });
  const month = req.body.effective_month;
  if (!MONTH_RE.test(month || '')) return res.status(400).json({ error: 'Choose the month this salary starts (e.g. 2026-10).' });
  const reason = String(req.body.reason || '').trim().slice(0, 200) || null;

  const { error } = await supabase
    .from('staff_salary_history')
    .upsert({ school_id: req.schoolId, staff_id: id, amount, effective_month: month, reason }, { onConflict: 'staff_id,effective_month' });
  if (error) return fail(res, error);
  res.status(201).json({ success: true });
};

/** DELETE /api/finance/salaries/history/:historyId */
exports.deleteSalaryRevision = async (req, res) => {
  if (!isValidUUID(req.params.historyId)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { error } = await supabase
    .from('staff_salary_history').delete().eq('id', req.params.historyId).eq('school_id', req.schoolId);
  if (error) return fail(res, error);
  res.json({ success: true });
};

/**
 * POST /api/finance/salaries/:id/adjustments
 * Body: { kind: 'allowance'|'bonus'|'deduction', label, amount, start_month, end_month? }
 * end_month empty = repeats every month until stopped. For a one-off, send end_month = start_month.
 */
exports.addAdjustment = async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format.' });
  if (!(await findStaff(req.schoolId, id))) return res.status(404).json({ error: 'Staff member not found.' });

  const { kind } = req.body;
  if (!KIND_LABELS[kind]) return res.status(400).json({ error: 'Type must be Allowance, Bonus or Deduction.' });
  const label = String(req.body.label || '').trim().slice(0, 100);
  if (!label) return res.status(400).json({ error: 'Give it a name, e.g. Transport allowance.' });
  const amount = parseAmount(req.body.amount);
  if (amount === null) return res.status(400).json({ error: 'Amount must be a number greater than 0.' });
  const start = req.body.start_month;
  if (!MONTH_RE.test(start || '')) return res.status(400).json({ error: 'Choose the month it starts (e.g. 2026-10).' });
  const end = req.body.end_month ? req.body.end_month : null;
  if (end !== null && !MONTH_RE.test(end)) return res.status(400).json({ error: 'The end month is not valid.' });
  if (end !== null && end < start) return res.status(400).json({ error: 'The end month cannot be before the start month.' });

  const { error } = await supabase
    .from('staff_pay_adjustments')
    .insert({ school_id: req.schoolId, staff_id: id, kind, label, amount, start_month: start, end_month: end });
  if (error) return fail(res, error);
  res.status(201).json({ success: true });
};

/**
 * PUT /api/finance/salaries/adjustments/:adjId   Body: { end_month }
 * Stops (or re-opens, with an empty end_month) an allowance, bonus or deduction. Earlier months are unchanged.
 */
exports.updateAdjustmentEnd = async (req, res) => {
  const { adjId } = req.params;
  if (!isValidUUID(adjId)) return res.status(400).json({ error: 'Invalid ID format.' });

  const { data: adj } = await supabase
    .from('staff_pay_adjustments').select('id, start_month').eq('id', adjId).eq('school_id', req.schoolId).maybeSingle();
  if (!adj) return res.status(404).json({ error: 'Not found.' });

  const end = req.body.end_month ? req.body.end_month : null;
  if (end !== null && !MONTH_RE.test(end)) return res.status(400).json({ error: 'The end month is not valid.' });
  if (end !== null && end < adj.start_month) return res.status(400).json({ error: 'The end month cannot be before the start month.' });

  const { error } = await supabase
    .from('staff_pay_adjustments').update({ end_month: end }).eq('id', adjId).eq('school_id', req.schoolId);
  if (error) return fail(res, error);
  res.json({ success: true });
};

/** DELETE /api/finance/salaries/adjustments/:adjId */
exports.deleteAdjustment = async (req, res) => {
  if (!isValidUUID(req.params.adjId)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { error } = await supabase
    .from('staff_pay_adjustments').delete().eq('id', req.params.adjId).eq('school_id', req.schoolId);
  if (error) return fail(res, error);
  res.json({ success: true });
};

/**
 * GET /api/finance/salary-notice/:id/pdf?month=YYYY-MM   (id = staff.id)
 * Printable salary notice: basic salary, allowances / bonuses, gross, deductions, net pay.
 */
exports.generateSalaryNoticePDF = async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid ID format.' });

    const month = req.query.month || currentMonth();
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must look like 2026-10.' });

    const staff = await findStaff(
      req.schoolId, id,
      'id, staff_id, designation, department, user_profiles!user_profile_id(first_name, last_name, role)',
    );
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    const { data: history, error: historyErr } = await supabase
      .from('staff_salary_history').select('amount, effective_month, reason').eq('staff_id', id).eq('school_id', req.schoolId);
    if (historyErr) return fail(res, historyErr);
    const { data: adjustments, error: adjErr } = await supabase
      .from('staff_pay_adjustments').select('kind, label, amount, start_month, end_month').eq('staff_id', id).eq('school_id', req.schoolId);
    if (adjErr) return fail(res, adjErr);

    const pay = calcPay(history || [], adjustments || [], month);
    if (pay.basic === null) {
      return res.status(404).json({ error: `No salary applies to ${monthLabel(month)} yet. Set a salary that starts on or before that month.` });
    }

    // Note a salary change that takes effect in this very month
    const sorted = [...(history || [])].sort((a, b) => a.effective_month.localeCompare(b.effective_month));
    const revisionIdx = sorted.findIndex((h) => h.effective_month === month);
    const revision = revisionIdx > 0 ? { from: Number(sorted[revisionIdx - 1].amount), to: Number(sorted[revisionIdx].amount), reason: sorted[revisionIdx].reason } : null;

    const { data: school } = await supabase.from('schools').select('name').eq('id', req.schoolId).maybeSingle();
    const profile = staff.user_profiles || {};
    const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
    const reference = `SAL-${staff.staff_id || id.slice(0, 8)}-${month.replace('-', '')}`;
    const period = monthLabel(month);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${reference.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`);
    doc.pipe(res);

    const left = 50;
    const right = 545;
    const amountX = 400;

    // Header
    doc.fontSize(20).text(school?.name || 'School', left, 50, { width: right - left, align: 'center' });
    doc.fontSize(11).text('SALARY NOTICE', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();

    let y = doc.y + 18;
    doc.fontSize(10);
    doc.text(`Reference: ${reference}`, left, y);
    doc.text(`Pay period: ${period}`, left, y + 16);
    doc.text(`Date issued: ${formatDate(new Date())}`, left, y + 32);

    y += 70;
    doc.fontSize(12).text('Issued To:', left, y);
    doc.fontSize(10);
    doc.text(`Name: ${fullName}`, left, y + 20);
    doc.text(`Staff ID: ${staff.staff_id || 'N/A'}`, left, y + 36);
    doc.text(`Role: ${ROLE_LABELS[profile.role] || profile.role || 'N/A'}`, left, y + 52);
    doc.text(`Designation: ${staff.designation || 'N/A'}`, left, y + 68);
    doc.text(`Department: ${staff.department || 'N/A'}`, left, y + 84);

    // Pay table. Rows are laid out top to bottom; a new page starts if the table runs long.
    y += 124;
    const ensureRoom = (h) => { if (y + h > 740) { doc.addPage(); y = 60; } };
    const heading = (text) => { ensureRoom(40); doc.fontSize(10).font('Helvetica-Bold').text(text, left, y); doc.font('Helvetica'); y += 16; };
    const row = (label, value, opts = {}) => {
      ensureRoom(18);
      doc.fontSize(opts.size || 10).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, left + (opts.indent || 0), y, { width: amountX - left - 10 - (opts.indent || 0) });
      doc.text(value, amountX, y, { width: right - amountX, align: 'right' });
      doc.font('Helvetica');
      y += opts.gap || 16;
    };
    const rule = () => { ensureRoom(8); doc.moveTo(left, y).lineTo(right, y).stroke(); y += 8; };

    doc.fontSize(12).text('Description', left, y);
    doc.text('Amount (GHS)', amountX, y, { width: right - amountX, align: 'right' });
    y += 18;
    rule();

    row(`Basic salary - ${period}`, ghs(pay.basic), { bold: true, gap: revision ? 14 : 20 });
    if (revision) {
      doc.fontSize(8).fillColor('#555555');
      doc.text(`Salary revised this month: ${ghs(revision.from)} to ${ghs(revision.to)}${revision.reason ? ` (${revision.reason})` : ''}`, left + 12, y, { width: right - left - 12 });
      doc.fillColor('#000000');
      y += 18;
    }

    if (pay.earnings.length > 0) {
      heading('Allowances and bonuses');
      for (const a of pay.earnings) row(`${a.label} (${KIND_LABELS[a.kind]})`, ghs(a.amount), { indent: 12 });
      row('Total allowances and bonuses', ghs(pay.totalEarnings), { bold: true, gap: 20 });
    }

    rule();
    row('Gross pay', ghs(pay.gross), { bold: true, gap: 20 });

    if (pay.deductions.length > 0) {
      heading('Deductions');
      for (const d of pay.deductions) row(d.label, `-${ghs(d.amount)}`, { indent: 12 });
      row('Total deductions', `-${ghs(pay.totalDeductions)}`, { bold: true, gap: 20 });
    }

    rule();
    row('Net Pay', ghs(pay.net), { bold: true, size: 13, gap: 36 });

    // Signatures
    ensureRoom(70);
    y += 30;
    doc.moveTo(left, y).lineTo(left + 200, y).stroke();
    doc.moveTo(right - 200, y).lineTo(right, y).stroke();
    doc.fontSize(9).text('Authorised by', left, y + 6);
    doc.text('Received by', right - 200, y + 6);

    doc.fontSize(8).text('This notice confirms the pay for the period shown.', left, 770, { width: right - left, align: 'center', lineBreak: false });

    doc.end();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ error: 'PDF library not installed. Run: npm install pdfkit' });
    }
    console.error('Salary notice PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate salary notice.' });
  }
};

exports._calcPay = calcPay; // exported for tests
