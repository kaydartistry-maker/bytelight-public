<!-- Cutout face — background removal + paint-back + still export.
     Ported from Tris's GIF Lab standalone (CutoutApp.tsx + lib/paint.ts,
     match-stik/the-gif-lab, Apache 2.0). Rebuilt in Svelte 5 runes for
     byte-light's Studio drawer. Interaction spec is faithful to the source:
     one-finger paint, two-finger pinch-zoom/pan, ghost underlay of the
     pre-cut original in the main view AND inside the magnifier loupe,
     brush/loupe sized in image pixels so replay is resolution-independent.

     Backend routes are already live in packages/backend/src/routes/gif.ts:
     upload-frame · cutout · cutout/:.../revert · mask-paint · still-export ·
     chroma-key · crop · cutout/status. -->
<script lang="ts">
  import { apiFetch } from '$lib/utils/api';
  import { showToast } from '$lib/stores/toast.svelte';

  interface Props {
    /** Only mount work when the Cutout tab is showing. */
    active: boolean;
  }
  let { active }: Props = $props();

  // ── Constants — the pieces two copies would have to keep in sync ─────
  /** How faint the pre-cut original sits behind the working image. Read by
      both the main viewport and the magnifier loupe so they cannot drift. */
  const GHOST_OPACITY = 0.55;
  /** Diameter of the magnifier that follows the brush, in screen pixels. */
  const LOUPE = 104;
  /** Discord's own walls, taken whole from GIF Lab. Same numbers as GIF tab. */
  const PRESETS = [
    { id: 'emoji', label: 'Emoji', hint: '128px · 256KB', maxSide: 128, maxBytes: 262_144, padSquare: false },
    { id: 'sticker', label: 'Sticker', hint: '320×320 · 512KB', maxSide: 320, maxBytes: 524_288, padSquare: true },
    { id: 'full', label: 'Full size', hint: 'untouched', maxSide: 0, maxBytes: 0, padSquare: false },
  ] as const;
  const SESSION_KEY = 'bytelight.cutout.session';

  interface Stroke {
    tool: 'restore' | 'erase';
    /** Brush width in the image's own pixels — replay-safe at any zoom. */
    width: number;
    points: Array<{ x: number; y: number }>;
  }
  interface BatchItem {
    sessionId: string;
    filename: string;
    name: string;
    url: string;
    cut: boolean;
    error?: string;
  }
  interface ExportResult {
    url: string;
    filename: string;
    bytes?: number;
    width?: number;
    height?: number;
    colors?: number | null;
    withinBudget?: boolean;
  }

  // ── State ─────────────────────────────────────────────────────────────
  let engine = $state<{ ready: boolean; model: string | null; reason: string | null } | null>(null);
  let sessionId = $state('');
  let filename = $state('');
  let imageUrl = $state('');
  let cut = $state(false);
  let busy = $state('');
  let error = $state('');

  // Remove-background controls
  let mode = $state<'color' | 'subject'>('color');
  // Percent internally, decimal to the backend — same convention as the GIF tab.
  let tolerancePct = $state(30);
  let blendPct = $state(10);
  let keyColour = $state('#00FF00');
  let greenScreen = $state(false);
  let feather = $state(1);
  let hardEdge = $state(false);
  let picking = $state(false);

  // Paint
  let painting = $state(false);
  let tool = $state<'restore' | 'erase'>('restore');
  let brush = $state(28);
  let strokes = $state<Stroke[]>([]);
  let ghost = $state(true);
  let ghostOk = $state(true);
  const ghostUrl = $derived(sessionId && filename ? `/api/gif/frame/${sessionId}/original-${filename}` : '');

  // View transform
  let zoom = $state(1);
  let pan = $state({ x: 0, y: 0 });
  let natural = $state({ w: 0, h: 0 });
  let loupe = $state<{ x: number; y: number; scale: number; side: 'left' | 'right' } | null>(null);

  // Batch + crop
  let batch = $state<BatchItem[]>([]);
  let batchBusy = $state('');
  let cropping = $state(false);
  let crop = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  let restored = $state(false);

  // Save-as
  let preset = $state<'emoji' | 'sticker' | 'full'>('sticker');
  let format = $state<'png' | 'webp'>('png');
  let result = $state<ExportResult | null>(null);

  // Refs (bind:this)
  let fileInput = $state<HTMLInputElement>();
  let viewportEl = $state<HTMLDivElement>();
  let imageEl = $state<HTMLImageElement>();
  let paintCanvas = $state<HTMLCanvasElement>();

  // Non-reactive scratch (avoid $state for these — they're pure refs)
  let activeStroke: Stroke | null = null;
  const pointersDown = new Map<number, { x: number; y: number }>();
  let gesture: { dist: number; zoom: number; cx: number; cy: number; pan: { x: number; y: number } } | null = null;
  let cropDrag: 'new' | 'nw' | 'ne' | 'sw' | 'se' | null = null;
  let cropAnchor: { x: number; y: number } | null = null;

  // ── Effects ──────────────────────────────────────────────────────────
  // Ask once for engine status when the tab first mounts.
  $effect(() => {
    if (!active || engine) return;
    (async () => {
      try {
        const r = await apiFetch('/api/gif/cutout/status');
        const data = r.ok ? await r.json().catch(() => null) : null;
        engine = data && typeof data.ready === 'boolean'
          ? data
          : { ready: false, model: null, reason: 'Background removal is unavailable on this server.' };
      } catch {
        engine = { ready: false, model: null, reason: 'Could not reach the server.' };
      }
    })();
  });

  // Restore any prior session on first mount (survives tab switches too).
  $effect(() => {
    if (restored) return;
    try {
      const raw = window.localStorage.getItem(SESSION_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.sessionId && saved?.filename) {
          sessionId = saved.sessionId;
          filename = saved.filename;
          imageUrl = saved.imageUrl || '';
          cut = !!saved.cut;
          batch = Array.isArray(saved.batch) ? saved.batch : [];
          if (saved.keyColour) keyColour = saved.keyColour;
          if (typeof saved.tolerancePct === 'number') tolerancePct = saved.tolerancePct;
          if (typeof saved.blendPct === 'number') blendPct = saved.blendPct;
          if (typeof saved.greenScreen === 'boolean') greenScreen = saved.greenScreen;
          if (saved.mode) mode = saved.mode;
        }
      }
    } catch {
      // A private webview can refuse storage; app still works, it just forgets.
    }
    restored = true;
  });

  // Save session on relevant state changes — but only after the initial restore.
  $effect(() => {
    if (!restored) return;
    const snapshot = { sessionId, filename, imageUrl, cut, batch, keyColour, tolerancePct, blendPct, greenScreen, mode };
    try {
      if (!sessionId) window.localStorage.removeItem(SESSION_KEY);
      else window.localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    } catch { /* forgetting is not a failure */ }
  });

  // A new frame has its own original, or none at all. Without this reset,
  // one uncut frame turns the ghost off for every frame after it.
  $effect(() => { sessionId; filename; ghostOk = true; });

  // Overlay redraws itself when strokes / image / zoom / pan change — the
  // host cannot be trusted to remember, and blind painting is the failure.
  $effect(() => { strokes; imageUrl; painting; zoom; pan; drawStrokes(strokes); });

  // ── API helpers ──────────────────────────────────────────────────────
  async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    busy = label;
    error = '';
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : `${label} failed`;
      error = msg;
      showToast(msg, 'error');
      return null;
    } finally {
      busy = '';
    }
  }

  async function pickImage(file: File): Promise<{ sessionId: string; filename: string; url: string } | null> {
    result = null;
    cut = false;
    return await withBusy('Uploading', async () => {
      const body = new FormData();
      body.append('file', file);
      const r = await apiFetch('/api/gif/upload-frame', { method: 'POST', body });
      const data = r.ok ? await r.json().catch(() => null) : null;
      if (!data?.frame?.filename) throw new Error('Upload failed');
      sessionId = data.sessionId;
      filename = data.frame.filename;
      imageUrl = `${data.frame.url}?t=${Date.now()}`;
      return { sessionId: data.sessionId, filename: data.frame.filename, url: data.frame.url };
    });
  }

  async function removeBackground() {
    if (!sessionId || !filename) return;
    result = null;
    await withBusy('Finding the subject', async () => {
      const r = await apiFetch(`/api/gif/cutout/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 0.15 threshold, not 0.5: keep everything the model saw at all, including
        // fabric it was only half sure about. Same choice as upstream.
        body: JSON.stringify({ feather, threshold: hardEdge ? 0.15 : undefined }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || 'Background removal failed');
      imageUrl = data.url;
      cut = true;
    });
  }

  async function keyColourOut() {
    if (!sessionId || !filename) return;
    result = null;
    await withBusy('Keying the color', async () => {
      const r = await apiFetch(`/api/gif/chroma-key/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          color: keyColour,
          tolerance: tolerancePct / 100,
          blend: blendPct / 100,
          mode: greenScreen ? 'chroma' : 'color',
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || 'Color key failed');
      const url = data?.url || `/api/gif/frame/${sessionId}/${filename}?t=${Date.now()}`;
      imageUrl = url;
      cut = true;
      // The picture in the editor is also the first tile in the grid — finish
      // it here, finish it there, so the same one is never keyed twice.
      batch = batch.map((b) =>
        b.sessionId === sessionId && b.filename === filename
          ? { ...b, url: bust(url), cut: true, error: undefined }
          : b);
    });
  }

  async function revert() {
    if (!sessionId || !filename) return;
    await withBusy('Putting it back', async () => {
      const r = await apiFetch(`/api/gif/cutout/${sessionId}/${filename}/revert`, { method: 'POST' });
      const data = r.ok ? await r.json().catch(() => null) : null;
      if (!data?.url) throw new Error(data?.error || 'Nothing to put back');
      imageUrl = data.url;
      cut = false;
      result = null;
      batch = batch.map((b) =>
        b.sessionId === sessionId && b.filename === filename
          ? { ...b, url: bust(data.url), cut: false, error: undefined }
          : b);
    });
  }

  async function queueBatch(
    files: File[],
    first: { sessionId: string; filename: string; url: string },
  ) {
    // files[0] is already uploaded — it's the picture in the editor. Include it
    // as the first tile so the count matches what she picked; don't upload twice.
    const queued: BatchItem[] = [{
      sessionId: first.sessionId,
      filename: first.filename,
      name: files[0].name,
      url: bust(first.url),
      cut: false,
    }];
    batch = queued;
    if (files.length === 1) return;
    batchBusy = `Uploading ${files.length - 1}…`;
    try {
      for (const file of files.slice(1)) {
        const body = new FormData();
        body.append('file', file);
        body.append('sessionId', first.sessionId);
        const r = await apiFetch('/api/gif/upload-frame', { method: 'POST', body });
        const data = r.ok ? await r.json().catch(() => null) : null;
        if (!data?.frame?.filename) continue;
        queued.push({
          sessionId: data.sessionId,
          filename: data.frame.filename,
          name: file.name,
          url: bust(data.frame.url),
          cut: false,
        });
      }
      batch = [...queued];
    } finally {
      batchBusy = '';
    }
  }

  async function revertBatch() {
    if (!batch.length) return;
    error = '';
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      batchBusy = `Putting back ${i + 1} of ${batch.length}…`;
      try {
        const r = await apiFetch(`/api/gif/cutout/${item.sessionId}/${item.filename}/revert`, { method: 'POST' });
        const data = r.ok ? await r.json().catch(() => null) : null;
        const url = data?.url || `/api/gif/frame/${item.sessionId}/${item.filename}?t=${Date.now()}`;
        batch = batch.map((b, idx) => idx === i ? { ...b, url: bust(url), cut: false, error: undefined } : b);
        if (item.sessionId === sessionId && item.filename === filename) {
          imageUrl = url;
          cut = false;
          result = null;
        }
      } catch {
        // A frame that will not revert isn't worth stopping the rest for.
      }
    }
    batchBusy = '';
  }

  async function keyBatch() {
    if (!batch.length) return;
    error = '';
    const todo = batch.map((b, i) => ({ b, i })).filter(({ b }) => !b.cut);
    for (let n = 0; n < todo.length; n++) {
      const { b: item, i } = todo[n];
      batchBusy = `Keying ${n + 1} of ${todo.length}…`;
      try {
        const r = await apiFetch(`/api/gif/chroma-key/${item.sessionId}/${item.filename}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            color: keyColour,
            tolerance: tolerancePct / 100,
            blend: blendPct / 100,
            mode: greenScreen ? 'chroma' : 'color',
          }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error || 'Color key failed');
        const url = data?.url || `/api/gif/frame/${item.sessionId}/${item.filename}?t=${Date.now()}`;
        batch = batch.map((b, idx) => idx === i ? { ...b, url: bust(url), cut: true, error: undefined } : b);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Color key failed';
        batch = batch.map((b, idx) => idx === i ? { ...b, error: msg } : b);
      }
    }
    batchBusy = '';
  }

  function openInEditor(item: BatchItem) {
    sessionId = item.sessionId;
    filename = item.filename;
    imageUrl = item.url;
    cut = !!item.cut;
    result = null;
    error = '';
    strokes = [];
    crop = null;
    resetView();
  }

  // ── Cache-buster (kept once) ─────────────────────────────────────────
  function bust(u: string): string {
    return `${u.split('?')[0]}?t=${Date.now()}`;
  }

  // ── Color-pick from image ────────────────────────────────────────────
  function pickFromImage(event: MouseEvent) {
    if (!picking) return;
    const img = event.currentTarget as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    // object-contain letterboxes inside the element, so map through the DRAWN
    // area, not the element box.
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const offsetX = (rect.width - img.naturalWidth * scale) / 2;
    const offsetY = (rect.height - img.naturalHeight * scale) / 2;
    const x = Math.round((event.clientX - rect.left - offsetX) / scale);
    const y = Math.round((event.clientY - rect.top - offsetY) / scale);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      keyColour = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      picking = false;
    } catch {
      error = "Couldn't read that pixel — use the color box instead.";
      picking = false;
    }
  }

  // ── Screen ↔ image space ─────────────────────────────────────────────
  function toImagePoint(clientX: number, clientY: number) {
    const img = imageEl;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    if (!scale) return null;
    const offsetX = (rect.width - img.naturalWidth * scale) / 2;
    const offsetY = (rect.height - img.naturalHeight * scale) / 2;
    return {
      x: (clientX - rect.left - offsetX) / scale,
      y: (clientY - rect.top - offsetY) / scale,
      scale,
    };
  }

  function drawStrokes(list: Stroke[]) {
    const canvas = paintCanvas;
    const img = imageEl;
    if (!canvas || !img || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const offsetX = (rect.width - img.naturalWidth * scale) / 2;
    const offsetY = (rect.height - img.naturalHeight * scale) / 2;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of list) {
      ctx.strokeStyle = stroke.tool === 'restore' ? 'rgba(80,220,140,0.55)' : 'rgba(255,90,90,0.55)';
      ctx.lineWidth = Math.max(1, stroke.width * scale);
      ctx.beginPath();
      stroke.points.forEach((point, i) => {
        const x = point.x * scale + offsetX;
        const y = point.y * scale + offsetY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // A single tap draws a dot, not a zero-length line.
      if (stroke.points.length === 1) {
        ctx.lineTo(stroke.points[0].x * scale + offsetX + 0.1, stroke.points[0].y * scale + offsetY);
      }
      ctx.stroke();
    }
  }

  function updateLoupe(clientX: number, clientY: number) {
    const point = toImagePoint(clientX, clientY);
    const box = viewportEl?.getBoundingClientRect();
    if (!point || !box || !point.scale) return;
    loupe = {
      x: point.x,
      y: point.y,
      // Always three times the unzoomed view — loupe stays useful at any zoom.
      scale: (point.scale / zoom) * 3,
      side: clientX - box.left < box.width / 2 ? 'right' : 'left',
    };
  }

  function startStroke(e: PointerEvent) {
    if (!painting || pointersDown.size > 1) return;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const point = toImagePoint(e.clientX, e.clientY);
    if (!point) return;
    activeStroke = { tool, width: brush, points: [{ x: point.x, y: point.y }] };
    strokes = [...strokes, activeStroke];
    updateLoupe(e.clientX, e.clientY);
  }

  function extendStroke(e: PointerEvent) {
    if (!painting || !activeStroke) return;
    const point = toImagePoint(e.clientX, e.clientY);
    if (!point) return;
    activeStroke.points.push({ x: point.x, y: point.y });
    // Swap the last stroke reference so Svelte reruns the effect that redraws.
    strokes = [...strokes.slice(0, -1), { ...activeStroke, points: [...activeStroke.points] }];
    updateLoupe(e.clientX, e.clientY);
  }

  function endStroke() { activeStroke = null; loupe = null; }

  function cancelStroke() {
    if (!activeStroke) return;
    activeStroke = null;
    loupe = null;
    strokes = strokes.slice(0, -1);
  }

  // ── Pinch-zoom / pan ────────────────────────────────────────────────
  function gestureDown(e: PointerEvent) {
    pointersDown.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersDown.size !== 2) return;
    cancelStroke();
    const [a, b] = [...pointersDown.values()];
    gesture = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom,
      pan: { ...pan },
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  function gestureMove(e: PointerEvent) {
    if (!pointersDown.has(e.pointerId)) return;
    pointersDown.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture || pointersDown.size < 2) return;
    const [a, b] = [...pointersDown.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const next = Math.min(6, Math.max(1, gesture.zoom * (dist / gesture.dist)));
    zoom = next;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    pan = next <= 1.001
      ? { x: 0, y: 0 }
      : { x: gesture.pan.x + (cx - gesture.cx), y: gesture.pan.y + (cy - gesture.cy) };
  }

  function gestureUp(e: PointerEvent) {
    pointersDown.delete(e.pointerId);
    if (pointersDown.size < 2) gesture = null;
  }

  function resetView() { zoom = 1; pan = { x: 0, y: 0 }; }

  // ── Crop ─────────────────────────────────────────────────────────────
  function cropDown(e: PointerEvent) {
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p || !natural.w) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const grab = Math.max(natural.w, natural.h) * 0.07;
    if (crop) {
      const near = (cx: number, cy: number) => Math.abs(p.x - cx) < grab && Math.abs(p.y - cy) < grab;
      if (near(crop.x, crop.y)) { cropDrag = 'nw'; return; }
      if (near(crop.x + crop.w, crop.y)) { cropDrag = 'ne'; return; }
      if (near(crop.x, crop.y + crop.h)) { cropDrag = 'sw'; return; }
      if (near(crop.x + crop.w, crop.y + crop.h)) { cropDrag = 'se'; return; }
    }
    cropDrag = 'new';
    cropAnchor = { x: p.x, y: p.y };
    crop = { x: p.x, y: p.y, w: 0, h: 0 };
  }

  function cropMove(e: PointerEvent) {
    const drag = cropDrag;
    if (!drag) return;
    const p = toImagePoint(e.clientX, e.clientY);
    if (!p) return;
    const cx = Math.max(0, Math.min(p.x, natural.w));
    const cy = Math.max(0, Math.min(p.y, natural.h));
    if (drag === 'new') {
      const a = cropAnchor;
      if (!a) return;
      crop = { x: Math.min(a.x, cx), y: Math.min(a.y, cy), w: Math.abs(cx - a.x), h: Math.abs(cy - a.y) };
      return;
    }
    if (!crop) return;
    let { x, y, w, h } = crop;
    const right = x + w;
    const bottom = y + h;
    if (drag === 'nw' || drag === 'sw') { x = Math.min(cx, right); w = right - x; }
    if (drag === 'ne' || drag === 'se') { w = Math.max(0, cx - x); }
    if (drag === 'nw' || drag === 'ne') { y = Math.min(cy, bottom); h = bottom - y; }
    if (drag === 'sw' || drag === 'se') { h = Math.max(0, cy - y); }
    crop = { x, y, w, h };
  }

  function cropUp() { cropDrag = null; cropAnchor = null; }

  function squareCrop() {
    if (!natural.w || !natural.h) return;
    const side = Math.min(natural.w, natural.h);
    crop = { x: (natural.w - side) / 2, y: (natural.h - side) / 2, w: side, h: side };
  }

  async function applyCrop(all = false) {
    if (!sessionId || !filename || !crop || crop.w < 2 || crop.h < 2) return;
    const box = crop;
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const width = Math.max(1, Math.round(Math.min(box.w, natural.w - x)));
    const height = Math.max(1, Math.round(Math.min(box.h, natural.h - y)));
    await withBusy('Cropping', async () => {
      const r = await apiFetch(`/api/gif/crop/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, width, height, ...(all ? {} : { filename }) }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || 'Crop failed');
      // A count of zero is "ok" from the route but means it matched no frames.
      if (!data?.croppedFrames) throw new Error('Nothing was cropped — the session had no frames to cut.');
      // Same paths, different pixels. Cache-bust everything that could be showing.
      imageUrl = imageUrl ? bust(imageUrl) : imageUrl;
      batch = batch.map((b) =>
        all || (b.sessionId === sessionId && b.filename === filename)
          ? { ...b, url: bust(b.url) }
          : b);
      // Strokes were painted against the old frame — their coords are now lies.
      strokes = [];
      crop = null;
      cropping = false;
      resetView();
    });
  }

  // ── Paint ────────────────────────────────────────────────────────────
  async function strokeMask(which: 'restore' | 'erase'): Promise<Blob | null> {
    const img = imageEl;
    const mine = strokes.filter((s) => s.tool === which);
    if (!img || mine.length === 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    for (const s of mine) {
      ctx.lineWidth = Math.max(1, s.width);
      ctx.beginPath();
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y);
      ctx.stroke();
    }
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  async function applyPaint() {
    if (!sessionId || !filename || strokes.length === 0) return;
    await withBusy('Painting', async () => {
      const [restoreMask, eraseMask] = await Promise.all([strokeMask('restore'), strokeMask('erase')]);
      const body = new FormData();
      if (restoreMask) body.append('restore', restoreMask, 'restore.png');
      if (eraseMask) body.append('erase', eraseMask, 'erase.png');

      const r = await apiFetch(`/api/gif/mask-paint/${sessionId}/${filename}`, { method: 'POST', body });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || 'Painting failed');
      imageUrl = data.url;
      strokes = [];
      cut = true;
      result = null;
    });
  }

  function undoStroke() { strokes = strokes.slice(0, -1); }
  function clearStrokes() { strokes = []; }

  // ── Save-as ──────────────────────────────────────────────────────────
  async function exportStill() {
    if (!sessionId || !filename) return;
    const chosen = PRESETS.find((p) => p.id === preset) ?? PRESETS[2];
    await withBusy('Exporting', async () => {
      const r = await apiFetch(`/api/gif/still-export/${sessionId}/${filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          maxSide: chosen.maxSide,
          maxBytes: chosen.maxBytes,
          padSquare: chosen.padSquare,
        }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || 'Export failed');
      result = data;
      showToast(`Saved · ${readableSize(data.bytes)}`, 'success');
    });
  }

  function readableSize(bytes?: number): string {
    if (!bytes) return '';
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  }

  // ── File input change (bulk-friendly) ────────────────────────────────
  async function onFilesChosen(event: Event) {
    const el = event.currentTarget as HTMLInputElement;
    const picked = Array.from(el.files || []);
    el.value = '';
    if (!picked.length) return;
    batch = [];
    // First goes into the editor so she can sample the color on a real picture;
    // the rest wait for that same color.
    const session = await pickImage(picked[0]);
    if (picked.length > 1 && session) await queueBatch(picked, session);
  }
</script>

{#if engine && !engine.ready}
  <div class="cutout-warn workspace-card">
    <span class="warn-icon">⚠️</span>
    <div>
      <div class="warn-title">Background removal isn't set up</div>
      <p class="warn-body">{engine.reason}</p>
      <p class="warn-body">The exporter and color-key below still work — they just won't cut anything out.</p>
    </div>
  </div>
{/if}

<!-- Image picker + viewport -->
<section class="workspace-card cutout-image">
  <div class="row-label">Image</div>
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="hidden"
    onchange={onFilesChosen}
  />
  <button class="primary btn-fill" onclick={() => fileInput?.click()}>
    {imageUrl ? 'Choose another' : 'Choose an image'}
  </button>

  {#if imageUrl}
    <!-- Checkerboard so transparency reads as transparency, not as whatever
         color the panel happens to be. -->
    <div class="viewer-frame">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={viewportEl}
        class="viewport"
        class:touch-none={painting || zoom > 1}
        role="application"
        aria-label="Image viewport — pinch to zoom, drag to pan"
        onpointerdown={gestureDown}
        onpointermove={gestureMove}
        onpointerup={gestureUp}
        onpointercancel={gestureUp}
      >
        <div class="transform-layer" style="transform: translate({pan.x}px, {pan.y}px) scale({zoom}); transform-origin: center center;">
          {#if painting && ghost && ghostOk && ghostUrl && cut}
            <img
              src={ghostUrl}
              alt=""
              aria-hidden="true"
              onerror={() => (ghostOk = false)}
              style="opacity: {GHOST_OPACITY}"
              class="ghost-layer"
            />
          {/if}
          <!-- Clicking the image samples a color for the key. The color-input
               well beside it is the keyboard-accessible equivalent, so this
               tap is a shortcut, not the only path. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <img
            bind:this={imageEl}
            src={imageUrl}
            alt=""
            crossorigin="anonymous"
            onclick={pickFromImage}
            onload={(e) => { const t = e.currentTarget as HTMLImageElement; natural = { w: t.naturalWidth, h: t.naturalHeight }; drawStrokes(strokes); }}
            class="work-image"
            class:pick={picking}
          />
          <canvas
            bind:this={paintCanvas}
            onpointerdown={startStroke}
            onpointermove={extendStroke}
            onpointerup={endStroke}
            onpointercancel={endStroke}
            class="paint-canvas"
            class:paint-active={painting}
          ></canvas>

          {#if cropping && natural.w > 0}
            {@const l = crop ? (crop.x / natural.w) * 100 : 0}
            {@const t = crop ? (crop.y / natural.h) * 100 : 0}
            {@const w = crop ? (crop.w / natural.w) * 100 : 0}
            {@const h = crop ? (crop.h / natural.h) * 100 : 0}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="crop-surface"
              role="application"
              aria-label="Crop area — drag a box, drag corners to resize"
              onpointerdown={cropDown}
              onpointermove={cropMove}
              onpointerup={cropUp}
              onpointercancel={cropUp}
            >
              {#if crop && crop.w > 0 && crop.h > 0}
                <div class="crop-shade" style="top: 0; height: {t}%;"></div>
                <div class="crop-shade" style="top: {t + h}%; bottom: 0;"></div>
                <div class="crop-shade" style="left: 0; width: {l}%; top: {t}%; height: {h}%;"></div>
                <div class="crop-shade" style="left: {l + w}%; right: 0; top: {t}%; height: {h}%;"></div>
                <div class="crop-box" style="left: {l}%; top: {t}%; width: {w}%; height: {h}%;"></div>
                {#each [[l, t], [l + w, t], [l, t + h], [l + w, t + h]] as [hx, hy]}
                  <div class="crop-handle" style="left: {hx}%; top: {hy}%;"></div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>

        {#if painting && loupe && natural.w > 0}
          <div
            class="loupe"
            style="{loupe.side === 'left' ? 'left: 6px;' : 'right: 6px;'} width: {LOUPE}px; height: {LOUPE}px;"
          >
            {#if ghost && ghostOk && ghostUrl && cut}
              <div
                class="loupe-layer"
                style="opacity: {GHOST_OPACITY};
                       background-image: url({ghostUrl});
                       background-size: {natural.w * loupe.scale}px {natural.h * loupe.scale}px;
                       background-position: {LOUPE / 2 - loupe.x * loupe.scale}px {LOUPE / 2 - loupe.y * loupe.scale}px;"
              ></div>
            {/if}
            <div
              class="loupe-layer"
              style="background-image: url({imageUrl});
                     background-size: {natural.w * loupe.scale}px {natural.h * loupe.scale}px;
                     background-position: {LOUPE / 2 - loupe.x * loupe.scale}px {LOUPE / 2 - loupe.y * loupe.scale}px;"
            ></div>
            <div
              class="loupe-brush"
              style="left: {LOUPE / 2 - (brush * loupe.scale) / 2}px;
                     top: {LOUPE / 2 - (brush * loupe.scale) / 2}px;
                     width: {Math.max(4, brush * loupe.scale)}px;
                     height: {Math.max(4, brush * loupe.scale)}px;
                     border-color: {tool === 'restore' ? 'rgba(80,220,140,0.95)' : 'rgba(255,90,90,0.95)'};"
            ></div>
            <div class="loupe-center" style="left: {LOUPE / 2 - 1.5}px; top: {LOUPE / 2 - 1.5}px;"></div>
          </div>
        {/if}
      </div>
    </div>

    <div class="zoom-row">
      <span class="row-label">Zoom</span>
      <input
        type="range" min={100} max={600} step={10} value={Math.round(zoom * 100)}
        oninput={(e) => { const n = Number((e.currentTarget as HTMLInputElement).value) / 100; zoom = n; if (n <= 1.001) pan = { x: 0, y: 0 }; }}
      />
      <span class="row-value">{zoom.toFixed(1)}×</span>
      <button class="btn-soft" onclick={resetView} disabled={zoom === 1 && pan.x === 0 && pan.y === 0}>Fit</button>
    </div>

    <div class="crop-controls">
      <button
        class="chip"
        class:active={cropping}
        onclick={() => { cropping = !cropping; crop = null; }}
      >
        ✂ Crop
      </button>
      {#if cropping}
        <button class="btn-soft" onclick={squareCrop}>Square</button>
        <button class="btn-soft" onclick={() => (crop = null)} disabled={!crop}>Clear</button>
        <button
          class="primary"
          onclick={() => applyCrop(false)}
          disabled={!!busy || !crop || crop.w < 2 || crop.h < 2}
        >
          ✓ Cut this one
        </button>
        {#if batch.length > 1}
          <button
            class="btn-soft"
            onclick={() => applyCrop(true)}
            disabled={!!busy || !crop || crop.w < 2 || crop.h < 2}
          >
            Cut all {batch.length}
          </button>
        {/if}
        <p class="hint full-row">
          {crop && crop.w > 1
            ? `${Math.round(crop.w)} × ${Math.round(crop.h)}`
            : 'Drag a box on the picture. Drag a corner to adjust it.'}
          {batch.length > 1 ? ' — Cut all uses the same box on every picture in the batch.' : ''}
        </p>
      {/if}
    </div>
  {/if}
</section>

<!-- Batch grid: every image queued after the first -->
{#if batch.length > 0}
  <section class="workspace-card cutout-batch">
    <div class="row-label">Batch · {batch.length} image{batch.length === 1 ? '' : 's'}</div>
    <p class="hint">
      {batch.every((b) => b.cut)
        ? 'Keyed. Tap any tile to save it.'
        : 'Set the color on the picture above, then key the rest with it.'}
    </p>
    <button
      class="primary btn-fill"
      onclick={keyBatch}
      disabled={!!batchBusy || !cut || batch.every((b) => b.cut)}
    >
      {batchBusy || (batch.every((b) => b.cut)
        ? 'All keyed'
        : `Key the other ${batch.filter((b) => !b.cut).length} with this color`)}
    </button>
    {#if batch.some((b) => b.cut)}
      <button class="btn-soft btn-fill" onclick={revertBatch} disabled={!!batchBusy}>↺ Put them all back</button>
    {/if}
    <div class="batch-grid">
      {#each batch as item (item.filename)}
        {@const isOpen = item.sessionId === sessionId && item.filename === filename}
        <button
          type="button"
          class="batch-tile"
          class:open={isOpen}
          onclick={() => openInEditor(item)}
        >
          <img src={item.url} alt={item.name} loading="lazy" />
          {#if item.cut}
            <a
              class="tile-save"
              href={item.url}
              download={item.name.replace(/\.[^.]+$/, '') + '-cutout.png'}
              onclick={(e) => e.stopPropagation()}
              aria-label="Download"
            >↓</a>
          {/if}
          {#if item.error}
            <span class="tile-error">{item.error}</span>
          {/if}
        </button>
      {/each}
    </div>
  </section>
{/if}

<!-- Remove background -->
{#if imageUrl}
  <section class="workspace-card cutout-remove">
    <div class="row-label">Remove background</div>
    <div class="mode-row">
      <button class="chip" class:active={mode === 'color'} onclick={() => (mode = 'color')}>By color</button>
      <button class="chip" class:active={mode === 'subject'} onclick={() => (mode = 'subject')}>Find subject</button>
    </div>

    {#if mode === 'color'}
      <div class="pick-row">
        <button
          class="chip"
          class:active={picking}
          onclick={() => (picking = !picking)}
        >
          🎯 {picking ? 'Tap the image…' : 'Pick from image'}
        </button>
        <input type="color" bind:value={keyColour} class="color-well" aria-label="Key color" />
        <span class="mono">{keyColour}</span>
      </div>

      <div class="slider-row">
        <span class="row-label short">Tolerance</span>
        <input type="range" min={1} max={80} step={1} bind:value={tolerancePct} />
        <span class="row-value">{tolerancePct}%</span>
      </div>
      <div class="slider-row">
        <span class="row-label short">Edge blend</span>
        <input type="range" min={0} max={50} step={1} bind:value={blendPct} />
        <span class="row-value">{blendPct}%</span>
      </div>
      <label class="check-row">
        <input type="checkbox" bind:checked={greenScreen} />
        Green-screen mode — for an actual green screen, not a flat backdrop
      </label>
    {:else}
      <div class="slider-row">
        <span class="row-label short">Edge softness</span>
        <input type="range" min={0} max={4} step={0.5} bind:value={feather} />
        <span class="row-value">{feather}px</span>
      </div>
      <label class="check-row">
        <input type="checkbox" bind:checked={hardEdge} />
        Solid subject — keep anything it recognised at all, no half-transparent fabric
      </label>
      {#if engine?.model}
        <p class="hint small">Model: {engine.model}</p>
      {/if}
    {/if}

    <div class="action-row">
      <button
        class="primary btn-fill"
        onclick={() => (mode === 'color' ? keyColourOut() : removeBackground())}
        disabled={!!busy || (mode === 'subject' && !engine?.ready)}
      >
        {busy || (cut ? 'Try again' : mode === 'color' ? 'Key this color' : 'Find the subject')}
      </button>
      {#if cut}
        <button class="btn-soft" onclick={revert} disabled={!!busy}>↺ Original</button>
      {/if}
    </div>
    {#if cut}
      <p class="hint small">Try again re-keys from the original, so the sliders never stack on an already-cut image.</p>
    {/if}
  </section>
{/if}

<!-- Fix by hand (paint) -->
{#if imageUrl}
  <section class="workspace-card cutout-paint">
    <div class="paint-header">
      <span class="row-label">Fix by hand</span>
      <button
        class="chip"
        class:active={painting}
        onclick={() => { painting = !painting; picking = false; }}
      >
        {painting ? '✕ Done' : '🖌 Paint'}
      </button>
    </div>

    {#if painting}
      <p class="hint">
        No model gets every picture right. Paint over what it got wrong — green brings it back,
        red takes it away. Only the transparency changes; the picture underneath is never touched.
      </p>
      <p class="hint small">
        Pinch with two fingers to zoom in, drag with two to move around — one finger always paints,
        so the gestures never collide. While you paint, a magnifier shows the spot under your hand
        in the opposite corner.
      </p>
      <div class="mode-row">
        <button class="chip restore" class:active={tool === 'restore'} onclick={() => (tool = 'restore')}>Bring back</button>
        <button class="chip erase" class:active={tool === 'erase'} onclick={() => (tool = 'erase')}>Take away</button>
      </div>
      {#if cut && ghostOk}
        <div class="ghost-row">
          <span class="hint">Show what was cut away</span>
          <button
            class="chip"
            class:active={ghost}
            onclick={() => (ghost = !ghost)}
          >{ghost ? '👁 On' : '⊘ Off'}</button>
        </div>
      {/if}
      <div class="slider-row">
        <span class="row-label short">Brush</span>
        <input type="range" min={6} max={120} step={2} bind:value={brush} />
        <span class="row-value">{brush}px</span>
      </div>
      <div class="action-row">
        <button
          class="primary btn-fill"
          onclick={applyPaint}
          disabled={!!busy || strokes.length === 0}
        >
          ✓ Apply {strokes.length > 0 ? `(${strokes.length})` : ''}
        </button>
        <button class="btn-soft" onclick={undoStroke} disabled={strokes.length === 0}>↶ Undo</button>
        <button class="btn-soft" onclick={clearStrokes} disabled={strokes.length === 0}>Clear</button>
      </div>
    {:else}
      <p class="hint small">Paint the transparency yourself when the model misses an arm.</p>
    {/if}
  </section>
{/if}

<!-- Save as -->
{#if imageUrl}
  <section class="workspace-card cutout-save">
    <div class="row-label">Save as</div>
    <div class="preset-row">
      {#each PRESETS as p}
        <button
          class="preset-tile"
          class:active={preset === p.id}
          onclick={() => (preset = p.id)}
        >
          <span class="preset-label">{p.label}</span>
          <span class="preset-hint">{p.hint}</span>
        </button>
      {/each}
    </div>

    <div class="mode-row">
      <button class="chip" class:active={format === 'png'} onclick={() => (format = 'png')}>PNG (Discord)</button>
      <button class="chip" class:active={format === 'webp'} onclick={() => (format = 'webp')}>WebP (smaller)</button>
    </div>

    <button class="btn-soft btn-fill" onclick={exportStill} disabled={!!busy}>
      ⬇ {busy === 'Exporting' ? 'Exporting…' : 'Export'}
    </button>

    {#if result}
      <a class="result-link" href={result.url} download={result.filename}>
        <span class="arrow">⬇</span>
        <span class="result-body">
          <span class="result-head">Tap to save</span>
          <span class="result-meta">
            {result.filename} · {result.width}×{result.height} · {readableSize(result.bytes)}
            {result.colors ? ` · ${result.colors} colors` : ''}
          </span>
        </span>
      </a>
      {#if result.withinBudget === false}
        <p class="hint small">Still over the cap even at 32 colors — try a smaller preset.</p>
      {/if}
    {/if}
  </section>
{/if}

{#if error}
  <p class="cutout-error">{error}</p>
{/if}

<style>
  /* Everything here follows the Studio drawer's calm palette — dark neutrals,
     accent for active state, quiet type, big tap targets. The drawer's
     .workspace-card rule is component-scoped and can't reach us, so the card
     chrome is restated here verbatim to keep spacing lined up with the other
     tabs. */
  .workspace-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); padding: .8rem; margin-bottom: .75rem; display: grid; gap: .7rem; }

  .hidden { display: none; }
  .full-row { grid-column: 1 / -1; width: 100%; }
  .btn-fill { width: 100%; }

  .row-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted, rgba(255, 255, 255, 0.55));
  }
  .row-label.short { min-width: 76px; font-size: 11px; letter-spacing: 0.04em; text-transform: none; font-weight: 500; }
  .row-value {
    min-width: 44px;
    text-align: right;
    font-size: 11px;
    color: var(--muted, rgba(255, 255, 255, 0.55));
    font-variant-numeric: tabular-nums;
  }

  .primary {
    background: var(--accent, #a97cff);
    color: #0b0b0d;
    border: 0;
    padding: 12px 14px;
    border-radius: 12px;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }
  .primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-soft {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.14));
    color: var(--muted, rgba(255, 255, 255, 0.75));
    padding: 8px 12px;
    border-radius: 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .btn-soft:disabled { opacity: 0.4; cursor: not-allowed; }

  .chip {
    background: transparent;
    border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.14));
    color: var(--muted, rgba(255, 255, 255, 0.85));
    padding: 8px 12px;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .chip.active { border-color: var(--accent, #a97cff); color: #fff; }
  .chip.restore.active { border-color: rgba(80, 220, 140, 0.9); }
  .chip.erase.active { border-color: rgba(255, 90, 90, 0.9); }

  .hint { font-size: 12px; color: var(--muted, rgba(255, 255, 255, 0.55)); line-height: 1.4; margin: 6px 0 0; }
  .hint.small { font-size: 10px; }
  .mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted, rgba(255, 255, 255, 0.6)); }

  /* Viewport */
  .viewer-frame {
    margin-top: 10px;
    padding: 8px;
    border-radius: 12px;
    background-image:
      linear-gradient(45deg, rgba(128, 128, 128, 0.28) 25%, transparent 25%, transparent 75%, rgba(128, 128, 128, 0.28) 75%),
      linear-gradient(45deg, rgba(128, 128, 128, 0.28) 25%, transparent 25%, transparent 75%, rgba(128, 128, 128, 0.28) 75%);
    background-size: 16px 16px;
    background-position: 0 0, 8px 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .viewport {
    position: relative;
    overflow: hidden;
    max-width: 100%;
  }
  .viewport.touch-none { touch-action: none; }
  .transform-layer { position: relative; display: inline-block; }
  .ghost-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
    z-index: 0;
  }
  .work-image {
    position: relative;
    z-index: 10;
    max-height: 46vh;
    width: auto;
    object-fit: contain;
    display: block;
  }
  .work-image.pick { cursor: crosshair; }
  .paint-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 20;
    pointer-events: none;
  }
  .paint-canvas.paint-active {
    pointer-events: auto;
    touch-action: none;
  }

  /* Crop overlay */
  .crop-surface {
    position: absolute;
    inset: 0;
    z-index: 30;
    touch-action: none;
    cursor: crosshair;
  }
  .crop-shade { position: absolute; background: rgba(0, 0, 0, 0.55); pointer-events: none; left: 0; right: 0; }
  .crop-box { position: absolute; border: 2px solid var(--accent, #a97cff); pointer-events: none; }
  .crop-handle {
    position: absolute;
    width: 12px;
    height: 12px;
    transform: translate(-50%, -50%);
    border: 2px solid #fff;
    border-radius: 999px;
    background: var(--accent, #a97cff);
    pointer-events: none;
  }
  .crop-controls {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  /* Magnifier loupe */
  .loupe {
    position: absolute;
    top: 6px;
    z-index: 25;
    overflow: hidden;
    border-radius: 999px;
    border: 2px solid var(--accent, #a97cff);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    background-image:
      linear-gradient(45deg, rgba(128, 128, 128, 0.3) 25%, transparent 25%, transparent 75%, rgba(128, 128, 128, 0.3) 75%),
      linear-gradient(45deg, rgba(128, 128, 128, 0.3) 25%, transparent 25%, transparent 75%, rgba(128, 128, 128, 0.3) 75%);
    background-size: 10px 10px;
    background-position: 0 0, 5px 5px;
    pointer-events: none;
  }
  .loupe-layer {
    position: absolute;
    inset: 0;
    background-repeat: no-repeat;
  }
  .loupe-brush {
    position: absolute;
    border: 1px solid;
    border-radius: 999px;
  }
  .loupe-center {
    position: absolute;
    width: 3px;
    height: 3px;
    background: #fff;
    border-radius: 999px;
  }

  /* Zoom row */
  .zoom-row {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .zoom-row input[type='range'] { flex: 1; accent-color: var(--accent, #a97cff); }

  /* Remove-background */
  .cutout-remove .mode-row { margin-top: 8px; display: flex; gap: 8px; }
  .cutout-remove .mode-row .chip { flex: 1; justify-content: center; }
  .pick-row { margin-top: 12px; display: flex; align-items: center; gap: 10px; }
  .color-well { width: 42px; height: 34px; border: 0; background: transparent; padding: 0; }
  .slider-row {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .slider-row input[type='range'] { flex: 1; accent-color: var(--accent, #a97cff); }
  .check-row {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--muted, rgba(255, 255, 255, 0.75));
  }
  .action-row { margin-top: 14px; display: flex; align-items: center; gap: 8px; }

  /* Batch */
  .cutout-batch .batch-grid {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .batch-tile {
    position: relative;
    aspect-ratio: 1 / 1;
    border-radius: 12px;
    border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.14));
    overflow: hidden;
    background-image:
      linear-gradient(45deg, rgba(127, 127, 127, 0.16) 25%, transparent 25%, transparent 75%, rgba(127, 127, 127, 0.16) 75%),
      linear-gradient(45deg, rgba(127, 127, 127, 0.16) 25%, transparent 25%, transparent 75%, rgba(127, 127, 127, 0.16) 75%);
    background-size: 14px 14px;
    background-position: 0 0, 7px 7px;
    padding: 0;
    cursor: pointer;
  }
  .batch-tile.open {
    border-color: var(--accent, #a97cff);
    box-shadow: 0 0 0 2px rgba(169, 124, 255, 0.34);
  }
  .batch-tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .tile-save {
    position: absolute;
    right: 4px;
    bottom: 4px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    padding: 3px 7px;
    border-radius: 999px;
    text-decoration: none;
    font-size: 12px;
    backdrop-filter: blur(2px);
  }
  .tile-error {
    position: absolute;
    left: 4px; right: 4px; bottom: 4px;
    background: rgba(85, 10, 10, 0.85);
    color: #fecaca;
    padding: 2px 4px;
    border-radius: 4px;
    font-size: 9px;
  }

  /* Paint */
  .cutout-paint .paint-header { display: flex; align-items: center; justify-content: space-between; }
  .cutout-paint .mode-row { margin-top: 10px; display: flex; gap: 8px; }
  .cutout-paint .mode-row .chip { flex: 1; justify-content: center; }
  .ghost-row { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }

  /* Save */
  .preset-row { margin-top: 10px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .preset-tile {
    text-align: left;
    padding: 10px;
    border-radius: 12px;
    border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.14));
    background: transparent;
    cursor: pointer;
    color: inherit;
  }
  .preset-tile.active { border-color: var(--accent, #a97cff); }
  .preset-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-main, rgba(255, 255, 255, 0.92)); }
  .preset-hint { display: block; font-size: 10px; color: var(--muted, rgba(255, 255, 255, 0.55)); }
  .cutout-save .mode-row { margin-top: 10px; display: flex; gap: 8px; }
  .cutout-save .mode-row .chip { flex: 1; justify-content: center; }
  .cutout-save .btn-fill { margin-top: 10px; }

  .result-link {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.14));
    color: inherit;
    text-decoration: none;
  }
  .result-link:active { transform: scale(0.99); }
  .result-link .arrow { font-size: 18px; flex-shrink: 0; }
  .result-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .result-head { font-weight: 600; font-size: 12px; }
  .result-meta {
    font-size: 11px;
    color: var(--muted, rgba(255, 255, 255, 0.55));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Engine warning */
  .cutout-warn { display: flex; align-items: flex-start; gap: 10px; }
  .warn-icon { flex-shrink: 0; font-size: 15px; }
  .warn-title { font-size: 12px; font-weight: 600; color: var(--text-main, rgba(255, 255, 255, 0.92)); }
  .warn-body { margin-top: 4px; font-size: 11px; color: var(--muted, rgba(255, 255, 255, 0.6)); line-height: 1.4; }

  .cutout-error {
    text-align: center;
    font-size: 12px;
    color: #f87171;
    margin: 10px 0 0;
  }

  /* Section spacing to match the drawer's other tabs */
  section + section { margin-top: 10px; }
</style>
