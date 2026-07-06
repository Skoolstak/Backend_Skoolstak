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
