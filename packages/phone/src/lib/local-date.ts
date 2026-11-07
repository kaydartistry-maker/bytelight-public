// Calendar days for the Command Center, in the phone's own timezone.
// Never derive a YYYY-MM-DD from toISOString(): that is UTC, and after 8 PM in
// Eastern time it is already tomorrow — evening logs landed on the wrong day.

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD for a moment, using local calendar parts. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's local calendar date. */
export function todayYmd(): string {
  return ymd(new Date());
}

/** A YYYY-MM-DD read as local midnight (new Date('YYYY-MM-DD') is UTC midnight). */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Step a calendar date by whole days. */
export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** The Monday of the week containing this date. */
export function mondayOf(s: string): string {
  const d = parseYmd(s);
  return addDays(s, -((d.getDay() + 6) % 7));
}
