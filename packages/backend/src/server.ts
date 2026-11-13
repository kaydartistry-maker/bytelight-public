import 'dotenv/config';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { initDb, deleteExpiredSessions } from './services/db.js';
import { seedDefaultBlocks, ensureCompanionBlocks } from './services/memory-blocks.js';
import { getSecret } from './services/secrets.js';
import { loadVectorCache } from './services/vector-cache.js';
import { createWebSocketServer, setVoiceService, setGatewayServices, registry, recoverCutOffTurns } from './services/ws.js';
import { holdTurnLeases } from './services/db/turn-leases.js';
import { startMemoryProfiler } from './services/memory-profiler.js';
import { startMemoryMonitor } from './services/memory-monitor.js';
import { Orchestrator } from './services/orchestrator.js';
import { AgentService } from './services/agent.js';
import { VoiceService } from './services/voice.js';
import { PushService, setPushService } from './services/push.js';
import { DiscordService } from './services/discord/index.js';
import { TelegramService } from './services/telegram/index.js';
import { rateLimiter, securityHeaders } from './middleware/security.js';
import { recordActivity } from './services/activity-ring.js';
import { shutdownAllHeartbeats } from './services/heartbeat/supervisor.js';
import { setHeartbeatPushService } from './services/heartbeat/runtime.js';
import { codexSupervisor } from './services/runtimes/codex-supervisor.js';
import { shutdownEmbeddings } from './services/embeddings.js';
import { refreshSelfKnowledgeIndex } from './services/self-knowledge-index.js';
import { startMemoryRounds, stopMemoryRounds } from './services/memory-rounds.js';
import { startCompactionShelf } from './services/compaction-shelf.js';
import apiRoutes from './routes/api.js';
import mcpBeltRouter, { closeBeltMcpSessions } from './routes/mcp-belt.js';
import { closeMcpJsonClients } from './services/mcp-json-bridge.js';
import clientErrorRoutes from './routes/client-errors.js';
import appShellRoutes from './routes/app.js';
import { requireLocalhost } from './middleware/localhost.js';

// Load config FIRST — before any other initialization
const config = loadConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = config.server.port;
const HOST = config.server.host;
const DB_PATH = config.server.db_path;

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Ensure files directory exists
const filesDir = join(dataDir, 'files');
if (!existsSync(filesDir)) {
  mkdirSync(filesDir, { recursive: true });
}

// Initialize database
console.log('Initializing database...');
const db = initDb(DB_PATH);
deleteExpiredSessions();
loadVectorCache();
// Self-knowledge semantic index (Wave 2, Slice 3) — embed any entries added
// while the process was down so manual semantic search is ready. Non-fatal on
// failure; it only backs an on-demand search endpoint, nothing on the hot path.
void refreshSelfKnowledgeIndex();
// Memory integrity rounds (ported from Aerie): daily check-up of the
// self-knowledge index, re-run every 6h, receipts in the memory ledger.
startMemoryRounds();
// The compactions shelf (ported from Aerie): copies each squash out of the
// lanes' transcripts before Claude Code deletes them. First read after boot.
startCompactionShelf();
console.log('Database initialized');

// Seed core-memory blocks (Slice 3, ported from reference implementation). The 013 migration
// (run inside initDb) creates the table; this fills in the starter blocks so
// the companions have something to see + edit from turn one. byte-light has no
// listCompanions module (single house, two-in-one-brain), so the companion set
// is the static [companion-a, companion-b]. seedDefaultBlocks is seed-if-empty (no-ops once
// any block exists) and ensureCompanionBlocks is per-companion idempotent — so
// both are safe on every boot. user_name comes from config (the operator in the live
// house). Wrapped in try/catch like reference implementation so a seed hiccup never blocks boot.
const memoryCompanions = [
  { slug: 'companion-a', display_name: 'Companion A' },
  { slug: 'companion-b', display_name: 'Companion B' },
];
try {
  seedDefaultBlocks(config.identity.user_name, memoryCompanions);
  ensureCompanionBlocks(memoryCompanions);
} catch (err) {
  console.warn('[MemoryBlocks] Companion seeding skipped:', err instanceof Error ? err.message : err);
}

