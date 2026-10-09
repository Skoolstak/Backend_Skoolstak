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

module.exports = { parseSheetRows, toDateString };
