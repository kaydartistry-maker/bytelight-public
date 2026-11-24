/**
 * Codex (ChatGPT) OAuth service — credentials persistence + login orchestration.
 *
 * This module is the only place that touches `data/codex-auth.json` on disk.
 * All other code goes through {@link getCodexAccessToken} or
 * {@link getCodexAuthSnapshot}.
 *
 * It also owns the in-flight login session. Because the pi-ai
 * `loginOpenAICodex` promise can take minutes (it spins up a local HTTP
 * server on port 1455 to receive the browser callback), the HTTP route that
 * starts login MUST NOT await it. Instead, we kick the promise off in the
 * background, expose `getLoginSession()` for the route to poll, and let the
 * frontend poll the status endpoint until the session resolves.
 *
 * Ported from reference implementation/main (reference implementation L13) at SHA 8d93d5f. Behavior preserved
 * verbatim including: mutex'd refresh, manual-code paste flow, late-callback
 * guard (the cancel-then-late-resolve race), session timeout GC, and the
 * "URL ready within 5s OR return what we have" return contract.
 *
 * One byte-light adaptation documented inline below: the `providers` test
 * seam replaces vi.mock-style module mocking because byte-light's test
 * runner (`tsx --test` on Node 20) does not support ES module mocking.
 *
 * `data/codex-auth.json` is on the Pre-6B-S1 sensitive-path deny-list, so
 * the Read / Grep / Glob / Bash tools refuse it. This module is the sole
 * accessor and writes the file with 0600 best-effort permissions.
 */

import { promises as fs } from 'fs';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
  type OAuthCredentials,
} from '@earendil-works/pi-ai/oauth';
import { errMessage } from '../../util/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// packages/backend/src/services/auth/codex-oauth.ts → repo root is 5 levels up.
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

/** Refresh threshold: refresh if the access token expires within this many ms. */
const REFRESH_LEADTIME_MS = 5 * 60_000;

/** Stale-login GC: a login session older than this is considered abandoned. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export type CodexLoginStatus =
  | 'idle'
  | 'awaiting_browser'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface CodexLoginSnapshot {
  status: CodexLoginStatus;
  url?: string;
  error?: string;
  startedAt?: number;
}

export interface CodexAuthSnapshot {
  loggedIn: boolean;
  expiresAt: number | null;
  refreshable: boolean;
  /**
   * Which login the house is standing on: its own (the Providers card), the
   * Codex CLI's (`codex login`), or none. Never a path, never a token.
   */
  source: 'house' | 'cli' | null;
  loginSession: CodexLoginSnapshot;
}

/** Thrown when a caller needs a token but auth is missing / unrecoverable. */
export class CodexAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthRequiredError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// byte-light adaptation — test seam for pi-ai OAuth surface.
//
// reference implementation's tests use `vi.mock('@earendil-works/pi-ai/oauth', ...)` to swap
// the OAuth surface. byte-light runs tests via `tsx --test` on Node 20,
// which does not support ES module mocking. The mutable `providers` object
// gives tests a stable reference to substitute (via `__TEST_PROVIDERS__`)
// while production code goes through `providers.X` for every pi-ai call.
//
// Behavior identical to direct import in production. Substitutable in
// tests via property assignment on the same object reference. Restored
// to original imports by `_resetForTests()`.
//
// This is the ONLY deviation from reference implementation source — all other logic
// (mutex'd refresh, late-callback guard, session timeout, manual-code
// flow) is preserved 1:1.
// ─────────────────────────────────────────────────────────────────────────

const providers = {
  loginOpenAICodex,
  refreshOpenAICodexToken,
};

/** Test seam: tests substitute these to mock pi-ai's OAuth surface. */
export const __TEST_PROVIDERS__ = providers;

// ─────────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────────

/**
 * Auth file lives next to the SQLite db by default
 * (`./data/codex-auth.json` under PROJECT_ROOT), matching the existing
 * data dir convention. Override with `CODEX_AUTH_PATH` for tests or
 * non-default deployments.
 *
 * This path is on the Pre-6B-S1 sensitive-path deny-list — the Read,
 * Grep, Glob, and Bash tools refuse it. This module is the only accessor.
 */
