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
  fields.capacity = fields.capacity ? parseInt(fields.capacity, 10) || null : null;
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
  if ('capacity' in fields) fields.capacity = fields.capacity ? parseInt(fields.capacity, 10) || null : null;
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

/**
 * POST /api/classes/bulk-delete
 * Delete multiple classes in one request. Body: { ids: string[] }
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
    .from('classes')
    .delete({ count: 'exact' })
    .in('id', ids)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, deleted: count ?? ids.length });
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
 * Columns (match the Classes table): Class Name, Level, Class Teacher, Capacity
 * Required: Class Name. Optional: Level, Class Teacher (full name), Capacity.
 * "Students" is a computed count and is ignored if present.
 */
exports.importExcel = async (req, res) => {
  try {
    const { parseSheetRows, pick } = require('../utils/excel');
    const { createTeacherResolver } = require('../utils/importLookups');
    const { file } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    // Decode base64
    let buffer;
    if (typeof file === 'string' && file.startsWith('data:')) {
      const matches = file.match(/^data:([^;,]*);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: 'Invalid base64 format.' });
      }
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      return res.status(400).json({ error: 'File must be base64 encoded.' });
    }

    // Parse Excel
    const data = parseSheetRows(buffer);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty.' });
    }

    const results = { success: 0, failed: 0, errors: [], auto_created: [] };
    const resolveTeacher = await createTeacherResolver(req.schoolId, results.auto_created);

    // Process each row
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2; // +1 for 0-index, +1 for header row
      try {
        const className = pick(row, 'class_name', 'name', 'class');
        if (!className) {
          results.failed++;
          results.errors.push({ row: rowNum, error: 'Missing class name' });
          continue;
        }

        let teacherId = null;
        const rawTeacher = pick(row, 'class_teacher', 'teacher', 'teacher_name');
        if (rawTeacher !== undefined) {
          const found = await resolveTeacher(rawTeacher);
          if (found.error) {
            results.failed++;
            results.errors.push({ row: rowNum, error: found.error });
            continue;
          }
          teacherId = found.id;
        }

        const level = pick(row, 'level');
        const capacity = parseInt(pick(row, 'capacity'), 10);
        const classData = {
          school_id: req.schoolId,
          name: String(className).trim(),
          level: level !== undefined ? String(level).trim() : null,
          capacity: Number.isFinite(capacity) ? capacity : null,
          teacher_id: teacherId,
        };

        const { error } = await supabase
          .from('classes')
          .insert(classData);

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
      message: `Import completed. ${results.success} classes added, ${results.failed} failed.`,
      ...results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
