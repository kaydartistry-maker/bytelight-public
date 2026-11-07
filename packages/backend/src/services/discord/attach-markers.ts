// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// [discord-attach:<fileId>] in a reply becomes a real file on the Discord
// message. imageUrls only ever feeds the phone, so this marker is the one road a
// picture has into a channel.
//
// THE FAULT THIS FILE WAS PULLED OUT TO FIX (Oct 20 2026, caught by the owner
// in a listening room when a picture never arrived). The old reader took the FIRST name in
// data/files that started with the fileId. Since Sep 2026 a file the owner names keeps
// that name in a sidecar beside it, <fileId>.name, and readdir handed the
// sidecar over first, so the channel got a 20-byte text file holding the words
// starlight-squish.png instead of the picture (log: 'Attached file:
// <id>.name'). The folder also holds <fileId>_analysis directories for songs,
// which start with the id too.
//
// So the stored file is the one named exactly <fileId><ext>, never the sidecar,
// and the name the sidecar holds is what the upload is called, because Discord
// shows a picture as a picture by its name.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { extname, join } from 'path';
import { AttachmentBuilder } from 'discord.js';
import { PROJECT_ROOT } from '../../config.js';
import { isNameSidecar, NAME_SIDECAR_EXT, safeDisplayName } from '../file-names.js';

export const DISCORD_FILES_DIR = join(PROJECT_ROOT, 'data/files');
export const ATTACH_MARKER_REGEX = /\[discord-attach:([a-f0-9-]+)\]/gi;

/**
 * Which name in the folder is the stored file for this id: exactly
 * <fileId><one extension>, never the .name sidecar beside it and never a
 * folder or a derived file that merely starts with the id.
 */
export function pickStoredFile(fileId: string, names: string[]): string | null {
  const id = fileId.toLowerCase();
  for (const name of names) {
    if (!name.toLowerCase().startsWith(id)) continue;
    const ext = name.slice(id.length);
    if (!/^\.[A-Za-z0-9]+$/.test(ext)) continue;
    if (isNameSidecar(ext)) continue;
    return name;
  }
  return null;
}

/**
 * What the upload is called: the name the owner gave the file when there is one,
 * carrying the stored file's extension so Discord knows a picture is a
 * picture; the stored name when nothing was remembered.
 */
export function uploadName(storedName: string, remembered: string | null | undefined): string {
  const safe = safeDisplayName(remembered ?? '');
  if (!safe) return storedName;
  const ext = extname(storedName);
  if (!ext || safe.toLowerCase().endsWith(ext.toLowerCase())) return safe;
  return `${safe}${ext}`;
}

export interface ParsedAttachments {
  text: string;
  files: AttachmentBuilder[];
}

/** Turn every marker in a reply into a file, and strip the markers from the words. */
export function parseAttachmentMarkers(response: string, dir: string = DISCORD_FILES_DIR): ParsedAttachments {
  const files: AttachmentBuilder[] = [];
  const matches = [...response.matchAll(ATTACH_MARKER_REGEX)];

  for (const match of matches) {
    const fileId = match[1];
    try {
      const stored = pickStoredFile(fileId, readdirSync(dir));
      if (!stored) {
        console.warn(`[Discord] No stored file for attachment ${fileId}`);
        continue;
      }
      const filePath = join(dir, stored);
      if (!existsSync(filePath)) continue;
      const sidecar = join(dir, `${stored.slice(0, fileId.length)}${NAME_SIDECAR_EXT}`);
      let remembered: string | null = null;
      try {
        if (existsSync(sidecar)) remembered = readFileSync(sidecar, 'utf8');
      } catch { /* a name we cannot read is a name we do not have */ }
      const name = uploadName(stored, remembered);
      files.push(new AttachmentBuilder(readFileSync(filePath), { name }));
      console.log(`[Discord] Attached file: ${stored}${name !== stored ? ` as ${name}` : ''}`);
    } catch (err) {
      console.error(`[Discord] Failed to attach file ${fileId}:`, err);
    }
  }

  // Strip markers from text
  const text = response.replace(ATTACH_MARKER_REGEX, '').trim();

  return { text, files };
}