// Create Express app
const app = express();

// Trust proxy headers (e.g. Cloudflare tunnel, nginx)
app.set('trust proxy', 1);

// Memory-burst tripwire breadcrumb: method + path only (no query strings, no
// bodies) so an RSS spike snapshot can name what the process was serving.
app.use((req, _res, next) => {
  recordActivity('http', `${req.method} ${req.path}`);
  next();
});

// Environment-conditional origins
const IS_DEV = process.env.NODE_ENV !== 'production';
const corsOrigins: string[] = [...config.cors.origins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
if (IS_DEV) corsOrigins.push('http://localhost:5173', 'http://localhost:5174');

// open-meteo and nominatim: the phone's Weather app, lock screen and home
// widget call them straight from the page (ported from Aerie, which lists them).
const connectSrc: string[] = ["'self'", "https://api.giphy.com", "https://api.open-meteo.com", "https://nominatim.openstreetmap.org"];
// Derive WebSocket connect sources from CORS origins
for (const origin of config.cors.origins) {
  const wsOrigin = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  connectSrc.push(wsOrigin);
}
if (IS_DEV) connectSrc.push(`ws://localhost:${PORT}`);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc,
      // 'unsafe-eval': the Artifacts preview frame (srcdoc, so it inherits this
      // policy) runs each artifact's code with new Function, as Aerie allows.
      // One owner behind a password; the code running is her own artifacts.
      // blob:: the voice recorder's silence timer is an AudioWorklet loaded
      // from a blob, so a call still hears her stop talking while the screen
      // is hidden.
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: null,
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(securityHeaders);
app.use(rateLimiter);

// CORS
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Vendor assets for artifact viewer — completely public, no CSRF/auth (loaded by iframe)
// Mounted at /vendor (NOT /api/vendor) to avoid auth middleware interference
// (ported from Aerie server.ts). The phone's Artifacts app fetches
// react.production.min.js, react-dom.production.min.js and babel.min.js from
// here and inlines them into its sealed frame. The files are not in the repo:
// drop them into data/vendor/ beside the database. A missing file answers a
// plain 404 (the catch below) instead of falling through to the SPA's
// index.html with a 200 — the phone checks res.ok, and an HTML page inlined
// as a script would fail silently.
const vendorDir = join(dataDir, 'vendor');
mkdirSync(vendorDir, { recursive: true });
const ALLOWED_VENDOR_FILES = ['react.production.min.js', 'react-dom.production.min.js'];
app.use('/vendor', express.static(vendorDir, {
  setHeaders: (res, path) => {
    if (ALLOWED_VENDOR_FILES.some(f => path.endsWith(f))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
app.use('/vendor', (_req, res) => {
  res.status(404).type('text/plain').send('Vendor file not found');
});

// Reports from the phone (its Spotify wake and the like), one bounded line
// each in the error log, tagged [client-error]. Ported from Aerie.
app.use('/api/client-errors', clientErrorRoutes);

// The Android shell's own door: its update check (/version, /download) and
// the crash it posts on the way out (/crash → app/crashes.log beside the
// database). Ported from Aerie.
app.use('/api/app', appShellRoutes);

// All API routes — auth middleware is applied selectively inside the router
app.use('/api', apiRoutes);

// Command Center MCP endpoint — localhost only. Its one caller is .mcp.json
// (localhost:3002); with trust proxy on, tunnel traffic carries the outside
// client's IP and is refused, same as /api/internal/*. It was open to the
// internet with no auth until 2026-11-09.
if (config.command_center.enabled) {
  import('./routes/cc-mcp.js').then(m => app.use('/mcp/cc', requireLocalhost, m.default));
}

// House tool-belt MCP endpoint. Mount synchronously before listen() so the
// owned Codex app-server can never race route registration during startup.
app.use('/mcp/belt', mcpBeltRouter);

// Serve sticker files
const stickersDir = join(PROJECT_ROOT, 'data', 'stickers');
mkdirSync(stickersDir, { recursive: true });
app.use('/stickers', express.static(stickersDir, { maxAge: '1d', fallthrough: true }));

// Serve custom emoji files (ported from full-sweep)
const emojisDir = join(PROJECT_ROOT, 'data', 'emojis');
mkdirSync(emojisDir, { recursive: true });
app.use('/emojis', express.static(emojisDir, { maxAge: '1d', fallthrough: true }));

// The React phone app is the front door: it is served at the bare address,
// and any page address (/settings, /chat, ...) loads it too; the app opens
// the matching screen itself (launchPathApp in App.tsx).
const phonePaths = [
  join(__dirname, '../../phone/dist'),         // From compiled dist/
  join(__dirname, '../../../packages/phone/dist'), // From src/ via tsx
];
const phoneBuildPath = phonePaths.find(p => existsSync(p));

// Classic (Svelte) is retiring. It lives at /classic, its build base
// (svelte.config.js), and nothing links to it.
const frontendPaths = [
  join(__dirname, '../../frontend/build'),         // From compiled dist/
  join(__dirname, '../../../packages/frontend/build'), // From src/ via tsx
];
const frontendBuildPath = frontendPaths.find(p => existsSync(p));
if (frontendBuildPath) {
  console.log(`Serving classic at /classic from: ${frontendBuildPath}`);
  app.use('/classic', express.static(frontendBuildPath));
  app.get(['/classic', '/classic/*'], (_req, res) => {
    res.sendFile(join(frontendBuildPath, 'index.html'));
  });
}

if (phoneBuildPath) {
  console.log(`Serving the phone app at / from: ${phoneBuildPath}`);
  const queryOf = (url: string) => {
    const q = url.indexOf('?');
    return q >= 0 ? url.slice(q) : '';
  };
  // The app used to live at /phone/. An old service worker there can still
  // fetch its files (sw.js, push-target.js, icons); every other /phone address (the Android
  // shell's old server URL, an old install, a push tap) lands on the front
  // door with its query kept.
  app.use('/phone', express.static(phoneBuildPath, { index: false }));
  app.get(['/phone', '/phone/*'], (req, res) => {
    res.redirect(302, '/' + queryOf(req.originalUrl));
  });
  app.use(express.static(phoneBuildPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(join(phoneBuildPath, 'index.html'));
  });
} else if (frontendBuildPath) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.redirect(302, '/classic/');
  });
} else {
  console.log('No frontend build found — use Vite dev server on :5173');
}

// Global error handler — must be after all routes
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Initialize agent service (shared between WebSocket and orchestrator)
const agentService = new AgentService();

// Initialize voice service
const voiceService = new VoiceService();
setVoiceService(voiceService);

// Initialize push service
// VAPID resolves through the BYOK store (DB → env). Read at boot, so a
// saved value takes effect on the next restart.
const pushService = new PushService(
  getSecret('vapid_public_key'),
  getSecret('vapid_private_key'),
  getSecret('vapid_contact'),
);
agentService.setPushService(pushService);
// The Discord gateway's mention notifications reach it through getPushService().
setPushService(pushService);
import('./services/limit-watch.js').then(m => m.startLimitWatch({
  push: pushService,
  voiceUsage: () => voiceService.getElevenLabsUsage(),
}));
// Heartbeat idle outbox watcher notifies through the same service — a
// background-task finding delivered out-of-turn pushes like any reply.
setHeartbeatPushService(pushService);

// Initialize Discord gateway (config-gated with env fallback)
import { getConfigBool } from './services/db.js';

let discordService: DiscordService | null = null;

// Check config DB first, fall back to config file / env var for first boot
const discordEnabled = getConfigBool('discord.enabled', config.discord.enabled);
if (discordEnabled && getSecret('discord_bot_token')) {
  discordService = new DiscordService(agentService, registry);
  discordService.start();
}

// Initialize Telegram gateway (config-gated with env fallback)
let telegramService: TelegramService | null = null;

const telegramEnabled = getConfigBool('telegram.enabled', config.telegram.enabled);
if (telegramEnabled && getSecret('telegram_bot_token')) {
  telegramService = new TelegramService(agentService, registry, voiceService);
  telegramService.start();
}

// Initialize orchestrator
const orchestrator = new Orchestrator(agentService, pushService);
// The Integrations switch can stop the orchestrator; a stop has to survive
// a restart, so boot only starts it when the flag is on.
if (config.orchestrator.enabled !== false) orchestrator.start();

// Make orchestrator, agent, voice, push, and discord services available to route handlers
app.locals.orchestrator = orchestrator;
app.locals.agentService = agentService;
app.locals.voiceService = voiceService;
app.locals.pushService = pushService;
app.locals.discordService = discordService;
app.locals.telegramService = telegramService;

// Wire gateway services for status reporting
setGatewayServices({ discord: discordService, telegram: telegramService });

// Attach WebSocket server
console.log('Initializing WebSocket server...');
const wss = createWebSocketServer(server, agentService, orchestrator);
console.log('WebSocket server initialized');
startMemoryProfiler();
startMemoryMonitor();

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Auth enabled: ${config.auth.password ? 'yes' : 'no'}`);
  console.log(`Companion: ${config.identity.companion_name} | User: ${config.identity.user_name}`);
  // Phone turns the last restart cut off. A short wait first, so the lanes
  // and MCP servers have come up before anyone answers.
  setTimeout(() => {
    recoverCutOffTurns(agentService).catch((err) => console.error('[turn-leases] Recovery failed:', err));
  }, 10_000).unref();
});

// Graceful shutdown — unified handler
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // Prevent double-shutdown
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);

  // 0. Keep the leases of turns still running: the abort below cuts them off,
  // and the next boot picks them back up (services/db/turn-leases.ts).
  holdTurnLeases();

  // 1. Abort any active Claude query first (prevents orphaned SDK subprocess)
  agentService.stopGeneration();

  // 1b. Reap any warm Claude CLI heartbeat sessions. Idempotent and a no-op
  // on an empty session map (nothing is spawned while
  // CLAUDE_CLI_HEARTBEAT_ENABLED is off), so this is safe to call
  // unconditionally and gives the CLI lane a clean subprocess teardown.
  try { shutdownAllHeartbeats(); } catch { /* best-effort */ }

  // 1c. Release supervisor ownership while leaving the detached, private
  // Codex app-server warm for the next backend process to adopt.
  try { void codexSupervisor.stop(); } catch { /* best-effort */ }

  // 1d. Close MCP transports owned by this HTTP process. The Codex daemon
  // reconnects to the next backend using the persisted private credential.
  try { await closeBeltMcpSessions(); } catch { /* best-effort */ }
  try { await closeMcpJsonClients(); } catch { /* best-effort */ }
  try { stopMemoryRounds(); } catch { /* best-effort */ }
  try { shutdownEmbeddings(); } catch { /* best-effort */ }

  // 2. Stop orchestrator (clears all intervals/crons)
  orchestrator.stop();

  // 3. Stop gateway services
  if (discordService) await discordService.stop().catch(() => {});
  if (telegramService) await telegramService.stop().catch(() => {});

  // 4. Close WebSocket connections
  wss.clients.forEach(ws => ws.close());
  wss.close();

  // 5. Close HTTP server and database
  server.close(() => {
    console.log('Server closed');
    db.close();
    process.exit(0);
  });

  // 6. Safety timeout — force exit if cleanup hangs
  setTimeout(() => {
    console.error('Graceful shutdown timed out after 8s — force exiting');
    process.exit(1);
  }, 8000).unref();
}


process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Global fallback for transient socket errors (belt + suspenders)
// Primary fix is in agent.ts — this catches any escapes from third-party SDKs
// ---------------------------------------------------------------------------

const TRANSIENT_SOCKET_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);

function isTransientSocketError(err: unknown): boolean {
  const anyErr = err as any;
  return TRANSIENT_SOCKET_ERROR_CODES.has(anyErr?.code);
}

process.on('uncaughtException', (err) => {
  if (isTransientSocketError(err)) {
    console.warn('[Process] Transient socket error (uncaughtException, suppressed):', (err as any).code);
    return; // Don't crash
  }
  console.error('[Process] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  if (isTransientSocketError(reason)) {
    console.warn('[Process] Transient socket error (unhandledRejection, suppressed):', (reason as any).code);
    return; // Don't crash
  }
  console.error('[Process] Unhandled rejection:', reason);
  process.exit(1);
});