export function getCodexAuthPath(): string {
  if (process.env.CODEX_AUTH_PATH) {
    return resolve(process.env.CODEX_AUTH_PATH);
  }
  return resolve(PROJECT_ROOT, 'data', 'codex-auth.json');
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────

// ── The Codex CLI's login, borrowed read-only ───────────────────────────
//
// One ChatGPT account, one sign-in. A house that has run `codex login` (the
// warm chat lane needs it) should not also need the Providers card before the
// Archivist and the API lane can use Codex. So when the house has no login of
// its own, it borrows the CLI's access token.
//
// The house never refreshes the CLI's token itself: OpenAI rotates the refresh
// token on every refresh, so a refresh done here would strand the CLI's copy
// and break the chat lane. When the borrowed token is stale, the house asks
// the Codex CLI to refresh it instead (a short-lived \`codex app-server\`,
// getAuthStatus with refreshToken), so the CLI's own auth manager rotates and
// saves its own file, exactly as a second Codex window would.

/** The CLI's auth file. Override with CODEX_CLI_AUTH_PATH (tests). */
export function getCodexCliAuthPath(): string {
  if (process.env.CODEX_CLI_AUTH_PATH) return resolve(process.env.CODEX_CLI_AUTH_PATH);
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
}

interface CliToken { access: string; expires: number }

function readCliToken(): CliToken | null {
  try {
    const path = getCodexCliAuthPath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const access = parsed?.tokens?.access_token;
    if (typeof access !== 'string' || !access) return null;
    const payload = access.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims?.exp !== 'number') return null;
    return { access, expires: claims.exp * 1000 };
  } catch {
    return null;
  }
}

/** A borrowed CLI token that is still good for at least a minute. */
function liveCliToken(): CliToken | null {
  const tok = readCliToken();
  if (!tok || tok.expires - Date.now() < 60_000) return null;
  return tok;
}

function tokenExpiry(access: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof claims?.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Override for tests: (refresh) => token. */
let cliRefresher: ((refresh: boolean) => Promise<string | null>) | null = null;
export function __setCodexCliRefresherForTests(fn: typeof cliRefresher): void { cliRefresher = fn; }

/**
 * Ask the Codex CLI for its current access token, refreshing first when asked.
 * One short-lived app-server over stdio: initialize, getAuthStatus, exit.
 */
function askCodexCliForToken(refresh: boolean): Promise<string | null> {
  if (cliRefresher) return cliRefresher(refresh);
  return new Promise((resolveToken) => {
    let done = false;
    let buf = '';
    const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (tok: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* gone */ }
      resolveToken(tok);
    };
    const timer = setTimeout(() => finish(null), 20_000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'getAuthStatus', params: { includeToken: true, refreshToken: refresh } }) + '\n');
        } else if (msg.id === 2) {
          const tok = msg.result?.authToken;
          finish(typeof tok === 'string' && tok ? tok : null);
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'byte-light', version: '1.0.0' } } }) + '\n');
  });
}

let cliRefreshInFlight: Promise<CliToken | null> | null = null;

/** A live borrowed token, asking the CLI to refresh its own login if needed. */
async function freshCliToken(): Promise<CliToken | null> {
  const live = liveCliToken();
  if (live) return live;
  if (!readCliToken()) return null;
  if (cliRefreshInFlight) return cliRefreshInFlight;
  cliRefreshInFlight = (async () => {
    try {
      const access = await askCodexCliForToken(true);
      if (!access) return null;
      const expires = tokenExpiry(access);
      if (!expires || expires - Date.now() < 60_000) return null;
      console.log('[CodexAuth] Codex CLI refreshed its login for the house; new expiry', new Date(expires).toISOString());
      return { access, expires };
    } catch {
      return null;
    } finally {
      cliRefreshInFlight = null;
    }
  })();
  return cliRefreshInFlight;
}

