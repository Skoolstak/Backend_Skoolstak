const XLSX = require('xlsx');

// "First Name", " first_name ", "FIRST-NAME" -> "first_name"
const normalizeHeader = (h) =>
  String(h).trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * Parses the first sheet of an Excel buffer into row objects with normalized
 * header keys and trimmed string values. Fully empty rows are dropped.
 */
function parseSheetRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  return rows
    .map((row) => {
      const out = {};
      for (const [key, value] of Object.entries(row)) {
        const k = normalizeHeader(key);
        const v = typeof value === 'string' ? value.trim() : value;
        if (v === '' && out[k] !== undefined && out[k] !== '') continue;
        out[k] = v;
      }
      return out;
    })
    .filter((row) => Object.values(row).some((v) => v !== '' && v !== null && v !== undefined));
}

/**
 * Converts an Excel date cell (Date, serial number or date string) to
 * YYYY-MM-DD. Returns null for blank values and throws on unparseable ones.
 */
function toDateString(value) {
  if (value === '' || value === null || value === undefined) return null;

  let date;
  if (value instanceof Date) {
    // cellDates yields UTC-midnight-ish dates; read the UTC parts to avoid day shifts
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(Math.round((value - 25569) * 86400 * 1000));
  } else {
    date = new Date(String(value).trim());
  }

  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date "${value}"`);
  return date.toISOString().split('T')[0];
}

const normName = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

// First non-blank value among the given (already normalized) header keys.
function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
  }
  return undefined;
}

// "Ama Serwaa Mensah" -> { first: "Ama", last: "Serwaa Mensah" }
function splitFullName(full) {
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

// Builds a resolver that matches this school's teachers by full name or profile UUID.
async function loadTeacherResolver(supabase, schoolId) {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name')
    .eq('school_id', schoolId)
    .eq('role', 'teacher');
  if (error) throw new Error(error.message);

  const ids = new Set(data.map((t) => t.id));
  const byName = new Map();
  for (const t of data) {
    const key = normName(`${t.first_name || ''} ${t.last_name || ''}`);
    byName.set(key, byName.has(key) ? 'ambiguous' : t.id);
  }
  // Returns { id } or { error } with a user-facing message.
  return (raw) => {
    const t = String(raw).trim();
    const id = ids.has(t) ? t : byName.get(normName(t));
    if (id === 'ambiguous') return { error: `Teacher "${raw}" matches more than one teacher.` };
    if (!id) return { error: `Teacher "${raw}" not found. Use the teacher's full name as shown in Staff.` };
    return { id };
  };
}

module.exports = { parseSheetRows, toDateString, normName, pick, splitFullName, loadTeacherResolver };
