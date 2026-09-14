const supabase = require('../supabaseClient');
const { pickFields, isValidUUID } = require('../middleware/sanitize');

const SUBJECT_FIELDS = ['name', 'code', 'class_id', 'teacher_id', 'is_active'];

exports.list = async (req, res) => {
  const { class_id } = req.query;
  let query = supabase
    .from('subjects')
    .select('*, classes(name), user_profiles!teacher_id(first_name,last_name)')
    .eq('school_id', req.schoolId)
    .order('name');

  if (class_id) query = query.eq('class_id', class_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const subjects = data.map(s => ({
    ...s,
    class_name:   s.classes?.name || null,
    teacher_name: s.user_profiles ? `${s.user_profiles.first_name} ${s.user_profiles.last_name}` : null,
    classes:      undefined,
    user_profiles: undefined,
  }));

  res.json({ subjects });
};

exports.create = async (req, res) => {
  const fields = pickFields(req.body, SUBJECT_FIELDS);
  if (!fields.name)     return res.status(400).json({ error: 'name is required.' });
  if (!fields.class_id) return res.status(400).json({ error: 'class_id is required.' });
  if (!fields.teacher_id) fields.teacher_id = null;

  const { data, error } = await supabase
    .from('subjects')
    .insert({ ...fields, school_id: req.schoolId })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ subject: data });
};

exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  const fields = pickFields(req.body, SUBJECT_FIELDS);
  if (!fields.teacher_id) fields.teacher_id = null;

  const { data, error } = await supabase
    .from('subjects')
    .update(fields)
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ subject: data });
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });

  const { error } = await supabase
    .from('subjects')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};

/**
 * POST /api/subjects/bulk-delete
 * Delete multiple subjects in one request. Body: { ids: string[] }
 */
exports.bulkRemove = async (req, res) => {
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
  const { error, count } = await supabase
    .from('subjects')
    .delete({ count: 'exact' })
    .in('id', ids)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, deleted: count ?? ids.length });
};

/**
 * POST /api/subjects/import-excel
 * Bulk import subjects from Excel file
 * Expects base64 encoded Excel file in req.body.file
 * Required columns: name, class_id
 * Optional columns: code, is_active
 * If class_id provided in request body, it will be used for all subjects
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
      const matches = file.match(/^data:([^;,]+);base64,(.+)$/);
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

    // Process each row
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2; // +1 for 0-index, +1 for header row
      try {
        if (!row.name) {
          results.failed++;
          results.errors.push({ row: rowNum, error: 'Missing name' });
          continue;
        }

        // Use class_id from request body if provided, otherwise from row
        const subjectClassId = class_id || row.class_id;
        
        if (!subjectClassId) {
          results.failed++;
          results.errors.push({ row: rowNum, error: 'Missing class_id' });
          continue;
        }

        const subjectData = {
          school_id: req.schoolId,
          name: String(row.name).trim(),
          code: row.code ? String(row.code).trim() : null,
          class_id: subjectClassId,
          teacher_id: null,
          is_active: row.is_active !== undefined ? Boolean(row.is_active) : true,
        };

        const { error } = await supabase
          .from('subjects')
          .insert(subjectData);

        if (error) {
          results.failed++;
          results.errors.push({ row: rowNum, error: error.message });
        } else {
          results.success++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ row: rowNum, error: err.message });
      }
    }

    res.json({
      message: `Import completed. ${results.success} subjects added, ${results.failed} failed.`,
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
