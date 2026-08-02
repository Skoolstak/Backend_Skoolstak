const supabase = require('../supabaseClient');
const { pickFields, isValidUUID } = require('../middleware/sanitize');

const STUDENT_FIELDS = ['first_name', 'last_name', 'dob', 'class_id', 'parent_id', 'photo_url', 'status'];
const VALID_STATUSES = ['active', 'graduated', 'withdrawn'];

exports.list = async (req, res) => {
  const schoolId = req.schoolId;
  const { search, class_id, status } = req.query;

  let query = supabase
    .from('students')
    .select('*, classes(name)')
    .eq('school_id', schoolId)
    .order('last_name');

  if (search) {
    const safe = search.replace(/[%_\\]/g, '\\$&').slice(0, 100);
    query = query.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
  }
  if (class_id) query = query.eq('class_id', class_id);
  if (status)   query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const students = (data || []).map(s => ({
    ...s,
    class_name: s.classes?.name || null,
    classes:    undefined,
  }));

  res.json({ students });
};

exports.create = async (req, res) => {
  const fields = pickFields(req.body, STUDENT_FIELDS);
  if (!fields.first_name || !fields.last_name) {
    return res.status(400).json({ error: 'first_name and last_name are required.' });
  }
  if (fields.status && !VALID_STATUSES.includes(fields.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
  }
  if (!fields.class_id)  fields.class_id  = null;
  if (!fields.parent_id) fields.parent_id = null;
  const { data, error } = await supabase
    .from('students')
    .insert({ ...fields, school_id: req.schoolId })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ student: data });
};

exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const fields = pickFields(req.body, STUDENT_FIELDS);
  if (fields.status && !VALID_STATUSES.includes(fields.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}.` });
  }
  if (!fields.class_id)  fields.class_id  = null;
  if (!fields.parent_id) fields.parent_id = null;
  const { data, error } = await supabase
    .from('students')
    .update(fields)
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ student: data });
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { error } = await supabase
    .from('students')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};

/**
 * POST /api/students/import-excel
 * Bulk import students from Excel file
 * Expects base64 encoded Excel file in req.body.file
 * Install: npm install xlsx
 */
exports.importExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { file, class_id } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    // Decode base64
    let buffer;
    if (typeof file === 'string' && file.startsWith('data:')) {
      const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid base64 format.' });
      }
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      return res.status(400).json({ error: 'File must be base64 encoded.' });
    }

    // Parse Excel
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty.' });
    }

    const results = { success: 0, failed: 0, errors: [] };

    // Expected columns: first_name, last_name, dob (optional), gender (optional)
    for (const row of data) {
      try {
        if (!row.first_name || !row.last_name) {
          results.failed++;
          results.errors.push({ row, error: 'Missing first_name or last_name' });
          continue;
        }

        const studentData = {
          school_id: req.schoolId,
          first_name: String(row.first_name).trim(),
          last_name: String(row.last_name).trim(),
          dob: row.dob ? new Date(row.dob).toISOString().split('T')[0] : null,
          class_id: class_id || null,
          status: 'active',
        };

        const { error } = await supabase
          .from('students')
          .insert(studentData);

        if (error) {
          results.failed++;
          results.errors.push({ row, error: error.message });
        } else {
          results.success++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ row, error: err.message });
      }
    }

    res.json({
      message: `Import completed. ${results.success} students added, ${results.failed} failed.`,
      ...results,
    });
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return res.status(500).json({ 
        error: 'Excel library not installed. Run: npm install xlsx' 
      });
    }
    console.error('Excel import error:', err);
    res.status(500).json({ error: 'Failed to process Excel file.' });
  }
};
