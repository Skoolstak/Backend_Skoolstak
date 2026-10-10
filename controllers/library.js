const supabase = require('../supabaseClient');
const { pickFields, isValidUUID } = require('../middleware/sanitize');
const { allowedStudentIds } = require('../utils/access');

const BOOK_FIELDS      = ['title', 'author', 'book_type', 'quantity', 'available'];
const VALID_BOOK_TYPES = ['textbook', 'storybook', 'material', 'stationery'];

/* ─ Books ─ */
exports.listBooks = async (req, res) => {
  const { data, error } = await supabase
    .from('books')
    .select('*')
    .eq('school_id', req.schoolId)
    .order('title');
  if (error) return res.status(500).json({ error: error.message });

  // 'available' can drift from reality (issue/return don't touch this column),
  // so recompute it live from quantity minus currently-active loans.
  const { data: activeLoans } = await supabase
    .from('book_loans')
    .select('book_id')
    .eq('school_id', req.schoolId)
    .is('returned_at', null);
  const loanedByBook = {};
  for (const l of activeLoans || []) loanedByBook[l.book_id] = (loanedByBook[l.book_id] || 0) + 1;

  const books = data.map(b => ({
    ...b,
    available: Math.max(0, Number(b.quantity || 0) - (loanedByBook[b.id] || 0)),
  }));

  res.json({ books });
};

exports.createBook = async (req, res) => {
  const fields = pickFields(req.body, BOOK_FIELDS);
  if (!fields.title) return res.status(400).json({ error: 'title is required.' });
  if (fields.book_type && !VALID_BOOK_TYPES.includes(fields.book_type)) {
    return res.status(400).json({ error: `book_type must be one of: ${VALID_BOOK_TYPES.join(', ')}.` });
  }
  const qty = Math.max(0, parseInt(fields.quantity, 10) || 0);
  // available defaults to quantity on creation
  const { data, error } = await supabase.from('books').insert({ ...fields, quantity: qty, available: qty, school_id: req.schoolId }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ book: data });
};

exports.updateBook = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const fields = pickFields(req.body, BOOK_FIELDS);
  if (fields.book_type && !VALID_BOOK_TYPES.includes(fields.book_type)) {
    return res.status(400).json({ error: `book_type must be one of: ${VALID_BOOK_TYPES.join(', ')}.` });
  }
  if (fields.quantity != null) fields.quantity = Math.max(0, parseInt(fields.quantity, 10) || 0);
  delete fields.available; // derived at read time, not stored via this endpoint
  const { data, error } = await supabase.from('books').update(fields).eq('id', req.params.id).eq('school_id', req.schoolId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ book: data });
};

/* ─ Delete ─ */
// Books that are currently on loan (not yet returned) are never deleted, so open loans aren't lost.
async function deleteBooks(schoolId, ids) {
  const { data: onLoan, error: loanErr } = await supabase
    .from('book_loans')
    .select('book_id')
    .eq('school_id', schoolId)
    .in('book_id', ids)
    .is('returned_at', null);
  if (loanErr) return { error: loanErr.message };

  const blockedIds = new Set((onLoan || []).map(l => l.book_id));
  const deletable = ids.filter(id => !blockedIds.has(id));

  let deleted = 0;
  if (deletable.length > 0) {
    const { error, count } = await supabase
      .from('books')
      .delete({ count: 'exact' })
      .in('id', deletable)
      .eq('school_id', schoolId);
    if (error) return { error: error.message };
    deleted = count ?? deletable.length;
  }

  let skipped = [];
  if (blockedIds.size > 0) {
    const { data: titles } = await supabase
      .from('books').select('title').in('id', [...blockedIds]).eq('school_id', schoolId);
    skipped = (titles || []).map(b => b.title);
  }
  return { deleted, skipped };
}

exports.removeBook = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const result = await deleteBooks(req.schoolId, [req.params.id]);
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.skipped.length > 0) {
    return res.status(409).json({ error: 'This item is currently on loan. Return all copies before deleting it.' });
  }
  res.json({ success: true });
};

exports.bulkRemoveBooks = async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array.' });
  }
  if (ids.length > 1000) {
    return res.status(400).json({ error: 'Cannot delete more than 1000 records at once.' });
  }
  if (!ids.every(isValidUUID)) {
    return res.status(400).json({ error: 'All ids must be valid UUIDs.' });
  }
  const result = await deleteBooks(req.schoolId, ids);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, deleted: result.deleted, skipped: result.skipped });
};

/* ─ Loans ─ */
exports.listLoans = async (req, res) => {
  const { student_id } = req.query;
  let query = supabase
    .from('book_loans')
    .select('*, books(title, author), students(first_name, last_name)')
    .eq('school_id', req.schoolId)
    .order('issued_at', { ascending: false });

  if (student_id) query = query.eq('student_id', student_id);

  // Students see only their own loans and parents only their children's
  const allowed = await allowedStudentIds(req);
  if (allowed) {
    if (allowed.length === 0) return res.json({ loans: [] });
    query = query.in('student_id', allowed);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const loans = data.map(l => ({
    ...l,
    book_title:          l.books?.title,
    book_author:         l.books?.author,
    student_first_name:  l.students?.first_name,
    student_last_name:   l.students?.last_name,
  }));

  res.json({ loans });
};

exports.issueBook = async (req, res) => {
  const { book_id, student_id, due_date } = req.body;

  if (!book_id || !isValidUUID(book_id)) {
    return res.status(400).json({ error: 'A valid book_id is required.' });
  }
  if (!student_id || !isValidUUID(student_id)) {
    return res.status(400).json({ error: 'A valid student_id is required.' });
  }

  // Check availability (scoped to this school so cross-tenant IDs can't be referenced)
  const { data: book } = await supabase.from('books').select('quantity').eq('id', book_id).eq('school_id', req.schoolId).single();
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const { data: student } = await supabase.from('students').select('id').eq('id', student_id).eq('school_id', req.schoolId).single();
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const { count: loaned } = await supabase.from('book_loans').select('*', { count:'exact', head:true }).eq('book_id', book_id).is('returned_at', null);
  if (Number(book?.quantity || 0) - Number(loaned || 0) <= 0) {
    return res.status(400).json({ error: 'No copies available.' });
  }

  const { data, error } = await supabase.from('book_loans')
    .insert({ book_id, student_id, due_date, school_id: req.schoolId, issued_at: new Date().toISOString() })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ loan: data });
};

exports.returnBook = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { data, error } = await supabase.from('book_loans')
    .update({ returned_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ loan: data });
};
