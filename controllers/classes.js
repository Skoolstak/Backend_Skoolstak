const supabase = require('../supabaseClient');
const { pickFields, isValidUUID } = require('../middleware/sanitize');

const CLASS_FIELDS = ['name', 'level', 'teacher_id', 'capacity'];

exports.list = async (req, res) => {
  const { data, error } = await supabase
    .from('classes')
    .select('*, students(count), user_profiles!teacher_id(first_name,last_name)')
    .eq('school_id', req.schoolId)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });

  const classes = data.map(c => ({
    ...c,
    student_count: Array.isArray(c.students) ? (c.students[0]?.count ?? 0) : 0,
    teacher_name:  c.user_profiles ? `${c.user_profiles.first_name} ${c.user_profiles.last_name}` : null,
    students:      undefined,
    user_profiles: undefined,
  }));

  res.json({ classes });
};

exports.create = async (req, res) => {
  const fields = pickFields(req.body, CLASS_FIELDS);
  if (!fields.name) return res.status(400).json({ error: 'name is required.' });
  if (!fields.teacher_id) fields.teacher_id = null;
  const { data, error } = await supabase
    .from('classes')
    .insert({ ...fields, school_id: req.schoolId })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ class: data });
};

exports.update = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const fields = pickFields(req.body, CLASS_FIELDS);
  if (!fields.teacher_id) fields.teacher_id = null;
  const { data, error } = await supabase
    .from('classes')
    .update(fields)
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ class: data });
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { error } = await supabase
    .from('classes')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};

exports.listStudents = async (req, res) => {
  const { data, error } = await supabase
    .from('students')
    .select('id, first_name, last_name, status')
    .eq('class_id', req.params.id)
    .eq('school_id', req.schoolId)
    .eq('status', 'active')
    .order('last_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ students: data });
};

/**
 * POST /api/classes/import-excel
 * Bulk import classes from Excel file
 * Expects base64 encoded Excel file in req.body.file
 * Required columns: name
 * Optional columns: level, capacity
 */
exports.importExcel = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { file } = req.body;

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

    // Process each row
    for (const row of data) {
      try {
        if (!row.name) {
          results.failed++;
          results.errors.push({ row, error: 'Missing name' });
          continue;
        }

        const classData = {
          school_id: req.schoolId,
          name: String(row.name).trim(),
          level: row.level ? String(row.level).trim() : null,
          capacity: row.capacity ? parseInt(row.capacity) : null,
          teacher_id: null,
        };

        const { error } = await supabase
          .from('classes')
          .insert(classData);

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
      message: `Import completed. ${results.success} classes added, ${results.failed} failed.`,
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
