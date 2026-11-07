// Shared utilities for Command Center pages

export const CC_API = '/api/cc';

// Today's calendar date in the device's own timezone. (A getTimezone() that
// fetched /api/cc/config here never used the answer and was never called, so
// the browser's zone was always the one in force; the React Command Center
// does the same through lib/local-date.ts.)
export function todayStr(): string {
  return new Date().toLocaleDateString('en-CA');
}

export function formatCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function dayLabel(dateStr: string): { name: string; num: string } {
  const d = new Date(dateStr);
  return {
    name: d.toLocaleDateString('en-GB', { weekday: 'short' }),
    num: String(d.getDate()),
  };
}

export function daysLabel(d: number): string {
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return `${d} days`;
}

export function isToday(dateStr: string): boolean {
  return dateStr === todayStr();
}

export function shortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
