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

/* ─ Period times (school-wide) ─ */
const DEFAULT_PERIODS = [
  [1, '06:00', '06:45'], [2, '06:45', '07:30'], [3, '07:30', '08:15'], [4, '08:15', '09:00'],
  [5, '09:15', '10:00'], [6, '10:00', '10:45'], [7, '10:45', '11:30'], [8, '12:30', '13:15'],
  [9, '13:15', '14:00'], [10, '14:00', '14:45'], [11, '15:00', '18:00'],
].map(([period, start_time, end_time]) => ({ period, start_time, end_time }));
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PERIODS_SETUP_MESSAGE = 'Editable period times are not set up yet. Run migration 014_timetable_periods.sql in Supabase, then try again.';

/**
 * GET /api/timetable/periods
 * The time of each period. A school that has not saved its own times (or whose table is not
 * created yet) gets the standard times, so the timetable always displays.
 */
exports.listPeriods = async (req, res) => {
  const { data, error } = await supabase
    .from('timetable_periods')
    .select('period, start_time, end_time')
    .eq('school_id', req.schoolId);
  if (error) {
    console.error('timetable_periods read failed, using defaults:', error.message);
    return res.json({ periods: DEFAULT_PERIODS, customised: false });
  }
  const saved = new Map((data || []).map((p) => [Number(p.period), p]));
  const periods = DEFAULT_PERIODS.map((d) => (saved.has(d.period)
    ? { period: d.period, start_time: saved.get(d.period).start_time, end_time: saved.get(d.period).end_time }
    : d));
  res.json({ periods, customised: saved.size > 0 });
};

/**
 * PUT /api/timetable/periods   Body: { periods: [{ period, start_time, end_time } x 11] } (HH:MM, 24-hour)
 * Each period must end after it starts, and a period cannot start before the previous one ends.
 */
exports.savePeriods = async (req, res) => {
  const input = req.body.periods;
  if (!Array.isArray(input) || input.length !== DEFAULT_PERIODS.length) {
    return res.status(400).json({ error: `Send the times for all ${DEFAULT_PERIODS.length} periods.` });
  }

  const byPeriod = new Map();
  for (const p of input) {
    const period = parseInt(p?.period, 10);
    const start = String(p?.start_time || '').slice(0, 5);
    const end = String(p?.end_time || '').slice(0, 5);
    if (!(period >= 1 && period <= DEFAULT_PERIODS.length) || byPeriod.has(period)) {
      return res.status(400).json({ error: 'Each period from 1 to 11 must be given exactly once.' });
    }
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return res.status(400).json({ error: `Period ${period}: enter the start and end time (for example 08:15).` });
    }
    if (end <= start) {
      return res.status(400).json({ error: `Period ${period} must end after it starts.` });
    }
    byPeriod.set(period, { period, start_time: start, end_time: end });
  }
  for (let n = 2; n <= DEFAULT_PERIODS.length; n++) {
    if (byPeriod.get(n).start_time < byPeriod.get(n - 1).end_time) {
      return res.status(400).json({ error: `Period ${n} starts before period ${n - 1} ends. Adjust the times so they do not overlap.` });
    }
  }

  const rows = [...byPeriod.values()].map((p) => ({ ...p, school_id: req.schoolId }));
  const { error } = await supabase.from('timetable_periods').upsert(rows, { onConflict: 'school_id,period' });
  if (error) {
    const missing = error.code === '42P01' || error.code === 'PGRST205' || /timetable_periods/.test(error.message || '');
    return res.status(missing ? 503 : 400).json({ error: missing ? PERIODS_SETUP_MESSAGE : error.message });
  }
  res.json({ success: true, periods: [...byPeriod.values()].sort((a, b) => a.period - b.period) });
};
