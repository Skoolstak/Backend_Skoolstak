const crypto  = require('crypto');
const supabase = require('../supabaseClient');
const { pickFields, isValidUUID, capLimit } = require('../middleware/sanitize');

const FEE_TYPE_FIELDS    = ['name', 'amount', 'frequency'];
const INVOICE_FIELDS     = ['student_id', 'fee_type_id', 'term', 'academic_year', 'due_date', 'amount', 'status'];
const PAYMENT_METHODS    = ['cash', 'mtn_momo', 'vodafone_cash', 'airteltigo_money', 'bank'];
const CASHFLOW_FIELDS    = ['type', 'category', 'amount', 'description', 'date'];
const INVOICE_STATUSES   = ['unpaid', 'partial', 'paid'];
const CASHFLOW_TYPES     = ['in', 'out'];

/* ─ Fee Types ─ */
exports.listFeeTypes = async (req, res) => {
  const { data, error } = await supabase.from('fee_types').select('*').eq('school_id', req.schoolId).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ fee_types: data });
};

exports.createFeeType = async (req, res) => {
  const fields = pickFields(req.body, FEE_TYPE_FIELDS);
  if (!fields.name || fields.amount == null) {
    return res.status(400).json({ error: 'name and amount are required.' });
  }
  const { data, error } = await supabase.from('fee_types').insert({ ...fields, school_id: req.schoolId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ fee_type: data });
};

exports.updateFeeType = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const fields = pickFields(req.body, FEE_TYPE_FIELDS);
  const { data, error } = await supabase.from('fee_types').update(fields).eq('id', req.params.id).eq('school_id', req.schoolId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ fee_type: data });
};

/* ─ Invoices ─ */
exports.listInvoices = async (req, res) => {
  const { student_id, term, year, limit = 100 } = req.query;

  let query = supabase
    .from('fee_invoices')
    .select('*, fee_types(name), students(first_name,last_name)')
    .eq('school_id', req.schoolId)
    .order('created_at', { ascending: false })
    .limit(capLimit(limit, 100, 500));

  if (student_id) query = query.eq('student_id', student_id);
  if (term)       query = query.eq('term', term);
  if (year)       query = query.eq('academic_year', year);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const invoices = data.map(inv => ({
    ...inv,
    fee_type_name: inv.fee_types?.name,
    student_name:  inv.students ? `${inv.students.first_name} ${inv.students.last_name}` : null,
    balance: Number(inv.amount) - Number(inv.amount_paid || 0),
  }));

  const summary = {
    total_billed:      invoices.reduce((s,i) => s + Number(i.amount), 0),
    total_paid:        invoices.reduce((s,i) => s + Number(i.amount_paid || 0), 0),
    total_outstanding: invoices.reduce((s,i) => s + i.balance, 0),
    invoice_count:     invoices.length,
  };

  res.json({ invoices, summary });
};

exports.createInvoice = async (req, res) => {
  const fields = pickFields(req.body, INVOICE_FIELDS);
  if (!fields.student_id || !isValidUUID(fields.student_id)) {
    return res.status(400).json({ error: 'A valid student_id is required.' });
  }
  if (!fields.fee_type_id || !isValidUUID(fields.fee_type_id)) {
    return res.status(400).json({ error: 'A valid fee_type_id is required.' });
  }
  if (fields.status && !INVOICE_STATUSES.includes(fields.status)) {
    return res.status(400).json({ error: `status must be one of: ${INVOICE_STATUSES.join(', ')}.` });
  }
  const { data, error } = await supabase.from('fee_invoices').insert({ ...fields, school_id: req.schoolId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ invoice: data });
};

/* ─ Payments ─ */
exports.listPayments = async (req, res) => {
  const { limit = 50 } = req.query;
  const { data, error } = await supabase
    .from('fee_payments')
    .select('*, fee_invoices(*, students(first_name,last_name))')
    .eq('school_id', req.schoolId)
    .order('paid_at', { ascending: false })
    .limit(capLimit(limit, 50, 500));
  if (error) return res.status(500).json({ error: error.message });

  const payments = data.map(p => ({
    ...p,
    student_name:   p.fee_invoices?.students ? `${p.fee_invoices.students.first_name} ${p.fee_invoices.students.last_name}` : null,
    payment_method: p.method, // map DB column name to client-expected field
  }));

  res.json({ payments });
};

