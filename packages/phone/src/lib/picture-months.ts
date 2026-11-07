// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
// House pictures grouped by the month they were made, on the phone's own
// calendar, newest month first. Ported from Reverie (Tris's fork of Aerie). A picture whose date cannot be read is left
// out of the months (it is still under All) rather than filed somewhere made up.

export interface PictureMonth {
  key: string;
  label: string;
  count: number;
}

export function monthKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function labelFor(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export function monthsOf(items: { createdAt: string }[]): PictureMonth[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = monthKey(item.createdAt);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, count]) => ({ key, label: labelFor(key), count }));
}
