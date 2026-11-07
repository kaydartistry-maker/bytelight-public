// Live canvas updates — the pure half.
//
// The classic client keeps every canvas in its socket store and applies the
// server's canvas frames there (stores/websocket/protocol.ts, canvas_created /
// canvas_updated / canvas_deleted / canvas_list). Its editor then re-syncs
// from the store ONLY while she has no unsaved typing (Canvas.svelte: "Sync
// local state when canvas changes (only when not dirty)").
//
// This file carries those same rules as plain functions so they can be tested
// without a socket or a component, plus the one thing the phone needs that
// classic never did: the phone saves over REST, and REST broadcasts every
// change back to the sender too, so the editor has to recognise its own echoes.

export type CanvasContentType = 'markdown' | 'code' | 'text' | 'html';

export interface CanvasDoc {
  id: string;
  title: string;
  content: string;
  content_type: CanvasContentType;
  language: string | null;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export type CanvasFrame =
  | { type: 'canvas_created'; canvas: CanvasDoc }
  | { type: 'canvas_updated'; canvasId: string; content: string; updatedAt: string; title?: string; tags?: string[] }
  | { type: 'canvas_deleted'; canvasId: string }
  | { type: 'canvas_list'; canvases: CanvasDoc[] };

const CANVAS_FRAME_TYPES = new Set(['canvas_created', 'canvas_updated', 'canvas_deleted', 'canvas_list']);

export function isCanvasFrame(msg: { type: string }): msg is CanvasFrame {
  return CANVAS_FRAME_TYPES.has(msg.type);
}

/** The list, exactly as the classic store applies each frame. */
export function applyFrameToList(list: CanvasDoc[], frame: CanvasFrame): CanvasDoc[] {
  switch (frame.type) {
    case 'canvas_created':
      // Classic prepends. The phone also reloads the list after its own create,
      // so the broadcast can land on a list that already has it.
      if (list.some((c) => c.id === frame.canvas.id)) return list;
      return [frame.canvas, ...list];
    case 'canvas_updated':
      return list.map((c) =>
        c.id === frame.canvasId
          ? {
              ...c,
              content: frame.content,
              updated_at: frame.updatedAt,
              ...(frame.title !== undefined && { title: frame.title }),
              ...(frame.tags !== undefined && { tags: frame.tags }),
            }
          : c,
      );
    case 'canvas_deleted':
      return list.filter((c) => c.id !== frame.canvasId);
    case 'canvas_list':
      return frame.canvases;
  }
}

/** Classic tag cleanup (Canvas.svelte addTag): lowercase, letters/digits/dashes only. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function sameTags(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

// --- Editor -----------------------------------------------------------------

export interface CanvasEditor {
  /** The last server version her draft is built on. */
  base: CanvasDoc;
  draft: string;
  draftTitle: string;
  draftTags: string[];
  /** Unsaved typing in the body (classic isDirty). */
  dirty: boolean;
  /**
   * A newer body that arrived from the server while she was typing. Held back
   * instead of applied, and while it is set nothing auto-saves, so neither
   * side's words are lost until she picks.
   */
  incoming: string | null;
}

/** What the phone has sent and not yet heard back about. Consumed one-for-one. */
export interface CanvasEchoes {
  contents: string[];
  tags: string[][];
}

const ECHO_CAP = 10;

export function emptyEchoes(): CanvasEchoes {
  return { contents: [], tags: [] };
}

export function openEditor(canvas: CanvasDoc): CanvasEditor {
  return {
    base: canvas,
    draft: canvas.content || '',
    draftTitle: canvas.title,
    draftTags: canvas.tags || [],
    dirty: false,
    incoming: null,
  };
}

export function editDraft(ed: CanvasEditor, next: string): CanvasEditor {
  return { ...ed, draft: next, dirty: true };
}

/** May the debounced auto-save fire right now? */
export function canAutoSave(ed: CanvasEditor): boolean {
  return ed.dirty && ed.incoming === null;
}

/** Record a body save going out: it becomes the base and its echo is expected. */
export function markContentSent(ed: CanvasEditor, echoes: CanvasEchoes, content: string): { editor: CanvasEditor; echoes: CanvasEchoes } {
  return {
    editor: { ...ed, base: { ...ed.base, content }, dirty: ed.draft !== content, incoming: null },
    echoes: { ...echoes, contents: [...echoes.contents, content].slice(-ECHO_CAP) },
  };
}