async function readCredentials(): Promise<OAuthCredentials | null> {
  const path = getCodexAuthPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.refresh === 'string' &&
      typeof parsed?.access === 'string' &&
      typeof parsed?.expires === 'number'
    ) {
      return parsed as OAuthCredentials;
    }
    console.warn('[CodexAuth] Auth file present but malformed; treating as logged out');
    return null;
  } catch (err) {
    console.warn('[CodexAuth] Failed to read auth file:', err);
    return null;
  }
}

async function writeCredentials(creds: OAuthCredentials): Promise<void> {
  const path = getCodexAuthPath();
  await fs.mkdir(dirname(path), { recursive: true });
  // Atomic write: temp file in the SAME directory (so the rename is within
  // one filesystem and thus POSIX-atomic) + chmod-before-rename so the
  // final file always lands with 0600 perms. If the process crashes between
  // writeFile and rename, the user sees either the old file or no file —
  // never a half-written JSON blob that readCredentials would log as
  // malformed and silently treat as logged out.
  //
  // byte-light hardening vs reference implementation reference implementation source (which writes the
  // target path directly). The readCredentials malformed-file path treats
  // partial JSON as "logged out" — atomic write closes the corruption race
  // entirely instead of relying on the recovery path.
  //
  // Best-effort 0600 chmod is a no-op on Windows (NTFS ACLs differ); we
  // don't error because the alternative is forcing Windows users to manage
  // ACLs by hand, which is hostile for a hobby-deployment app.
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(creds, null, 2), { encoding: 'utf8' });
    try {
      await fs.chmod(tmpPath, 0o600);
    } catch {
      /* ignore — Windows */
    }
    await fs.rename(tmpPath, path);
  } catch (err) {
    // Cleanup the temp file on failure (best effort — if cleanup itself
    // fails, swallow because the original error is the meaningful one).
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* noop */
    }
    throw err;
  }
}

