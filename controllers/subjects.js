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
