const supabase = require('../supabaseClient');

exports.myClasses = async (req, res) => {
  const teacherProfileId = req.profile?.id; // classes.teacher_id references user_profiles.id

  let query = supabase
    .from('classes')
    .select('id, name, room, students(count), timetable_slots(subject)')
    .eq('school_id', req.schoolId)
    .eq('teacher_id', teacherProfileId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const classes = data.map(c => ({
    id:            c.id,
    name:          c.name,
    room:          c.room,
    student_count: c.students?.[0]?.count || 0,
    subject:       c.timetable_slots?.[0]?.subject || '—',
  }));

  res.json({ classes });
};
