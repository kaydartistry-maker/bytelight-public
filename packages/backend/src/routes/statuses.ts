// Statuses, the phone's door: the Status widget and lock-screen card read
// here, and her own status sheet writes here. Behind the login.
//
// Companions set theirs through the loopback door (/api/internal/status in
// routes/internal-routes.ts).

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getStatusSnapshot, setOwnerStatus, StatusError } from '../services/db/statuses.js';

const router = Router();
router.use(authMiddleware);

router.get('/', (_req, res) => {
  try {
    res.json(getStatusSnapshot());
  } catch (err) {
    console.error('[statuses] reading failed:', err);
    res.status(500).json({ error: 'The statuses could not be read.' });
  }
});

router.put('/me', (req, res) => {
  try {
    res.json({ owner: setOwnerStatus(req.body ?? {}) });
  } catch (err) {
    if (err instanceof StatusError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[statuses] saving failed:', err);
    res.status(500).json({ error: 'Your status could not be saved.' });
  }
});

export default router;
