import { Router } from 'express';
import { dirname } from 'path';
import { getBytelightConfig } from '../config.js';
import { listMaintenanceEntries } from '../services/maintenance-ledger.js';

const router = Router();

router.get('/maintenance', (_req, res) => {
  const root = dirname(getBytelightConfig().server.db_path);
  res.json({ entries: listMaintenanceEntries(root) });
});

export default router;
