import { Router } from 'express';
import { getDb } from '../services/db.js';
import { createLifeQuestStore, QuestError } from '../services/life-quests.js';
import { draftLifeQuests } from '../services/life-quest-draft.js';

const router = Router();
let forging = false;
const stores = new WeakMap<object, ReturnType<typeof createLifeQuestStore>>();
const store = () => { const db = getDb(); let s = stores.get(db); if (!s) { s = createLifeQuestStore(db); stores.set(db, s); } return s; };
router.use((_req,res,next) => { res.set('Cache-Control','private, no-store'); next(); });
const handle = (fn: any) => async (req: any, res: any) => { try { await fn(req,res); } catch (e) { const q = e as any; res.status(e instanceof QuestError ? q.status : 500).json({ error: e instanceof QuestError ? q.message : 'Questing could not complete that request.' }); } };
router.get('/', handle((_req: any, res: any) => res.json(store().state())));
router.post('/forge', handle(async (req: any, res: any) => { if (forging) throw new QuestError('The Forge is already shaping a brain dump.', 409); forging = true; try { res.json({ quests: await draftLifeQuests(getDb(), req.body?.dump) }); } finally { forging = false; } }));
router.post('/', handle((req: any, res: any) => res.status(201).json(store().add(req.body?.quests))));
router.patch('/:id', handle((req: any, res: any) => res.json(store().change(String(req.params.id), req.body?.action, req.body))));
router.post('/rewards/:id/choose', handle((req: any, res: any) => res.json(store().chooseReward(String(req.params.id), req.body?.choiceId))));
export default router;
