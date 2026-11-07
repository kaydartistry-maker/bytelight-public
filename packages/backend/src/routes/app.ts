// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// App shell update lane — the house builds and serves its own APK.
// The shell is a thin frame around the served phone app, so UI changes ship
// with every vite build; these routes only matter when the native layer
// itself changes (new plugins, new permissions). Artifacts live in app/ beside
// the house database (gitignored): bytelight.apk + version.json, staged by hand
// or by a build. The APK itself is built by GitHub (Actions → Phone APK).
// Change from Aerie: the directory sits beside the database, like the Library's.

import { Router } from 'express';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { getBytelightConfig } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

function appDir(): string {
  return join(dirname(getBytelightConfig().server.db_path), 'app');
}

const router = Router();
router.use(authMiddleware);

router.get('/version', (_req, res) => {
  const APP_DIR = appDir();
  const versionPath = join(APP_DIR, 'version.json');
  if (!existsSync(versionPath)) {
    return res.json({ available: false });
  }
  try {
    const meta = JSON.parse(readFileSync(versionPath, 'utf-8'));
    res.json({ available: existsSync(join(APP_DIR, 'bytelight.apk')), ...meta });
  } catch {
    res.json({ available: false });
  }
});

router.get('/download', (_req, res) => {
  const APP_DIR = appDir();
  const apkPath = join(APP_DIR, 'bytelight.apk');
  if (!existsSync(apkPath)) {
    return res.status(404).json({ error: 'No APK staged' });
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="bytelight.apk"');
  res.sendFile(apkPath);
});

/**
 * A sideloaded APK has no crash console anywhere. Without this the only report
 * of a native crash is the owner describing an app that vanished, so the shell
 * posts its own stack on the way out and it lands here as evidence.
 */
router.post('/crash', (req, res) => {
  const report = typeof req.body?.report === 'string' ? req.body.report : null;
  if (!report) return res.status(400).json({ error: 'No report' });
  const APP_DIR = appDir();
  try {
    if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
    // Bounded, because a crash loop must not be able to fill the disk.
    const entry = `\n=== ${new Date().toISOString()} ===\n${report.slice(0, 20000)}\n`;
    appendFileSync(join(APP_DIR, 'crashes.log'), entry);
  } catch {
    // A failure to record a crash is not worth a second error path; the
    // shell has already written its own copy on the device.
  }
  res.json({ received: true });
});

export default router;
