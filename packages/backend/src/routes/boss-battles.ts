import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { BOSS_BATTLES_PATH } from '@bytelight/shared';
import { webRestOwner } from '../middleware/owner.js';
import { getDb } from '../services/db.js';
import { BattleError, bossIssue, createBossBattleStore } from '../services/boss-battles.js';
import { draftBossWithCompanion } from '../services/boss-companion.js';
import { GALLERY_DIR, getJobStatus, startGenerateJob, ImageGenError } from '../services/image-gen.js';
import { getStudioStyles, StudioStyleError } from '../services/studio-styles.js';

export function createBossBattleRoutes(deps = { owner: webRestOwner, db: getDb, job: getJobStatus, start: startGenerateJob, draft: draftBossWithCompanion, defaultStyle: () => getStudioStyles().defaultChatStyleId }) {
  const router = Router();
  let summoning = false;
  const stores = new WeakMap<ReturnType<typeof getDb>, ReturnType<typeof createBossBattleStore>>();
  function store() {
    const db = deps.db();
    let current = stores.get(db);
    if (!current) { current = createBossBattleStore(db); stores.set(db, current); }
    return current;
  }
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.use((req, res, next) => {
    try { deps.owner(req); }
    catch { res.status(403).json({ error: 'Sign in as the Virelle owner to open Boss Battles.' }); return; }
    next();
  });
  function state() {
    const { xp, battles } = store().list();
    return { xp, battles: battles.map(({ portraitJobId, portraitFilename, ...battle }) => ({ ...battle,
      portrait: portraitFilename ? 'ready' : !portraitJobId ? 'none' : deps.job(portraitJobId)?.status ?? 'unavailable',
      portraitUrl: portraitFilename ? `${BOSS_BATTLES_PATH}/${encodeURIComponent(battle.id)}/portrait` : null,
    })) };
  }
  function handle(fn: (req: Request, res: Response) => void | Promise<void>) {
    return async (req: Request, res: Response) => {
      try { await fn(req, res); }
      catch (error) {
        if (error instanceof BattleError) res.status(error.status).json({ error: error.message });
        else if (error instanceof ImageGenError || error instanceof StudioStyleError) res.status(400).json({ error: error.message });
        else res.status(500).json({ error: 'Boss Battles could not complete that request.' });
      }
    };
  }
  router.get('/', handle((_req, res) => { res.json(state()); }));
  router.post('/', handle(async (req, res) => {
    const issue = bossIssue(req.body?.issue);
    const db = store();
    if (summoning || db.list().battles.some(b => b.status === 'active')) throw new BattleError('A battle is already active or being summoned.', 409);
    summoning = true;
    try {
      const draft = await deps.draft(deps.db(), issue);
      const id = db.create(issue, draft);
      let portraitNotice: string | undefined;
      try {
        const styleId = deps.defaultStyle() ?? '';
        db.portrait(id, prompt => deps.start({ usageOrigin: 'studio', prompt, styleId, imageModelId: 'subscription-auto', size: 'square' },
          result => { db.finishPortrait(id, result.filename); }));
      } catch { portraitNotice = 'Your battle is ready. Codex couldn’t start the portrait with the current Studio settings.'; }
      res.status(201).json({ ...state(), portraitNotice });
    } finally { summoning = false; }
  }));
  router.patch('/:id', handle((req, res) => {
    store().change(String(req.params.id), req.body?.action, req.body?.moveId, req.body?.text);
    res.json(state());
  }));
  router.get('/:id/portrait', handle((req, res) => {
    const battle = store().list().battles.find(b => b.id === req.params.id);
    const filename = battle?.portraitFilename;
    if (!filename || basename(filename) !== filename || !existsSync(join(GALLERY_DIR, filename))) throw new BattleError('Portrait not found.', 404);
    res.sendFile(join(GALLERY_DIR, filename));
  }));
  return router;
}
