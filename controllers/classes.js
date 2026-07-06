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
