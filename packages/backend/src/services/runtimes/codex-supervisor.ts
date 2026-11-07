/**
 * CodexDaemonSupervisor — Manages the Codex app-server daemon lifecycle.
 *
 * Ensures the daemon is running before connections are attempted,
 * monitors health, and restarts on failure.
 *
 * Ported whole from the Keystone fork codex-supervisor.ts.
 * BYTE-LIGHT ADAPTATION: The upstream fork pins the binary at `~/.local/bin/codex`
 * (its VPS layout). byte-light installs `codex` system-wide at
 * `/usr/bin/codex` (same root prefix as `claude`), so we resolve from
 * PATH via `codex` and let the OS locate it — with a `CODEX_BIN` env
 * override for operators who install elsewhere. See the H2 preflight
 * card (shared/preflight-h2-codex-cli-2026-07-08.md §3).
 */

import { spawn, ChildProcess } from 'child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getBytelightConfig } from '../../config.js';
import { BYTELIGHT_CODEX_SOCKET, codexAppServerArgs } from '../codex-app-server-config.js';
import { readMcpJson } from '../mcp-json.js';
import { getMcpBeltToken, MCP_BELT_TOKEN_ENV } from '../mcp-belt-auth.js';

const SOCKET_PATH = BYTELIGHT_CODEX_SOCKET;
// BYTE-LIGHT ADAPTATION (was `process.env.HOME + '/.local/bin/codex'` in the upstream
// codex-supervisor.ts:10): resolve `codex` from PATH (installed system-wide at
// /usr/bin/codex; v0.162.1 as of 2026-10-14). `spawn` searches PATH for a bare command name, so
// passing 'codex' Just Works; `CODEX_BIN` env overrides for non-standard installs.
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

