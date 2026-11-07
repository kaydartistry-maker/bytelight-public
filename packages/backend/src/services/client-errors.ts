// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What the phone says when a screen falls over.
//
// The phone had no error boundary and reported nothing, so a render error
// blacked out the whole app with no trace anywhere, and the cause had to be
// found by reading code. Now the boundary catches the fall and posts what
// broke here. One bounded line per
// report, so a crash loop cannot fill the log with megabytes of stack.

const LIMITS = { message: 500, stack: 2000, componentStack: 2000, where: 200 } as const;

function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The log line for one report, or null when the body carries nothing to say.
 *  heldBack counts the reports of the same kind a ceiling kept out before it. */
export function clientErrorLine(body: unknown, now = new Date(), heldBack = 0): string | null {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const message = bounded(b.message, LIMITS.message).trim();
  if (!message) return null;
  return JSON.stringify({
    at: now.toISOString(),
    where: bounded(b.where, LIMITS.where),
    message,
    stack: bounded(b.stack, LIMITS.stack),
    componentStack: bounded(b.componentStack, LIMITS.componentStack),
    ...(heldBack > 0 ? { heldBack } : {}),
  });
}

/**
 * Recorders that post on their own, with no fall to set them off, get a
 * ceiling here as well as on the phone, so a fault there can never fill the
 * log. Only the kinds named; a crash report or the keyboard recorder is
 * written exactly as before.
 */
export const REPORT_CEILINGS: Readonly<Record<string, { max: number; windowMs: number }>> = {
  // The Toys page's connection log: the phone sends twelve in ten minutes at most.
  'toy-connect': { max: 30, windowMs: 10 * 60_000 },
};

/** Whether a report of this kind may be written now, and how many were kept out before it. */
export function createReportCeiling(ceilings = REPORT_CEILINGS, now: () => number = () => Date.now()) {
  const written = new Map<string, number[]>();
  const heldBack = new Map<string, number>();
  return (where: unknown): { write: boolean; heldBack: number } => {
    const kind = typeof where === 'string' ? where : '';
    const ceiling = Object.prototype.hasOwnProperty.call(ceilings, kind) ? ceilings[kind] : undefined;
    if (!ceiling) return { write: true, heldBack: 0 };
    const t = now();
    const recent = (written.get(kind) ?? []).filter((at) => t - at < ceiling.windowMs);
    if (recent.length >= ceiling.max) {
      written.set(kind, recent);
      heldBack.set(kind, (heldBack.get(kind) ?? 0) + 1);
      return { write: false, heldBack: 0 };
    }
    recent.push(t);
    written.set(kind, recent);
    const held = heldBack.get(kind) ?? 0;
    heldBack.delete(kind);
    return { write: true, heldBack: held };
  };
}
