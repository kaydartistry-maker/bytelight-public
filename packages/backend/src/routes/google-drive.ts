import { Router, type Request } from 'express';
import { getSecret, setSecretsAtomically } from '../services/secrets.js';
import {
  GoogleDriveError,
  beginGoogleDriveLogin,
  disconnectGoogleDrive,
  finishGoogleDriveLogin,
  googleDriveStatus,
} from '../services/google-drive.js';

const router = Router();
export const googleDriveCallbackRouter = Router();

function redirectUri(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded === 'https' ? 'https' : req.protocol;
  return `${protocol}://${req.get('host')}/api/auth/google-drive/callback`;
}

router.get('/integrations/google-drive/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json({ ...(await googleDriveStatus()), redirectUri: redirectUri(req) }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Status failed.' }); }
});

router.post('/integrations/google-drive/configure', (req, res) => {
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
  const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim() : '';
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Client ID and client secret are required.' });
  setSecretsAtomically({ google_drive_client_id: clientId, google_drive_client_secret: clientSecret });
  res.json({ ok: true, configured: true, redirectUri: redirectUri(req) });
});

router.post('/integrations/google-drive/login', (req, res) => {
  try { res.json({ url: beginGoogleDriveLogin(redirectUri(req)), redirectUri: redirectUri(req) }); }
  catch (error) {
    const status = error instanceof GoogleDriveError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Could not start Google sign-in.' });
  }
});

// Google returns through an external browser, which cannot carry Virelle's
// WebView session cookie. The random, single-use, ten-minute OAuth state is
// the authorization for this one callback; the setup/login/disconnect routes
// remain behind the app auth boundary.
googleDriveCallbackRouter.get('/auth/google-drive/callback', async (req, res) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code) throw new GoogleDriveError(String(req.query.error || 'Google did not return an authorization code.'), 400);
    await finishGoogleDriveLogin(state, code);
    res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>Google Drive connected</title><body style="font:16px system-ui;padding:32px;background:#111;color:#fff"><h1>Google Drive connected</h1><p>You can close this window and return to Virelle.</p><script>setTimeout(()=>window.close(),800)</script></body>');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google sign-in failed.';
    res.status(400).type('html').send(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:32px"><h1>Connection failed</h1><p>${message.replace(/[<>&]/g, '')}</p></body>`);
  }
});

router.post('/integrations/google-drive/disconnect', async (_req, res) => {
  await disconnectGoogleDrive();
  res.json({ ok: true, connected: false, configured: Boolean(getSecret('google_drive_client_id') && getSecret('google_drive_client_secret')) });
});

export default router;