exports.recordPayment = async (req, res) => {
  const { invoice_id, amount, payment_method, reference } = req.body;

  if (!invoice_id || !isValidUUID(invoice_id)) {
    return res.status(400).json({ error: 'A valid invoice_id is required.' });
  }
  if (!payment_method || !PAYMENT_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}.` });
  }
  if (!reference || !reference.trim()) {
    return res.status(400).json({ error: 'A receipt reference or uploaded receipt URL is required to confirm payment.' });
  }
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  // 1. Record payment
  const { data: payment, error } = await supabase.from('fee_payments')
    .insert({ invoice_id, amount, method: payment_method, reference, school_id: req.schoolId, paid_at: new Date().toISOString() })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });

  // 2. Update invoice amount_paid and derive status
  const { data: inv } = await supabase.from('fee_invoices').select('amount, amount_paid').eq('id', invoice_id).single();
  const newPaid   = Number(inv?.amount_paid || 0) + Number(amount);
  const total     = Number(inv?.amount || 0);
  const newStatus = newPaid >= total ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';
  await supabase.from('fee_invoices').update({ amount_paid: newPaid, status: newStatus }).eq('id', invoice_id);

  res.status(201).json({ payment });
};

// Convenience endpoint: POST /finance/invoices/:id/pay
exports.payInvoice = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid invoice ID.' });
  // accept either 'payment_method' or legacy 'method' field from the client
  req.body = {
    invoice_id:     req.params.id,
    amount:         req.body.amount,
    payment_method: req.body.payment_method || req.body.method,
    reference:      req.body.reference,
  };
  return exports.recordPayment(req, res);
};

/* ─ Cash Flow ─ */
exports.listCashFlow = async (req, res) => {
  const { type, from_date, to_date } = req.query;
  let query = supabase.from('cash_flow').select('*').eq('school_id', req.schoolId).order('date', { ascending: false });
  if (type)      query = query.eq('type', type);
  if (from_date) query = query.gte('date', from_date);
  if (to_date)   query = query.lte('date', to_date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data });
};

exports.createCashFlow = async (req, res) => {
  const fields = pickFields(req.body, CASHFLOW_FIELDS);
  if (!fields.type || !CASHFLOW_TYPES.includes(fields.type)) {
    return res.status(400).json({ error: `type must be one of: ${CASHFLOW_TYPES.join(', ')}.` });
  }
  if (!fields.amount || isNaN(parseFloat(fields.amount))) {
    return res.status(400).json({ error: 'amount is required and must be a number.' });
  }
  const { data, error } = await supabase.from('cash_flow')
    .insert({ ...fields, school_id: req.schoolId })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ entry: data });
};

exports.deleteCashFlow = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { error } = await supabase.from('cash_flow').delete().eq('id', req.params.id).eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};

/* ─ Paystack ─ */
exports.initiatePaystackPayment = async (req, res) => {
  const { invoice_id } = req.body;
  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payment gateway not configured.' });

  const { data: inv } = await supabase.from('fee_invoices')
    .select('*, students(email), fee_types(name)')
    .eq('id', invoice_id)
    .single();
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

  const balance = Number(inv.amount) - Number(inv.amount_paid || 0);
  if (balance <= 0) return res.status(400).json({ error: 'Invoice already paid.' });

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:     inv.students?.email || 'unknown@school.gh',
      amount:    Math.round(balance * 100),   // Paystack uses kobo/pesewas
      currency:  'GHS',
      reference: `INV-${invoice_id}-${Date.now()}`,
      metadata:  { invoice_id },
    }),
  });
  const result = await response.json();
  if (!result.status) return res.status(400).json({ error: result.message });
  res.json({ authorization_url: result.data.authorization_url, reference: result.data.reference });
};

exports.paystackWebhook = async (req, res) => {
  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET) return res.status(503).end();

  const signature = req.headers['x-paystack-signature'];
  // req.body is a raw Buffer here (express.raw), which is what HMAC must sign
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(rawBody).digest('hex');
  if (hash !== signature) return res.status(401).end();

  const payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody.toString('utf8')) : req.body;
  const { event, data } = payload;
  if (event === 'charge.success') {
    const { invoice_id } = data.metadata || {};
    if (invoice_id) {
      const amount = data.amount / 100;
      const { data: inv } = await supabase.from('fee_invoices').select('amount, amount_paid, school_id').eq('id', invoice_id).single();
      if (inv) {
        const newPaid = Number(inv.amount_paid || 0) + Number(amount);
        const newStatus = newPaid >= Number(inv.amount) ? 'paid' : 'partial';
        await supabase.from('fee_invoices').update({ amount_paid: newPaid, status: newStatus }).eq('id', invoice_id);
        await supabase.from('fee_payments').insert({
          invoice_id, amount, method: 'paystack',
          reference: data.reference, school_id: inv.school_id, paid_at: new Date().toISOString(),
        });
      }
    }
  }
  res.sendStatus(200);
};

/**
 * GET /api/finance/invoice/:id/pdf
 * Generate PDF invoice
 * Install: npm install pdfkit
 */
exports.generateInvoicePDF = async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { id } = req.params;

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid invoice ID.' });
    }

    // Fetch invoice with related data
    const { data: invoice, error } = await supabase
      .from('fee_invoices')
      .select(`
        *,
        fee_types(name),
        students(first_name, last_name, student_id),
        schools!inner(name, slug)
      `)
      .eq('id', id)
      .eq('school_id', req.schoolId)
      .single();

    if (error || !invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 50 });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.id}.pdf"`);
    
    // Pipe to response
    doc.pipe(res);

    // Header
    doc.fontSize(20).text(invoice.schools.name, { align: 'center' });
    doc.fontSize(10).text('FEE INVOICE', { align: 'center' });
    doc.moveDown();

    // Invoice details
    doc.fontSize(12).text(`Invoice ID: ${invoice.id}`, 50, 150);
    doc.text(`Date: ${new Date(invoice.created_at).toLocaleDateString()}`);
    doc.text(`Term: ${invoice.term}`);
    doc.text(`Academic Year: ${invoice.academic_year || 'N/A'}`);
    doc.text(`Due Date: ${invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : 'N/A'}`);
    doc.moveDown();

    // Student details
    doc.fontSize(12).text('Billed To:');
    doc.fontSize(10).text(`Student: ${invoice.students.first_name} ${invoice.students.last_name}`);
    doc.text(`Student ID: ${invoice.students.student_id}`);
    doc.moveDown(2);

    // Table header
    doc.fontSize(12).text('Description', 50, 280);
    doc.text('Amount (₵)', 400, 280);
    doc.moveTo(50, 295).lineTo(550, 295).stroke();

    // Fee details
    doc.fontSize(10).text(invoice.fee_types.name, 50, 305);
    doc.text(Number(invoice.amount).toFixed(2), 400, 305);
    doc.moveDown(2);

    // Totals
    const amountPaid = Number(invoice.amount_paid || 0);
    const balance = Number(invoice.amount) - amountPaid;

    doc.moveTo(50, 340).lineTo(550, 340).stroke();
    doc.fontSize(12).text('Total Amount:', 350, 350);
    doc.text(`₵${Number(invoice.amount).toFixed(2)}`, 450, 350);
    doc.text('Amount Paid:', 350, 370);
    doc.text(`₵${amountPaid.toFixed(2)}`, 450, 370);
    doc.text('Balance Due:', 350, 390);
    doc.fontSize(14).text(`₵${balance.toFixed(2)}`, 450, 390);

    // Status
    doc.fontSize(10);
    const statusY = 420;
    doc.text(`Status: ${invoice.status.toUpperCase()}`, 50, statusY);

    // Footer
    doc.fontSize(8).text('Thank you for your payment.', 50, 700, { align: 'center' });

    doc.end();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ 
        error: 'PDF library not installed. Run: npm install pdfkit' 
      });
    }
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
};

