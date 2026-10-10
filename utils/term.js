// Ghana school calendar: Term 1 = Sep-Dec, Term 2 = Jan-Apr, Term 3 = May-Aug.
// The academic year is named after the year it starts in (Jan 2027 belongs to 2026/2027 -> "2026").
function termOf(date = new Date()) {
  const d = typeof date === 'string' ? new Date(`${date}T12:00:00`) : date;
  const m = d.getMonth() + 1;
  const term = m >= 9 ? 1 : m <= 4 ? 2 : 3;
  const year = m >= 9 ? d.getFullYear() : d.getFullYear() - 1;
  return { term: String(term), year: String(year) };
}

module.exports = { termOf };
