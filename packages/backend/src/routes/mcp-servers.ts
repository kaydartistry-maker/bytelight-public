// Ported whole from the reference implementation's routes/mcp-servers.ts, Apache 2.0 —
// adapted for byte-light. Managed MCP server registry: list/add/delete/toggle
// plus Test (pre-save) and per-server discover endpoints.
//
// NAMED ADAPTATION (routes): the source applied authMiddleware per route;
// byte-light applies auth once at the api.ts boundary, so this router
// is mounted in api.ts AFTER authMiddleware with no
// per-route middleware — same pattern as sibling routers (starred, usage).
// NAMED ADAPTATION (accessor name): the source's toggleMcpServer db accessor
// is named setMcpServerEnabled in byte-light's db.ts (Slice 1).
import { Router } from 'express';
import {
  listMcpServers,
  addMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
} from '../services/db.js';
import { discoverManagedServer, invalidateManagedServer } from '../services/mcp-bridge.js';
import { discoverMcpTools } from '../services/mcp-client.js';
import { errMessage } from '../util/errors.js';

const router = Router();

/**
 * GET /api/mcp-servers — list all managed MCP servers
 */
router.get('/mcp-servers', (_req, res) => {
  const servers = listMcpServers();
  res.json(servers.map(s => ({
    id: s.id,
    name: s.name,
    url: s.url,
    hasApiKey: !!s.api_key,
    enabled: !!s.enabled,
    toolCount: s.tools_cache ? JSON.parse(s.tools_cache).length : 0,
    lastDiscovered: s.last_discovered,
    createdAt: s.created_at,
  })));
});

/**
 * POST /api/mcp-servers — add a new MCP server
 * Body: { name: string, url: string, api_key?: string }
 */
router.post('/mcp-servers', (req, res) => {
  const { name, url, api_key } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  try {
    const server = addMcpServer(name, url, api_key);
    res.status(201).json({
      id: server.id,
      name: server.name,
      url: server.url,
      hasApiKey: !!server.api_key,
      enabled: !!server.enabled,
      toolCount: 0,
      lastDiscovered: null,
      createdAt: server.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

/**
 * DELETE /api/mcp-servers/:id — remove an MCP server
 */
router.delete('/mcp-servers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  invalidateManagedServer(id);
  const deleted = deleteMcpServer(id);
  if (!deleted) return res.status(404).json({ error: 'not found' });

  res.json({ ok: true });
});

/**
 * PUT /api/mcp-servers/:id/toggle — enable or disable an MCP server
 * Body: { enabled: boolean }
 */
router.put('/mcp-servers/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  invalidateManagedServer(id);
  const updated = setMcpServerEnabled(id, enabled);
  if (!updated) return res.status(404).json({ error: 'not found' });

  res.json({ ok: true, enabled });
});

/**
 * POST /api/mcp-servers/test — connect to a url + key without saving
 * anything. Used by the add-server form so the user can verify the URL
 * is reachable and reports tools before they commit to creating the
 * row. Returns { ok, toolCount } on success, { ok: false, error } on
 * any kind of failure (network, auth, malformed response).
 */
router.post('/mcp-servers/test', async (req, res) => {
  try {
    const { url, apiKey } = req.body as { url?: string; apiKey?: string };
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ ok: false, error: 'url required' });
    }
    const tools = await discoverMcpTools(url, apiKey || null);
    res.json({ ok: true, toolCount: tools.length });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: errMessage(err),
    });
  }
});

/**
 * POST /api/mcp-servers/:id/discover — test connection and discover tools
 */
router.post('/mcp-servers/:id/discover', async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  try {
    const toolCount = await discoverManagedServer(id);
    res.json({ ok: true, toolCount });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: errMessage(err),
    });
  }
});

export default router;