export function materializeCodexSkillsDoor(agentCwd: string): void {
  const source = join(agentCwd, '.claude', 'skills');
  if (!existsSync(source)) return;

  const door = join(agentCwd, '.agents', 'skills');
  try {
    let doorStat: ReturnType<typeof lstatSync> | undefined;
    try {
      doorStat = lstatSync(door);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (doorStat) {
      if (doorStat.isSymbolicLink()) {
        const target = readlinkSync(door);
        if (resolve(dirname(door), target) === resolve(source)) return;
        console.warn(
          `[CodexSupervisor] Skills door ${door} points to ${target}; expected ${source}. Leaving it unchanged.`,
        );
      } else {
        console.warn(
          `[CodexSupervisor] Skills door ${door} already exists and is not the expected symlink. Leaving it unchanged.`,
        );
      }
      return;
    }

    mkdirSync(dirname(door), { recursive: true });
    symlinkSync(source, door, 'dir');
  } catch (err) {
    console.warn(
      `[CodexSupervisor] Could not materialize skills door at ${door}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// Fingerprint of the exact launch (binary + args, which carry the whole MCP
// table) recorded beside byte-light's private socket. A reachable daemon is
// adopted across backend/PM2 lifetimes only while the fingerprint still matches.
const LAUNCH_RECORD_PATH = `${SOCKET_PATH}.launch.json`;

export function codexLaunchFingerprint(bin: string, args: string[]): string {
  return createHash('sha256').update(JSON.stringify([bin, ...args])).digest('hex');
}

/**
 * A live daemon socket is reusable across backend process lifetimes, unless it
 * was launched with a different config (or by code that never recorded one):
 * then it is restarted so a .mcp.json or belt change actually reaches Codex.
 */
export function codexDaemonStartupAction(
  socketRunning: boolean,
  recordedFingerprint: string | null = null,
  currentFingerprint: string | null = null,
): 'reuse' | 'start' | 'restart' {
  if (!socketRunning) return 'start';
  if (currentFingerprint === null || recordedFingerprint === currentFingerprint) return 'reuse';
  return 'restart';
}

function readLaunchFingerprint(): string | null {
  try {
    return (JSON.parse(readFileSync(LAUNCH_RECORD_PATH, 'utf-8')) as { fingerprint?: string }).fingerprint ?? null;
  } catch {
    return null;
  }
}

/**
 * PIDs of byte-light's own app-server: processes whose command line names the
 * private socket. Never matches the operator's own Codex sessions.
 */
export function findOwnedDaemonPids(socketPath = SOCKET_PATH, procDir = '/proc'): number[] {
  const needle = `unix://${socketPath}`;
  const pids: number[] = [];
  let entries: string[];
  try { entries = readdirSync(procDir); } catch { return pids; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = readFileSync(join(procDir, entry, 'cmdline'), 'utf-8').split('\0');
      if (args.includes('app-server') && args.includes(needle)) pids.push(Number(entry));
    } catch { /* process exited or unreadable */ }
  }
  return pids;
}

class CodexDaemonSupervisor {
  private daemonProcess: ChildProcess | null = null;
  private starting = false;
  private startPromise: Promise<void> | null = null;

  /**
   * Check if the daemon socket exists and is recent (daemon probably running)
   */
  private isDaemonRunning(): boolean {
    try {
      if (!existsSync(SOCKET_PATH)) return false;
      const stat = statSync(SOCKET_PATH);
      // Socket exists — daemon is likely running
      return stat.isSocket();
    } catch {
      return false;
    }
  }

  /** A socket file alone can be stale after a crash; prove it accepts. */
  private async isDaemonReachable(): Promise<boolean> {
    if (!this.isDaemonRunning()) return false;
    return new Promise((resolve) => {
      const socket = createConnection(SOCKET_PATH);
      let settled = false;
      const finish = (reachable: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(reachable);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
  }

  /** The exact command this backend would launch, and its fingerprint. */
  private launchPlan(): { args: string[]; fingerprint: string } {
    const configuredPort = getBytelightConfig().server.port;
    const beltUrl = process.env.BYTELIGHT_MCP_BELT_URL || `http://127.0.0.1:${configuredPort}/mcp/belt`;
    // Same .mcp.json the Claude lane loads, so swapping runtimes keeps every hand.
    const mcpJsonServers = readMcpJson(getBytelightConfig().agent.mcp_json_path);
    const args = codexAppServerArgs(beltUrl, mcpJsonServers);
    return { args, fingerprint: codexLaunchFingerprint(CODEX_BIN, args) };
  }

  /** Stop byte-light's own daemon (SIGTERM, then SIGKILL) and clear its socket. */
  private async retireDaemon(): Promise<void> {
    const pids = findOwnedDaemonPids();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    for (let i = 0; i < 50 && await this.isDaemonReachable(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (await this.isDaemonReachable()) {
      for (const pid of findOwnedDaemonPids()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
    this.daemonProcess = null;
    this.weStartedIt = false;
  }

  /** Ensure a daemon is reachable, reusing a healthy detached process. */
  async ensureRunning(): Promise<void> {
    materializeCodexSkillsDoor(getBytelightConfig().agent.cwd);
    const socketReachable = await this.isDaemonReachable();
    const { fingerprint } = this.launchPlan();
    const action = codexDaemonStartupAction(socketReachable, readLaunchFingerprint(), fingerprint);

    // A healthy socket is the ownership hand-off. After a backend/PM2 restart,
    // in-memory `weStartedIt` is false even when this same app launched the
    // still-running detached daemon. Killing it here severs every warm Codex
    // thread precisely while the rest of the house is recovering. Per-turn
    // sandbox/approval policy is repeated by codex-daemon.ts, so reuse it —
    // unless its launch config is stale, in which case the restart is the point.
    if (action === 'restart') {
      if (this.startPromise) return this.startPromise;
      console.log('[CodexSupervisor] Daemon launch config changed (.mcp.json, belt or binary) — restarting it; warm Codex threads resume from their sidecars');
      this.startPromise = this.retireDaemon().then(() => this.startDaemon());
      try {
        await this.startPromise;
      } finally {
        this.startPromise = null;
      }
      return;
    }

    if (action === 'reuse' && !this.weStartedIt) {
      console.log('[CodexSupervisor] Adopting healthy existing daemon socket');
      return;
    }

    if (socketReachable) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startDaemon();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private weStartedIt = false;

  private async startDaemon(): Promise<void> {
    if (this.starting) return;
    this.starting = true;

    console.log('[CodexSupervisor] Starting Codex daemon...');

    // Remove only byte-light's exact private socket when it exists but no
    // process accepts connections. Never touch the user's global Codex socket.
    if (this.isDaemonRunning()) {
      try { unlinkSync(SOCKET_PATH); } catch { /* spawn will report failure */ }
    }

    return new Promise((resolve, reject) => {
      // Start byte-light's own app-server in the background on a private
      // socket. A command-local MCP table prevents unrelated Codex sessions
      // from inheriting the house belt through the user's global config.
      // --dangerously-bypass-approvals-and-sandbox is operator-approved for
      // byte-light's single-user sovereign box (see H2 preflight §6): the VM
      // may lack CAP_NET_ADMIN for bwrap network namespaces, and every turn
      // runs on the operator's own subscription — there is no hostile tenant
      // to sandbox against. The flag is a the operator-visible decision, not smuggled.
      const { args, fingerprint } = this.launchPlan();
      const startupErrors: string[] = [];
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.starting = false;
        if (error) reject(error);
        else resolve();
      };

      this.daemonProcess = spawn(CODEX_BIN, args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, [MCP_BELT_TOKEN_ENV]: getMcpBeltToken() },
      });

      this.daemonProcess.stderr?.setEncoding('utf8');
      this.daemonProcess.stderr?.on('data', (chunk: string) => {
        const clean = chunk.trim();
        if (!clean) return;
        startupErrors.push(clean);
        while (startupErrors.join('\n').length > 4_000) startupErrors.shift();
      });
      this.daemonProcess.once('error', (error) => {
        finish(new Error(`Codex app-server spawn failed: ${error.message}`));
      });
      this.daemonProcess.once('exit', (code, signal) => {
        if (settled) return;
        const detail = startupErrors.join('\n') || 'no stderr captured';
        finish(new Error(`Codex app-server exited before socket readiness (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${detail}`));
      });

      this.daemonProcess.unref();
      this.weStartedIt = true;

      // Wait for socket to appear
      let attempts = 0;
      const maxAttempts = 100; // 10 seconds; current Codex releases initialize more state before binding.

      const checkSocket = async () => {
        attempts++;
        if (await this.isDaemonReachable()) {
          console.log('[CodexSupervisor] Daemon started successfully');
          try {
            writeFileSync(LAUNCH_RECORD_PATH, JSON.stringify({ fingerprint, startedAt: new Date().toISOString() }));
          } catch (err) {
            console.warn(`[CodexSupervisor] Could not record launch fingerprint: ${err instanceof Error ? err.message : err}`);
          }
          finish();
        } else if (attempts >= maxAttempts) {
          const detail = startupErrors.join('\n');
          finish(new Error(`Daemon failed to start within timeout${detail ? `: ${detail}` : ''}`));
        } else {
          setTimeout(() => { void checkSocket(); }, 100);
        }
      };

      setTimeout(() => { void checkSocket(); }, 100);
    });
  }

  /**
   * Stop the daemon if we started it
   */
  async stop(): Promise<void> {
    // Deliberately leave the detached app-server warm across backend/PM2
    // lifetimes. The next backend adopts the private socket and the persisted
    // belt credential, preserving daemon-resident thread continuity.
    this.daemonProcess = null;
    this.weStartedIt = false;
  }
}

// Singleton instance
export const codexSupervisor = new CodexDaemonSupervisor();
