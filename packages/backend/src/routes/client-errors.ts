// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The phone's crash reports land here and go to the error log, tagged
// [client-error], one line each. Read them in the backend's error output
// (pm2's error log, when the house runs under pm2). The phone's own recorders
// use the same road with a where of their own; the ones that post without a
// fall to set them off have a ceiling (REPORT_CEILINGS).

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { clientErrorLine, createReportCeiling } from '../services/client-errors.js';

const router = Router();
router.use(authMiddleware);
const ceiling = createReportCeiling();

router.post('/', (req, res) => {
  if (!clientErrorLine(req.body)) {
    res.status(400).json({ error: 'Nothing to report' });
    return;
  }
  const verdict = ceiling((req.body as { where?: unknown }).where);
  if (!verdict.write) {
    res.json({ success: true, held: true });
    return;
  }
  console.error(`[client-error] ${clientErrorLine(req.body, new Date(), verdict.heldBack)}`);
  res.json({ success: true });
});

export default router;