export function markTagsSent(ed: CanvasEditor, echoes: CanvasEchoes, tags: string[]): { editor: CanvasEditor; echoes: CanvasEchoes } {
  return {
    editor: { ...ed, draftTags: tags, base: { ...ed.base, tags } },
    echoes: { ...echoes, tags: [...echoes.tags, tags].slice(-ECHO_CAP) },
  };
}

export function markTitleSent(ed: CanvasEditor, title: string): CanvasEditor {
  return { ...ed, base: { ...ed.base, title } };
}

/** "Use latest": drop her unsaved body for the version that arrived. */
export function takeIncoming(ed: CanvasEditor): CanvasEditor {
  if (ed.incoming === null) return ed;
  return { ...ed, draft: ed.incoming, base: { ...ed.base, content: ed.incoming }, dirty: false, incoming: null };
}

/**
 * The Save button: only the fields she actually changed. A field she never
 * touched is never re-sent, so Save cannot put back an old title, body or tag
 * set over one the server has since moved on from.
 */
export function pendingSaveFields(ed: CanvasEditor): { title?: string; content?: string; tags?: string[] } {
  const out: { title?: string; content?: string; tags?: string[] } = {};
  if (ed.draftTitle !== ed.base.title) out.title = ed.draftTitle;
  if (ed.dirty && ed.draft !== ed.base.content) out.content = ed.draft;
  if (!sameTags(ed.draftTags, ed.base.tags)) out.tags = ed.draftTags;
  return out;
}

function consumeFirst<T>(arr: T[], match: (v: T) => boolean): T[] | null {
  const i = arr.findIndex(match);
  if (i < 0) return null;
  return [...arr.slice(0, i), ...arr.slice(i + 1)];
}

/**
 * Apply one frame to the open editor. Returns editor null when the canvas is
 * gone (classic closes it: activeCanvasId → null).
 */
export function applyFrameToEditor(
  ed: CanvasEditor,
  echoes: CanvasEchoes,
  frame: CanvasFrame,
): { editor: CanvasEditor | null; echoes: CanvasEchoes } {
  const id = ed.base.id;

  if (frame.type === 'canvas_deleted') {
    return { editor: frame.canvasId === id ? null : ed, echoes };
  }
  if (frame.type === 'canvas_created') return { editor: ed, echoes };
  if (frame.type === 'canvas_list') {
    // A reconnect re-sends the whole list; classic re-derives the open canvas
    // from it, and a canvas missing from it closes.
    const found = frame.canvases.find((c) => c.id === id);
    if (!found) return { editor: null, echoes };
    return applyFrameToEditor(ed, echoes, {
      type: 'canvas_updated',
      canvasId: id,
      content: found.content,
      updatedAt: found.updated_at,
      title: found.title,
      tags: found.tags || [],
    });
  }
  if (frame.canvasId !== id) return { editor: ed, echoes };

  // Her own REST saves come back to her. A tag save's frame carries the body
  // as it stood BEFORE that request, so its body is never news.
  if (frame.tags !== undefined) {
    const rest = consumeFirst(echoes.tags, (t) => sameTags(t, frame.tags));
    if (rest) return { editor: ed, echoes: { ...echoes, tags: rest } };
  } else {
    const rest = consumeFirst(echoes.contents, (c) => c === frame.content);
    if (rest) return { editor: ed, echoes: { ...echoes, contents: rest } };
  }

  const prev = ed.base;
  const base: CanvasDoc = {
    ...prev,
    content: frame.content,
    updated_at: frame.updatedAt,
    ...(frame.title !== undefined && { title: frame.title }),
    ...(frame.tags !== undefined && { tags: frame.tags }),
  };
  const next: CanvasEditor = { ...ed, base };

  // Tags save the moment she changes them, so there is no unsaved tag state to
  // protect: the server's set is the set.
  if (frame.tags !== undefined) next.draftTags = frame.tags;
  // A title she is mid-way through renaming stays hers.
  if (frame.title !== undefined && ed.draftTitle === prev.title) next.draftTitle = frame.title;

  if (!ed.dirty) {
    // Classic rule: no unsaved typing → the server's body shows.
    next.draft = frame.content;
    next.incoming = null;
  } else if (frame.content === ed.draft) {
    // The server caught up to exactly what she has.
    next.dirty = false;
    next.incoming = null;
  } else if (frame.content !== prev.content) {
    // The body really moved under her typing: keep her draft (classic), and
    // hold the newer one where she can see it.
    next.incoming = frame.content;
  }
  return { editor: next, echoes };
}
