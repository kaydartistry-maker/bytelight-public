// Plain-words status for the two engines on Agent -> Runtime, and the Codex
// login helpers the Providers card shares. Pure, so it is tested on its own.

export interface CodexStatus {
  loggedIn?: boolean;
  expiresAt?: number | null;
  refreshable?: boolean;
  /** 'house' = the house's own login; 'cli' = borrowing the Codex CLI's `codex login`. */
  source?: 'house' | 'cli' | null;
  loginSession?: { status?: string; url?: string | null; error?: string | null };
}

export interface CodexEngineView {
  ok: boolean;
  login: 'House login' | 'Borrowed from codex login' | 'Not signed in';
  expiresAt: number | null;
}

export function codexEngineView(s: CodexStatus | null): CodexEngineView {
  if (!s?.loggedIn) return { ok: false, login: 'Not signed in', expiresAt: null };
  return {
    ok: true,
    login: s.source === 'cli' ? 'Borrowed from codex login' : 'House login',
    expiresAt: s.expiresAt ?? null,
  };
}

/** Error line for a pasted code/address the house would not take. */
export function manualCodeError(status: number, body: { error?: string } | null): string {
  if (status === 409) return 'Nothing is waiting for a code right now. Press Log in first, then paste the address here.';
  return body?.error || 'That code did not go through. Try again.';
}

export interface ClaudeHealth {
  activeRuntimeVersion: string | null;
  installedRuntimeVersion: string | null;
  systemCcVersion: string | null;
  minRequired: { version: string; reason: string } | null;
  restartRequired: boolean;
  /** Older backends do not send it; treat missing as off. */
  cliLaneEnabled?: boolean;
}

export type Headline = 'red' | 'yellow' | 'green';

// Numeric per-component compare, mirroring the backend helper.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export interface ClaudeHealthView {
  headline: Headline;
  label: string;
  outdated: boolean;
  restartRequired: boolean;
  /** The Claude Code CLI on the box is what answers (warm subscription lane). */
  cliAnswering: boolean;
}

// Red beats yellow beats green. An SDK version the house could not read is
// only worth a yellow when nothing else is answering: with the CLI lane on and
// the CLI present, the house is fine and the card says so.
export function claudeHealthView(h: ClaudeHealth): ClaudeHealthView {
  const outdated = !!(h.activeRuntimeVersion && h.minRequired
    && compareVersions(h.activeRuntimeVersion, h.minRequired.version) < 0);
  const restartRequired = !!h.restartRequired;
  const cliAnswering = !!h.cliLaneEnabled && !!h.systemCcVersion;
  const unknown = !h.activeRuntimeVersion && !cliAnswering;
  const headline: Headline = outdated ? 'red' : (restartRequired || unknown) ? 'yellow' : 'green';
  const label = outdated ? 'Outdated'
    : restartRequired ? 'Restart required'
    : unknown ? 'Unknown'
    : cliAnswering ? `OK · Claude Code ${h.systemCcVersion} is answering`
    : 'OK';
  return { headline, label, outdated, restartRequired, cliAnswering };
}

/** "in 3 days" / "in 5 hours" / "due now" — rough on purpose. */
export function expiresIn(expiresAt: number | null, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const ms = expiresAt - now;
  if (ms <= 0) return 'due now (it happens on its own)';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'in under an hour';
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${Math.round(hours / 24)} days`;
}
