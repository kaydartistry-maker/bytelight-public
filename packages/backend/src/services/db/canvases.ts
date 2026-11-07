import { join } from 'path';
import type { Canvas } from '@bytelight/shared';
import { getDb } from './init.js';

// Canvas operations
// Parse tags JSON from DB row, always returns string[]
function parseTags(row: any): string[] {
  if (!row?.tags) return [];
  try { return JSON.parse(row.tags); } catch { return []; }
}

// Convert DB row to Canvas with parsed tags
function rowToCanvas(row: any): Canvas {
  return { ...row, tags: parseTags(row) } as Canvas;
}

export function createCanvas(params: {
  id: string;
  threadId?: string;
  title: string;
  content?: string;
  contentType: 'markdown' | 'code' | 'text' | 'html';
  language?: string;
  tags?: string[];
  createdBy: 'companion' | 'user';
  createdAt: string;
}): Canvas {
  const stmt = getDb().prepare(`
    INSERT INTO canvases (id, thread_id, title, content, content_type, language, tags, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.threadId || null,
    params.title,
    params.content || '',
    params.contentType,
    params.language || null,
    JSON.stringify(params.tags || []),
    params.createdBy,
    params.createdAt,
    params.createdAt,
  );
  return getCanvas(params.id)!;
}

export function getCanvas(id: string): Canvas | null {
  const stmt = getDb().prepare('SELECT * FROM canvases WHERE id = ?');
  const row = stmt.get(id);
  return row ? rowToCanvas(row) : null;
}

export function listCanvases(opts?: { search?: string; tag?: string }): Canvas[] {
  let sql = 'SELECT * FROM canvases';
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.search) {
    conditions.push('(title LIKE ? OR content LIKE ?)');
    const q = `%${opts.search}%`;
    params.push(q, q);
  }
  if (opts?.tag) {
    conditions.push('tags LIKE ?');
    params.push(`%"${opts.tag}"%`);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY updated_at DESC';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...params);
  return rows.map(rowToCanvas);
}

export function getAllCanvasTags(): string[] {
  const rows = getDb().prepare('SELECT tags FROM canvases WHERE tags != \'[]\' AND tags IS NOT NULL').all() as Array<{ tags: string }>;
  const tagSet = new Set<string>();
  for (const row of rows) {
    for (const tag of parseTags(row)) tagSet.add(tag);
  }
  return [...tagSet].sort();
}

export function updateCanvasContent(id: string, content: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET content = ?, updated_at = ? WHERE id = ?');
  stmt.run(content, updatedAt, id);
}

export function updateCanvasTitle(id: string, title: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?');
  stmt.run(title, updatedAt, id);
}

export function updateCanvasTags(id: string, tags: string[], updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET tags = ?, updated_at = ? WHERE id = ?');
  stmt.run(JSON.stringify(tags), updatedAt, id);
}

export function deleteCanvas(id: string): boolean {
  const stmt = getDb().prepare('DELETE FROM canvases WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}