/**
 * GET /api/finance/receipt/:paymentId/pdf
 * Generate PDF receipt
 * Install: npm install pdfkit
 */
exports.generateReceiptPDF = async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { paymentId } = req.params;

    if (!isValidUUID(paymentId)) {
      return res.status(400).json({ error: 'Invalid payment ID.' });
    }

    // Fetch payment with related data
    const { data: payment, error } = await supabase
      .from('fee_payments')
      .select(`
        *,
        fee_invoices(
          term,
          academic_year,
          fee_types(name),
          students(first_name, last_name, student_id)
        ),
        schools!inner(name, slug)
      `)
      .eq('id', paymentId)
      .eq('school_id', req.schoolId)
      .single();

    if (error || !payment) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 50 });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${payment.receipt_number}.pdf"`);
    
    // Pipe to response
    doc.pipe(res);

    // Header
    doc.fontSize(20).text(payment.schools.name, { align: 'center' });
    doc.fontSize(10).text('PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown();

    // Receipt details
    doc.fontSize(12).text(`Receipt No: ${payment.receipt_number}`, 50, 150);
    doc.text(`Date: ${new Date(payment.paid_at).toLocaleDateString()}`);
    doc.text(`Payment Method: ${payment.method.replace('_', ' ').toUpperCase()}`);
    doc.text(`Reference: ${payment.reference || 'N/A'}`);
    doc.moveDown();

    // Student details
    const student = payment.fee_invoices.students;
    doc.fontSize(12).text('Received From:');
    doc.fontSize(10).text(`Student: ${student.first_name} ${student.last_name}`);
    doc.text(`Student ID: ${student.student_id}`);
    doc.moveDown(2);

    // Payment details
    doc.fontSize(12).text('Payment Details:');
    doc.fontSize(10).text(`Fee Type: ${payment.fee_invoices.fee_types.name}`);
    doc.text(`Term: ${payment.fee_invoices.term}`);
    doc.text(`Academic Year: ${payment.fee_invoices.academic_year || 'N/A'}`);
    doc.moveDown(2);

    // Amount box
    doc.rect(50, 340, 500, 60).stroke();
    doc.fontSize(14).text('Amount Paid:', 60, 360);
    doc.fontSize(20).text(`₵${Number(payment.amount).toFixed(2)}`, 350, 355);

    // Footer
    doc.fontSize(8).text('This is an official receipt. Please keep for your records.', 50, 700, { align: 'center' });
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, { align: 'center' });

    doc.end();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ 
        error: 'PDF library not installed. Run: npm install pdfkit' 
      });
    }
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
};
