const supabase = require('../supabaseClient');
const { pickFields, isValidUUID } = require('../middleware/sanitize');

const TIMETABLE_FIELDS = ['class_id', 'day', 'period', 'subject', 'teacher_id', 'room'];
const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

exports.list = async (req, res) => {
  const { class_id } = req.query;
  let query = supabase
    .from('timetable_slots')
    .select('*, classes(name), user_profiles!teacher_id(first_name,last_name)')
    .eq('school_id', req.schoolId)
    .order('period');

  if (class_id) query = query.eq('class_id', class_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const slots = data.map(s => ({
    ...s,
    subject_name: s.subject, // alias for client compatibility
    class_name:   s.classes?.name,
    teacher_name: s.user_profiles ? `${s.user_profiles.first_name} ${s.user_profiles.last_name}` : null,
  }));

  res.json({ slots });
};

exports.upsert = async (req, res) => {
  const fields = pickFields(req.body, TIMETABLE_FIELDS);
  if (fields.day && !VALID_DAYS.includes(fields.day)) {
    return res.status(400).json({ error: `day must be one of: ${VALID_DAYS.join(', ')}.` });
  }
  if (fields.period != null) {
    fields.period = parseInt(fields.period, 10);
    if (isNaN(fields.period) || fields.period < 1 || fields.period > 11) {
      return res.status(400).json({ error: 'period must be between 1 and 11.' });
    }
  }
  if (!fields.teacher_id) fields.teacher_id = null;
  const payload = { ...fields, school_id: req.schoolId };
  const { data, error } = await supabase
    .from('timetable_slots')
    .upsert(payload, { onConflict: 'school_id,class_id,day,period' })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ slot: data });
};

exports.remove = async (req, res) => {
  if (!isValidUUID(req.params.id)) return res.status(400).json({ error: 'Invalid ID format.' });
  const { error } = await supabase
    .from('timetable_slots')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', req.schoolId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
};