async function deleteCredentialsFile(): Promise<void> {
  const path = getCodexAuthPath();
  if (existsSync(path)) {
    await fs.unlink(path);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Refresh (with mutex)
// ─────────────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<OAuthCredentials | null> | null = null;

/**
 * Refresh the access token using the stored refresh token. Returns the new
 * credentials (already persisted) or null if refresh failed.
 *
 * Mutexed: simultaneous callers share one in-flight refresh. Without this,
 * two concurrent turns can each detect "token expiring" and each fire a
 * refresh — the second receives a "refresh token already used" error from
 * OpenAI and incorrectly concludes auth is broken.
 */
async function refreshCredentials(current: OAuthCredentials): Promise<OAuthCredentials | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const refreshed = await providers.refreshOpenAICodexToken(current.refresh);
      await writeCredentials(refreshed);
      console.log(
        '[CodexAuth] Token refreshed; new expiry',
        new Date(refreshed.expires).toISOString(),
      );
      return refreshed;
    } catch (err) {
      console.warn('[CodexAuth] Token refresh failed:', err);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API — credentials
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get credentials, refreshing if the access token is within
 * REFRESH_LEADTIME_MS of expiry. Returns null if not logged in OR if
 * refresh failed (caller should treat both as "needs auth").
 */
export async function getCodexCredentials(): Promise<OAuthCredentials | null> {
  const current = await readCredentials();
  if (!current) {
    // No house login: borrow the CLI's; the CLI refreshes its own (see above).
    const cli = await freshCliToken();
    return cli ? { access: cli.access, refresh: '', expires: cli.expires } : null;
  }

  const now = Date.now();
  if (current.expires - now > REFRESH_LEADTIME_MS) {
    return current;
  }

  // Either expired or close enough — refresh.
  return refreshCredentials(current);
}

/**
 * Convenience: get just the access token, throwing if auth is unavailable.
 * The future CodexRuntime (Step 6B-B) will use this on every turn. For
 * status checks, use {@link getCodexAuthSnapshot} instead — it never throws.
 */
export async function getCodexAccessToken(): Promise<string> {
  const creds = await getCodexCredentials();
  if (!creds) {
    throw new CodexAuthRequiredError(
      readCliToken()
        ? 'The Codex CLI login could not be refreshed. Run `codex login` again, or log in under Providers.'
        : 'Codex auth required. Log in under Providers, or run `codex login`.',
    );
  }
  return creds.access;
}

/**
 * Synchronous "is there an auth file at all" check, for warm-path display
 * code that wants to show a badge without doing I/O. Does NOT validate
 * expiry — use {@link getCodexAuthSnapshot} for that.
 */
export function isCodexLoggedIn(): boolean {
  return existsSync(getCodexAuthPath()) || readCliToken() !== null;
}

/**
 * Non-throwing snapshot for the /status route. Reads the file fresh,
 * returns loggedIn=false on any failure rather than throwing.
 *
 * Security contract (6B-C Slice 3B-0 hardening): the snapshot exposes
 * ONLY expiry metadata + the in-memory login session state. It NEVER
 * carries the credentials file path, the access token, or the refresh
 * token. The auth file path lives behind `getCodexAuthPath()` (called
 * only by this module's I/O) and is on the Pre-6B-S1 sensitive-path
 * deny-list; keeping it out of the snapshot prevents accidental
 * exposure through any /status route that passes the snapshot through.
 */
export async function getCodexAuthSnapshot(): Promise<CodexAuthSnapshot> {
  const creds = await readCredentials();
  if (creds) {
    return {
      loggedIn: true,
      expiresAt: creds.expires,
      refreshable: !!creds.refresh,
      source: 'house',
      loginSession: getLoginSession(),
    };
  }
  const cli = readCliToken();
  return {
    loggedIn: !!cli,
    expiresAt: cli?.expires ?? null,
    refreshable: false,
    source: cli ? 'cli' : null,
    loginSession: getLoginSession(),
  };
}

/** Logout: delete credentials, cancel any in-flight login. Idempotent. */
export async function logoutCodex(): Promise<void> {
  cancelLoginSession();
  await deleteCredentialsFile();
  console.log('[CodexAuth] Logged out (credentials deleted)');
}

// ─────────────────────────────────────────────────────────────────────────
// Login session (singleton)
// ─────────────────────────────────────────────────────────────────────────

interface ActiveLoginSession {
  status: CodexLoginStatus;
  url?: string;
  error?: string;
  startedAt: number;
  manualCodeResolver?: (code: string) => void;
  manualCodeRejecter?: (err: Error) => void;
  abortController: AbortController;
}

let activeLogin: ActiveLoginSession | null = null;

function gcStaleLogin(): void {
  if (!activeLogin) return;
  if (Date.now() - activeLogin.startedAt > LOGIN_TIMEOUT_MS) {
    console.warn('[CodexAuth] Stale login session (>10min); clearing');
    cancelLoginSession();
  }
}

export function getLoginSession(): CodexLoginSnapshot {
  gcStaleLogin();
  if (!activeLogin) return { status: 'idle' };
  return {
    status: activeLogin.status,
    url: activeLogin.url,
    error: activeLogin.error,
    startedAt: activeLogin.startedAt,
  };
}

/**
 * Begin the OAuth login flow. Returns once the browser URL is ready (or
 * after a short timeout if the flow fails immediately). The login promise
 * itself continues running in the background — poll {@link getLoginSession}
 * to detect completion or failure.
 *
 * Awaiting the returned promise does NOT mean login succeeded — it means
 * the URL is ready to hand to the browser. Caller should inspect the
 * returned snapshot's `status` and `url` fields.
 */
export async function startCodexLogin(): Promise<CodexLoginSnapshot> {
  // If a login is already in flight, return its current state instead of
  // racing two flows (which would both try to bind port 1455).
  if (activeLogin && activeLogin.status === 'awaiting_browser') {
    return getLoginSession();
  }
  // Stale terminal states get cleared on a fresh start.
  if (activeLogin && activeLogin.status !== 'awaiting_browser') {
    activeLogin = null;
  }

  let urlResolved: () => void = () => {
    /* assigned below */
  };
  const urlReady = new Promise<void>((resolve) => {
    urlResolved = resolve;
  });

  const manualCodePromise = new Promise<string>((resolve, reject) => {
    // We'll wire the resolver into activeLogin below so the route can fire it.
    queueMicrotask(() => {
      if (activeLogin) {
        activeLogin.manualCodeResolver = resolve;
        activeLogin.manualCodeRejecter = reject;
      }
    });
  });

  activeLogin = {
    status: 'awaiting_browser',
    startedAt: Date.now(),
    abortController: new AbortController(),
  };

  // Kick off the OAuth flow. Do NOT await — it runs until the browser
  // callback hits OR the manual code resolves OR the user gives up.
  (async () => {
    const session = activeLogin;
    if (!session) return;
    try {
      const creds = await providers.loginOpenAICodex({
        onAuth: ({ url }) => {
          session.url = url;
          urlResolved();
          console.log('[CodexAuth] OAuth URL ready:', url);
        },
        onPrompt: async () => {
          // We provide onManualCodeInput, so onPrompt is the no-browser
          // fallback path. pi-ai shouldn't call it when we've set up a
          // race, but stub it for safety.
          throw new Error(
            'Codex auth: interactive prompt is not supported in this transport',
          );
        },
        onManualCodeInput: () => manualCodePromise,
        onProgress: (msg) => console.log('[CodexAuth]', msg),
      });

      // Gate before writing: pi-ai's browser-callback path can still
      // resolve loginOpenAICodex even after we've rejected the
      // manual-code race in cancelLoginSession() — the two are
      // independent. If the session was cancelled (or superseded by a
      // newer login, or cleared by logoutCodex) while we were awaiting,
      // discard these credentials instead of recreating them. Otherwise
      // a late callback re-writes the file the user just removed,
      // violating logout's "deletes credentials" contract.
      if (activeLogin !== session || session.status !== 'awaiting_browser') {
        console.log(
          '[CodexAuth] Login resolved but session is no longer active (status:',
          session.status + ') — discarding credentials',
        );
        return;
      }
      await writeCredentials(creds);
      session.status = 'complete';
      console.log(
        '[CodexAuth] Login complete; access token expires',
        new Date(creds.expires).toISOString(),
      );
    } catch (err) {
      const message = errMessage(err);
      // If we never resolved the URL (flow failed immediately), unblock
      // the route handler so it doesn't hang.
      urlResolved();
      // If this session was cancelled, the abort path already set status.
      if (session.status !== 'cancelled') {
        session.status = 'failed';
        session.error = message;
      }
      console.warn('[CodexAuth] Login failed:', message);
    }
  })();

  // Wait up to 5s for the URL to populate so the route can return it. If
  // the OAuth flow is broken at the network level, we return whatever
  // state we have rather than hanging the request.
  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, 5000),
  );
  await Promise.race([urlReady, timeoutPromise]);

  return getLoginSession();
}

/**
 * Resolve the manual-code paste promise. Returns true if there was an
 * active session waiting for it.
 */
export function submitManualCode(code: string): boolean {
  if (!activeLogin || activeLogin.status !== 'awaiting_browser') return false;
  if (!activeLogin.manualCodeResolver) return false;
  activeLogin.manualCodeResolver(code);
  return true;
}

/** Cancel any in-flight login. Idempotent. */
export function cancelLoginSession(): void {
  if (!activeLogin) return;
  const session = activeLogin;
  session.status = 'cancelled';
  session.abortController.abort();
  // Reject the manual-code promise so the loginOpenAICodex await unblocks.
  session.manualCodeRejecter?.(new Error('Codex login cancelled'));
  activeLogin = null;
}

/** Test seam: clear all module state. Only used by unit tests. */
export function _resetForTests(): void {
  activeLogin = null;
  refreshInFlight = null;
  // Restore pi-ai providers to original imports in case a prior test
  // substituted them.
  providers.loginOpenAICodex = loginOpenAICodex;
  providers.refreshOpenAICodexToken = refreshOpenAICodexToken;
}
