// The Needle's return line (Nov 2026): the Android app's messaging service
// reports here, with the WebView's own session cookie, whether a dropped song
// started on the operator's phone and which road it took. The house logs one line and
// answers; nothing is posted to chat.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { needle } from '../services/needle.js';

const router = Router();
router.use(authMiddleware);

router.post('/landed', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const answer = needle().landed(req.body);
  res.status(answer.ok ? 200 : answer.reason === 'request' ? 400 : 404).json(answer);
});

export default router;
