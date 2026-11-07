// Relative "time ago" labels shared by the side panels.

export interface TimeAgoOptions {
  /** From this many days old, show a calendar date instead of "Nd ago". */
  dateAfterDays?: number;
  /** Calendar date format once `dateAfterDays` is reached. */
  formatDate?: (date: Date) => string;
  /** Read zone-less SQLite timestamps ("YYYY-MM-DD HH:MM:SS") as UTC. */
  sqliteUtc?: boolean;
}

const shortDate = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function timeAgo(iso: string, options: TimeAgoOptions = {}, now = Date.now()): string {
  const { dateAfterDays = Infinity, formatDate = shortDate, sqliteUtc = false } = options;
  const source = sqliteUtc && !iso.includes('Z') && !iso.includes('T') ? iso.replace(' ', 'T') + 'Z' : iso;
  const date = new Date(source);
  const diff = now - date.getTime();
  if (Number.isNaN(diff)) return iso;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days >= dateAfterDays) return formatDate(date);
  return `${days}d ago`;
}
