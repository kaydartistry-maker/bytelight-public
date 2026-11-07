export type GifTools =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; reason: string };

type GifKeep =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; location: string }
  | { kind: 'failed'; error: string };

export type GifOutput =
  | { kind: 'none' }
  | { kind: 'legacy-preview'; url: string }
  | { kind: 'available'; artifact: { sessionId: string; filename: string; url: string }; keep: GifKeep };

export function outputFromResponse(sessionId: string, value: unknown): GifOutput {
  if (!value || typeof value !== 'object') return { kind: 'none' };
  const record = value as Record<string, unknown>;
  if (typeof record.filename !== 'string' || !record.filename || typeof record.url !== 'string' || !record.url) return { kind: 'none' };
  return { kind: 'available', artifact: { sessionId, filename: record.filename, url: record.url }, keep: { kind: 'idle' } };
}
