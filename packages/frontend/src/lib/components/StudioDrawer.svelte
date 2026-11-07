<!-- Adapted for byte-light under Apache 2.0:
     • Drawer shell follows byte-light's StarredDrawer pattern (no shared Drawer.svelte here)
     • apiFetch instead of bare fetch; showToast instead of pushToast
     • Gallery jump exposed as an `onopen` callback (chat page owns the scroll logic)
     • Native <select> replaces reference implementation's MindDropdown (byte-light has no such component)
     • ConfirmDialog prop is `destructive` (byte-light's name for reference implementation's `danger`)
     • Identity scrub: default drawers are companion-a 🔷 / companion-b 🔶 / user 🖤 -->
<script lang="ts">
  import StickerManager from './StickerManager.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import InputModal from './InputModal.svelte';
  import CutoutTab from './CutoutTab.svelte';
  import { apiFetch } from '$lib/utils/api';
  import { showToast } from '$lib/stores/toast.svelte';

  interface Props {
    open: boolean;
    onclose?: () => void;
    /** Focus a gallery image's message in its thread (chat page owns the scroll logic). */
    onopen?: (threadId: string, messageId: string) => void;
  }

  let { open = $bindable(false), onclose, onopen }: Props = $props();

  type Tab = 'generate' | 'gallery' | 'edit' | 'sketch' | 'gif' | 'cutout' | 'settings' | 'references' | 'stickers';
  let tab = $state<Tab>('generate');
  let tabBar = $state<HTMLElement>();

  // Scroll the active tab into view when the tab changes so it's never hidden past the edge fade.
  $effect(() => {
    tab; // track
    tabBar?.querySelector<HTMLElement>('.filter-btn.active')
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });

  interface Settings {
    enabled: boolean;
    backend: 'codex' | 'openai' | 'cloudflare' | 'antigravity' | 'openart';
    size: 'square' | 'portrait' | 'landscape';
    quality: 'auto' | 'low' | 'medium' | 'high';
    openaiModel: string;
    monthlyBudgetUsd: number;
    hasOpenaiKey: boolean;
    antigravityModel?: string;
    openartModel?: string;
  }

  const SIZE_OPTS = [
    { value: 'square', label: '1:1 · Square' },
    { value: 'portrait', label: '2:3 · Portrait' },
    { value: 'landscape', label: '3:2 · Landscape' },
    { value: '16:9', label: '16:9 · Widescreen' }, { value: '9:16', label: '9:16 · Vertical' },
    { value: '21:9', label: '21:9 · Ultrawide' }, { value: '2:3', label: '2:3' },
    { value: '3:2', label: '3:2' }, { value: '4:5', label: '4:5' }, { value: '5:4', label: '5:4' },
    { value: 'custom', label: 'Custom' },
  ];
  const PROVIDERS = ['codex', 'openai', 'cloudflare', 'antigravity', 'openart'] as const;
  const MODELS: Record<string, Array<{ value: string; label: string }>> = {
    codex: [{ value: 'gpt-5.4', label: 'GPT-5.4' }, { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }],
    openai: [{ value: 'gpt-image-2', label: 'GPT Image 2' }, { value: 'gpt-image-1.5', label: 'GPT Image 1.5' }],
    cloudflare: [{ value: '@cf/black-forest-labs/flux-1-schnell', label: 'Flux Schnell' }, { value: '@cf/black-forest-labs/flux-2-klein-4b', label: 'Flux Klein 4B' }, { value: '@cf/black-forest-labs/flux-2-dev', label: 'Flux 2 Dev' }],
    antigravity: [{ value: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash' }, { value: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro' }],
    openart: [{ value: 'nano-banana-2-lite', label: 'Nano Banana 2 Lite' }, { value: 'gpt-image-2', label: 'GPT Image 2' }, { value: 'pixverseV6', label: 'PixVerse V6 · video' }],
  };
  const STYLES = [
    { name: 'None', prompt: '' }, { name: 'Photorealistic', prompt: 'photorealistic, cinematic lighting, professional photography' },
    { name: 'Painterly', prompt: 'lush painterly style, visible brushstrokes and rich texture' },
    { name: 'Watercolor', prompt: 'soft watercolor, delicate washes and paper texture' },
    { name: 'Comic', prompt: 'bold comic-book inks and vibrant color' }, { name: 'Pixel Art', prompt: 'retro pixel art with a limited palette' },
    { name: 'Gothic', prompt: 'dark gothic atmosphere, ornate detail and dramatic shadow' }, { name: 'Minimalist', prompt: 'minimalist composition, clean lines and limited palette' },
  ];
  const QUALITY_OPTS = [
    { value: 'auto', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];
  const ENGINE_HINTS: Record<Settings['backend'], string> = {
    codex: 'Rides your ChatGPT subscription — no per-image cost. Size and quality aren\'t pinned here — just ask for a shape, or leave it to us (like the GPT app).',
    openai: 'Metered OpenAI API — a few cents per image.',
    cloudflare: 'Cloudflare Flux via the ImageGen MCP — set its endpoint to enable.',
    antigravity: 'Antigravity · Gemini via the agy CLI — rides that subscription.',
    openart: 'OpenArt — its own service (not OpenAI), authorized via the OpenArt MCP; metered in OpenArt credits.',
  };

  let settings = $state<Settings | null>(null);
  let monthlySpend = $state(0);
  let apiKeyInput = $state('');
  let budgetInput = $state('');
  let saving = $state(false);

  type RefItem = { filename: string; url: string };
  type DrawerT = { slug: string; label: string; isDefault: boolean; emoji?: string; refs: RefItem[] };
  let drawers = $state<DrawerT[]>([]);

  const MARKERS: Record<string, string> = { 'companion-a': '🔷', 'companion-b': '🔶', user: '🖤' };
  function markerFor(d: DrawerT): string {
    if (d.isDefault) return MARKERS[d.slug] ?? '';
    return d.emoji ?? '';
  }

  type GalleryItem = {
    filename: string; url: string; createdAt: string;
    messageId: string | null; threadId: string | null; threadName: string | null;
    mediaType?: 'image' | 'video'; prompt?: string | null; model?: string | null; backend?: string | null;
    width?: number | null; height?: number | null; folderId?: string | null; aspectRatio?: string | null; references?: string[] | null;
  };
  type Job = { id: string; status: 'pending' | 'running' | 'completed' | 'failed'; prompt: string; error?: string | null; url?: string; mediaType?: 'image' | 'video' };
  type Folder = { id: string; name: string };
  let gallery = $state<GalleryItem[]>([]);
  let jobs = $state<Job[]>([]);
  let folders = $state<Folder[]>([]);
  let prompt = $state(''); let provider = $state<string>('codex'); let model = $state('gpt-5.4'); let hydrateProviderOnLoad = false; let settingsLoadId = 0;
  let renderSize = $state('square'); let customWidth = $state(1024); let customHeight = $state(1024);
  let style = $state('None'); let selectedSubjects = $state<string[]>([]); let generating = $state(false); let enhancing = $state(false);
  let oneOffRefs = $state<Array<{ token: string; name: string }>>([]);
  let folderFilter = $state(''); let refFilter = $state(''); let newFolderName = $state('');
  let editZoom = $state(1); let editRotate = $state(0); let editBrightness = $state(100); let editContrast = $state(100); let editHue = $state(0);
  let editCrop = $state('1'); let editorCanvas = $state<HTMLCanvasElement>(); let sketchCanvas = $state<HTMLCanvasElement>();
  let drawTool = $state<'brush' | 'eraser'>('brush'); let drawColor = $state('#ffffff'); let brushSize = $state(8); let drawing = false; let sketchHistory = $state<string[]>([]);
  let selectedEdit = $state<GalleryItem | null>(null); let downloadCounter = $state(1);
  const filteredGallery = $derived(gallery.filter((g) => (!folderFilter || g.folderId === folderFilter) && (!refFilter || g.references?.includes(refFilter))));
  let previewItem = $state<GalleryItem | null>(null);
  let uploadingFor = $state<string | null>(null);
  const fileInputs: Record<string, HTMLInputElement> = {};

  // ── GIF Studio ──────────────────────────────────────────────────────
  type GifFrame = { filename: string; url: string };
  let gifSessionId = $state('');
  let gifFrames = $state<GifFrame[]>([]);
  let gifSelected = $state<number[]>([]);
  let gifActive = $state(0);
  let gifBusy = $state('');
  let gifError = $state('');
  let gifFps = $state(10);
  let gifMaxFrames = $state(100);
  let gifPlaying = $state(false);
  let gifOutputUrl = $state('');
  let gifOutputFilename = $state('');
  let gifOutputBytes = $state(0);
  let gifOutputKb = $state(0);
  let gifOutputOk = $state(false);
  let gifOutputTargetKb = $state<number | null>(null); // set when a Discord byte target was requested
  let gifOutputTargetBytes = $state<number | null>(null);
  let gifOutputFitMet = $state<boolean | null>(null);
  let gifOutputFormat = $state('gif'); // 'gif' | 'apng' — keep-colors stickers export real APNG
  let gifOutputW = $state(0); let gifOutputH = $state(0); // actual rendered dimensions, from the backend
  let gifOutputNotes = $state<string[]>([]); // adjustments the backend reports (auto-fit, oversize, …)
  // The pristine render — Optimize and Speed always work from this, never from
  // their own previous output, so repeated passes can't compound quality loss
  // or shrink the GIF a second time (the 320→288→259→233 spiral).
  let gifRenderFilename = $state(''); let gifRenderW = $state(0); let gifRenderH = $state(0);
  // A speed-adjusted copy of the render. Optimize starts here so re-timing
  // survives it; Speed itself always starts from the pristine render so
  // "Apply 2×" stays 2× no matter how many times it's tapped.
  let gifTimedFilename = $state('');
  let gifCropX = $state(0); let gifCropY = $state(0); let gifCropW = $state(256); let gifCropH = $state(256);
  let gifChromaColor = $state('#00ff00'); let gifChromaTolerance = $state(0.3); let gifChromaBlend = $state(0.1);
  let gifGreenScreen = $state(false); // chromakey (YUV) for real footage; colorkey (RGB) for flat generated fills
  let gifOutputWidth = $state(0); let gifOutputHeight = $state(0); let gifSpeed = $state(1);
  let gifColors = $state(256); let gifLossy = $state(0); let gifDither = $state(true);
  let gifAutoFit = $state(false); // explicit permission to cut colors / raise lossy to hit the byte target
  // Discord's own walls, taken whole from GIF Lab upstream: emoji cap 256KB at
  // 128 square, stickers 512KB at 320 square. The output size decides the lane —
  // the button name, the help text, and the byte budget all follow it together.
  function discordLaneFor(width: number, height: number): { name: string | null; maxBytes: number } {
    if (!width || !height) return { name: null, maxBytes: 512 * 1024 };
    if (width === 320 && height === 320) return { name: 'Discord Sticker', maxBytes: 512 * 1024 };
    if (width <= 128 && height <= 128) return { name: 'Discord Emoji', maxBytes: 256 * 1024 };
    return { name: null, maxBytes: 512 * 1024 };
  }
  const gifLane = $derived(discordLaneFor(gifOutputWidth, gifOutputHeight));
  let gifPreserveColors = $state(false); let gifGalleryFilename = $state('');
  let gifToolsReady = $state<boolean | null>(null); let gifToolsReason = $state('');
  let gifCaption = $state(''); let gifTextPosition = $state('bottom'); let gifFontSize = $state(24);
  let gifFontColor = $state('#ffffff'); let gifBorderColor = $state('#000000'); let gifFontFamily = $state('DejaVu Sans');
  let gifFonts = $state<string[]>(['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif']);
  let gifDropDuplicates = $state(true); let gifRemoveFrames = $state(0); let gifOptimizeScale = $state(100);
  let gifPreviewTimer: ReturnType<typeof setInterval> | undefined;
  const gifActiveFrame = $derived(gifFrames[gifActive]);
  const gifOutputOverKb = $derived(gifOutputTargetBytes === null ? 0 : Math.ceil(Math.max(0, gifOutputBytes - gifOutputTargetBytes) / 1024));

  // ── Modals ──────────────────────────────────────────────────────────
  let createOpen = $state(false);
  let createValue = $state('');
  let createEmoji = $state('');
  let renameTarget = $state<DrawerT | null>(null);
  let renameValue = $state('');
  let renameEmoji = $state('');
  let deleteDrawerTarget = $state<DrawerT | null>(null);
  let deleteGalleryTarget = $state<GalleryItem | null>(null);

  async function loadSettings(loadId: number) {
    const r = await apiFetch('/api/studio/settings');
    if (r.ok && loadId === settingsLoadId) {
      const d = await r.json();
      settings = d.settings;
      monthlySpend = d.monthlySpendUsd ?? 0;
      budgetInput = String(settings?.monthlyBudgetUsd ?? 0);
      if (hydrateProviderOnLoad && settings) { provider = settings.backend; model = MODELS[provider]?.[0]?.value ?? ''; hydrateProviderOnLoad = false; }
    }
  }
  async function loadRefs() {
    const r = await apiFetch('/api/studio/refs');
    if (r.ok) drawers = (await r.json()).drawers ?? [];
  }
  async function loadGallery() {
    const r = await apiFetch('/api/studio/gallery');
    if (r.ok) gallery = (await r.json()).items ?? [];
  }
  async function loadJobs() { const r = await apiFetch('/api/studio/jobs'); if (r.ok) jobs = (await r.json()).jobs ?? []; }
  async function loadFolders() { const r = await apiFetch('/api/studio/folders'); if (r.ok) folders = (await r.json()).folders ?? []; }
  async function loadGifToolsStatus() { try { const r = await apiFetch('/api/gif/tools/status'); const data = await r.json().catch(() => ({})); gifToolsReady = r.ok && data.ready === true; gifToolsReason = gifToolsReady ? '' : data.reason || data.error || 'GIF tools are not ready.'; } catch { gifToolsReady = false; gifToolsReason = 'Could not check GIF tools.'; } }

  $effect(() => {
    const loadId = ++settingsLoadId; hydrateProviderOnLoad = open;
    if (open) { loadSettings(loadId); loadRefs(); loadGallery(); loadJobs(); loadFolders(); }
  });
  $effect(() => {
    if (!open) return;
    const timer = setInterval(async () => { await loadJobs(); if (jobs.some((j) => j.status === 'completed')) await loadGallery(); }, 2500);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (!open || tab !== 'gif') {
      gifPlaying = false;
      if (gifPreviewTimer) clearInterval(gifPreviewTimer);
      return;
    }
    loadGifToolsStatus();
    apiFetch('/api/gif/fonts').then(async (r) => { if (r.ok) gifFonts = (await r.json()).fonts ?? gifFonts; });
  });
  $effect(() => {
    if (gifPreviewTimer) clearInterval(gifPreviewTimer);
    if (gifPlaying && gifSelected.length) gifPreviewTimer = setInterval(() => {
      const position = gifSelected.indexOf(gifActive);
      gifActive = gifSelected[(position + 1) % gifSelected.length] ?? gifSelected[0];
    }, 1000 / gifFps);
    return () => { if (gifPreviewTimer) clearInterval(gifPreviewTimer); };
  });

  function close() {
    open = false;
    gifPlaying = false;
    onclose?.();
  }

  async function gifResponseData(r: Response) { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || 'Request failed'); return data; }
  async function gifTask(label: string, fn: () => Promise<void>) {
    gifBusy = label; gifError = '';
    try { await fn(); } catch (e) { gifError = e instanceof Error ? e.message : `${label} failed`; showToast(gifError, 'error'); }
    finally { gifBusy = ''; }
  }
  function resetGifOutput() { gifOutputUrl = ''; gifOutputFilename = ''; gifOutputBytes = 0; gifOutputKb = 0; gifOutputOk = false; gifOutputTargetKb = null; gifOutputTargetBytes = null; gifOutputFitMet = null; gifGalleryFilename = ''; gifOutputFormat = 'gif'; gifOutputW = 0; gifOutputH = 0; gifOutputNotes = []; gifRenderFilename = ''; gifRenderW = 0; gifRenderH = 0; gifTimedFilename = ''; }
  // Pressing a Discord preset is an explicit ask to fit that lane, so it turns auto-fit on.
  function presetDiscordSticker() { gifOutputWidth = 320; gifOutputHeight = 320; gifColors = 256; gifLossy = 30; gifDither = false; gifPreserveColors = false; gifAutoFit = true; }
  function presetDiscordEmoji() { gifOutputWidth = 128; gifOutputHeight = 128; gifColors = 128; gifLossy = 40; gifDither = false; gifPreserveColors = false; gifAutoFit = true; }
  function presetDiscordStickerKeepColors() { presetDiscordSticker(); gifPreserveColors = true; }
  function refreshGifFrames() { const stamp = Date.now(); gifFrames = gifFrames.map((f) => ({ ...f, url: `${f.url.split('?')[0]}?v=${stamp}` })); }
  function selectAllGifFrames() { gifSelected = gifFrames.map((_, i) => i); }
  function toggleGifFrame(index: number) { gifSelected = gifSelected.includes(index) ? gifSelected.filter((i) => i !== index) : [...gifSelected, index].sort((a, b) => a - b); gifActive = index; }
  function useGifResult(data: any, success: string) {
    const targetBytes = gifLane.maxBytes; const sizeBytes = Number(data.sizeBytes) || Number(data.sizeKb) * 1024 || 0; const targetKb = Math.round(targetBytes / 1024);
    gifOutputUrl = data.url; gifOutputFilename = data.filename;
    gifOutputFormat = data.format ?? 'gif';
    gifOutputW = Number(data.width) || 0; gifOutputH = Number(data.height) || 0;
    gifOutputNotes = Array.isArray(data.adjustments) ? data.adjustments : [];
    gifOutputBytes = sizeBytes; gifOutputKb = Math.round(sizeBytes / 1024); gifOutputOk = data.discordOk;
    gifOutputTargetBytes = targetBytes; gifOutputTargetKb = targetKb; gifOutputFitMet = sizeBytes <= targetBytes; gifGalleryFilename = '';
    const dims = gifOutputW && gifOutputH ? ` · ${gifOutputW}×${gifOutputH}` : '';
    if (!gifOutputFitMet) showToast(`Still ${Math.round((sizeBytes - targetBytes) / 1024)}KB over ${gifLane.name ?? 'Discord'}'s ${targetKb}KB limit${gifAutoFit || gifOutputFormat !== 'gif' ? ' — try fewer colors, frames, or a smaller size' : ' — enable Auto-fit or lower the settings yourself'}`, 'error');
    else showToast(`${success}${dims} · ${gifOutputKb}KB · under ${targetKb}KB`, 'success');
  }
  async function extractGifFrames(event: Event) {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
    await gifTask('Extracting frames', async () => {
      const form = new FormData(); form.append('file', file);
      const data = await gifResponseData(await apiFetch(`/api/gif/extract-frames?fps=${gifFps}&maxFrames=${gifMaxFrames}`, { method: 'POST', body: form }));
      gifSessionId = data.sessionId; gifFrames = data.frames; selectAllGifFrames(); gifActive = 0; resetGifOutput();
      const image = new Image(); image.onload = () => { gifCropW = image.naturalWidth; gifCropH = image.naturalHeight; }; image.src = gifFrames[0]?.url;
    }); input.value = '';
  }
  async function uploadGifFrames(event: Event) {
    const input = event.target as HTMLInputElement; const files = Array.from(input.files ?? []); if (!files.length) return;
    await gifTask('Importing frames', async () => {
      for (const file of files) {
        const form = new FormData(); form.append('file', file); if (gifSessionId) form.append('sessionId', gifSessionId);
        const data = await gifResponseData(await apiFetch('/api/gif/upload-frame', { method: 'POST', body: form }));
        gifSessionId = data.sessionId; gifFrames = [...gifFrames, data.frame];
      }
      selectAllGifFrames(); gifActive = 0; resetGifOutput();
    }); input.value = '';
  }
  async function cropGif() { if (!gifSessionId) return; await gifTask('Cropping', async () => { await gifResponseData(await apiFetch(`/api/gif/crop/${gifSessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: gifCropX, y: gifCropY, width: gifCropW, height: gifCropH }) })); refreshGifFrames(); resetGifOutput(); }); }
  async function chromaGif() { if (!gifSessionId || !gifSelected.length) return; await gifTask('Removing color', async () => { for (const index of gifSelected) await gifResponseData(await apiFetch(`/api/gif/chroma-key/${gifSessionId}/${encodeURIComponent(gifFrames[index].filename)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: gifChromaColor, tolerance: gifChromaTolerance, blend: gifChromaBlend, mode: gifGreenScreen ? 'chroma' : 'color' }) })); refreshGifFrames(); resetGifOutput(); }); }
  function gifCreateBody(width?: number, height?: number, frameNames?: string[]) {
    return {
      sessionId: gifSessionId,
      frames: frameNames ?? gifSelected.map((i) => gifFrames[i].filename),
      fps: gifFps, loop: true,
      width: width ?? (gifOutputWidth || undefined),
      height: height ?? (gifOutputHeight || undefined),
      fit: gifPreserveColors, preserveColors: gifPreserveColors,
      format: gifPreserveColors ? 'apng' : 'gif',
      autoFit: gifAutoFit,
      speed: gifSpeed,
      lossy: gifPreserveColors ? undefined : gifLossy,
      colors: gifPreserveColors ? undefined : gifColors,
      dither: gifPreserveColors ? false : gifDither,
      maxBytes: gifLane.maxBytes,
      text: gifCaption.trim() ? { content: gifCaption.trim(), position: gifTextPosition, fontSize: gifFontSize, fontColor: gifFontColor, borderColor: gifBorderColor, fontFamily: gifFontFamily } : undefined,
    };
  }
  async function requestCreateGif(width?: number, height?: number, frameNames?: string[]) {
    return gifResponseData(await apiFetch('/api/gif/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gifCreateBody(width, height, frameNames)) }));
  }
  function recordRender(data: any) { gifRenderFilename = data.filename; gifRenderW = Number(data.width) || 0; gifRenderH = Number(data.height) || 0; gifTimedFilename = ''; }
  async function createGif() { if (!gifSessionId || !gifSelected.length) return; await gifTask('Forging GIF', async () => { const data = await requestCreateGif(); recordRender(data); useGifResult(data, 'GIF ready'); }); }
  async function optimizeGif() {
    const base = gifRenderFilename || gifOutputFilename; if (!base) return;
    if (gifOutputFormat === 'apng' || gifPreserveColors) {
      // No gifsicle for APNG — but the size levers that matter (drop every Nth,
      // scale down) work by re-rendering from the original frames, so the
      // "over budget → thin the frames" workflow stays intact on this lane.
      const nth = gifRemoveFrames;
      if (!nth && gifOptimizeScale >= 100) { showToast('For APNG set “Drop every Nth” or Scale — palette and duplicate tricks are GIF-only', 'error'); return; }
      await gifTask('Re-rendering APNG', async () => {
        const names = gifSelected.map((i) => gifFrames[i].filename).filter((_, pos) => !nth || (pos + 1) % nth !== 0);
        const baseW = gifRenderW || gifOutputW; const baseH = gifRenderH || gifOutputH;
        const w = gifOptimizeScale < 100 && baseW ? Math.max(16, Math.round((baseW * gifOptimizeScale) / 100)) : undefined;
        const h = gifOptimizeScale < 100 && baseH ? Math.max(16, Math.round((baseH * gifOptimizeScale) / 100)) : undefined;
        const data = await requestCreateGif(w, h, names);
        recordRender(data);
        useGifResult(data, `Re-rendered APNG${nth ? ` · dropped every ${nth}th frame` : ''}${w ? ` · scaled to ${gifOptimizeScale}%` : ''}`);
      });
      return;
    }
    await gifTask('Optimizing', async () => {
      let target = gifTimedFilename || base;
      let scaleParam: number | undefined;
      if (gifOptimizeScale < 100) {
        const baseW = gifRenderW || gifOutputW; const baseH = gifRenderH || gifOutputH;
        if (baseW && baseH) {
          // Scaling re-renders from the original frames at the reduced size, so
          // the smaller GIF is built from full-quality pixels — never by
          // shrinking an already-compressed GIF.
          const rerender = await requestCreateGif(Math.max(16, Math.round((baseW * gifOptimizeScale) / 100)), Math.max(16, Math.round((baseH * gifOptimizeScale) / 100)));
          target = rerender.filename;
        } else {
          scaleParam = gifOptimizeScale / 100; // dimensions unknown — scale the pristine render once
        }
      }
      const data = await gifResponseData(await apiFetch(`/api/gif/optimize/${gifSessionId}/${encodeURIComponent(target)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lossy: gifPreserveColors ? undefined : gifLossy, colors: gifPreserveColors ? undefined : gifColors, dither: gifPreserveColors ? false : gifDither, optimizeLevel: 3, dropDuplicates: gifDropDuplicates, removeFrames: gifRemoveFrames || undefined, stripMetadata: true, scale: scaleParam, maxBytes: gifLane.maxBytes }) }));
      useGifResult(data, `Optimized · saved ${data.savedPercent}%${data.framesDropped ? ` · removed ${data.framesDropped} frames` : ''}`);
    });
  }
  async function changeGifSpeed() {
    // Speed also works from the pristine render: "Apply 2×" means 2× of the
    // render every time, not 2× of whatever the last button click produced.
    const target = gifRenderFilename || gifOutputFilename; if (!target) return;
    if (gifOutputFormat === 'apng' || gifPreserveColors) {
      // Speed is a render parameter on this lane — rebuild with it baked in.
      await gifTask('Re-rendering APNG', async () => { const data = await requestCreateGif(); recordRender(data); useGifResult(data, `Speed ${gifSpeed}× baked in`); });
      return;
    }
    await gifTask('Changing speed', async () => {
      const data = await gifResponseData(await apiFetch(`/api/gif/speed/${gifSessionId}/${encodeURIComponent(target)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed: gifSpeed }) }));
      gifTimedFilename = data.filename;
      useGifResult(data, 'Speed changed');
    }); }
  async function keepGif() { if (!gifOutputFilename || gifGalleryFilename) return; await gifTask('Saving to gallery', async () => { const data = await gifResponseData(await apiFetch(`/api/gif/keep/${gifSessionId}/${encodeURIComponent(gifOutputFilename)}`, { method: 'POST' })); gifGalleryFilename = data.filename; await loadGallery(); showToast(`Saved to ${data.location}: ${data.filename}`, 'success'); }); }
  // The escape hatch for an over-budget APNG: same frames, GIF lane, auto-fit
  // granted — always lands a postable file, quality cost reported honestly.
  async function makeItFitAsGif() {
    if (!gifSessionId || !gifSelected.length) return;
    await gifTask('Fitting as GIF', async () => {
      const body = {
        ...gifCreateBody(),
        format: 'gif', preserveColors: false, autoFit: true,
        fit: !!(gifOutputWidth && gifOutputHeight), // keep the square padding the sticker lane had
        lossy: gifLossy, colors: gifColors, dither: gifDither,
      };
      const data = await gifResponseData(await apiFetch('/api/gif/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      recordRender(data);
      useGifResult(data, 'Fitted as GIF');
    });
  }

  async function putSettings(patch: Record<string, unknown>) {
    saving = true;
    try {
      const r = await apiFetch('/api/studio/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (r.ok) { settings = (await r.json()).settings; return true; }
      const e = await r.json().catch(() => ({})); showToast(e.error || 'Could not save.', 'error'); return false;
    } finally { saving = false; }
  }
  async function switchBackend(backend: Settings['backend']) {
    if (await putSettings({ backend })) { hydrateProviderOnLoad = false; provider = backend; model = MODELS[provider]?.[0]?.value ?? ''; showToast(`Image engine → ${backend}`, 'success'); }
  }

  function saveKey() {
    if (!apiKeyInput.trim()) return;
    putSettings({ openai_api_key: apiKeyInput.trim() });
    apiKeyInput = '';
  }
  function clearKey() { putSettings({ openai_api_key: '' }); }
  function saveBudget() { putSettings({ monthly_budget_usd: Number(budgetInput) || 0 }); }

  // ── Drawer CRUD ─────────────────────────────────────────────────────
  async function confirmCreate(label: string, emoji?: string) {
    createOpen = false;
    const r = await apiFetch('/api/studio/drawers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, emoji }),
    });
    if (r.ok) await loadRefs();
    else { const e = await r.json().catch(() => ({})); showToast(e.error || 'Could not create drawer.', 'error'); }
  }
  function openRename(d: DrawerT) { renameTarget = d; renameValue = d.label; renameEmoji = d.emoji ?? ''; }
  async function confirmRename(label: string, emoji?: string) {
    const slug = renameTarget?.slug;
    renameTarget = null;
    if (!slug) return;
    const r = await apiFetch(`/api/studio/drawers/${slug}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, emoji }),
    });
    if (r.ok) await loadRefs();
    else { const e = await r.json().catch(() => ({})); showToast(e.error || 'Could not rename.', 'error'); }
  }
  async function confirmDeleteDrawer() {
    const slug = deleteDrawerTarget?.slug;
    deleteDrawerTarget = null;
    if (!slug) return;
    const r = await apiFetch(`/api/studio/drawers/${slug}`, { method: 'DELETE' });
    if (r.ok) await loadRefs();
    else { const e = await r.json().catch(() => ({})); showToast(e.error || 'Could not delete.', 'error'); }
  }

  // ── References (per image) ──────────────────────────────────────────
  async function onPick(slug: string, ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    uploadingFor = slug;
    try {
      for (const f of files) {
        const fd = new FormData();
        fd.append('file', f);
        const r = await apiFetch(`/api/studio/refs/${slug}`, { method: 'POST', body: fd });
        if (!r.ok) { const e = await r.json().catch(() => ({})); showToast(e.error || 'Upload failed.', 'error'); }
      }
      await loadRefs();
    } finally { uploadingFor = null; input.value = ''; }
  }
  async function delRef(slug: string, filename: string) {
    const r = await apiFetch(`/api/studio/refs/${slug}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (r.ok) await loadRefs();
  }

  // ── Gallery ─────────────────────────────────────────────────────────
  function jumpTo(threadId: string, messageId: string) {
    close();
    onopen?.(threadId, messageId);
  }
  async function confirmDeleteGallery() {
    const filename = deleteGalleryTarget?.filename;
    deleteGalleryTarget = null;
    if (!filename) return;
    const r = await apiFetch(`/api/studio/gallery/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (r.ok) await loadGallery();
  }
  function toggleSubject(slug: string) { selectedSubjects = selectedSubjects.includes(slug) ? selectedSubjects.filter((s) => s !== slug) : [...selectedSubjects, slug]; }
  async function addOneOffRefs(event: Event) {
    const input = event.target as HTMLInputElement;
    for (const file of Array.from(input.files ?? []).slice(0, 4 - oneOffRefs.length)) {
      const form = new FormData(); form.append('file', file); const r = await apiFetch('/api/studio/one-off-refs', { method: 'POST', body: form });
      const data = await r.json(); if (r.ok) oneOffRefs = [...oneOffRefs, { token: data.token, name: file.name }]; else showToast(data.error || 'Reference upload failed.', 'error');
    }
    input.value = '';
  }
  async function enhancePrompt() {
    if (!prompt.trim()) return; enhancing = true;
    try { const r = await apiFetch('/api/studio/enhance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, backend: provider, codexModel: model }) }); const d = await r.json(); if (r.ok) prompt = d.enhanced; else showToast(d.error || 'Enhancement failed.', 'error'); }
    finally { enhancing = false; }
  }
  async function generate(queueAnother = false) {
    if (!prompt.trim()) return; generating = true;
    const chosen = STYLES.find((s) => s.name === style)?.prompt; const finalPrompt = chosen ? `${prompt.trim()}, ${chosen}` : prompt.trim();
    const body: Record<string, unknown> = { prompt: finalPrompt, subjects: selectedSubjects, oneOffRefs: oneOffRefs.map((r) => r.token), size: renderSize, customWidth, customHeight, backend: provider, async: true };
    if (provider === 'codex') body.codexModel = model; if (provider === 'openai') body.openaiModel = model; if (provider === 'cloudflare') body.cloudflareModel = model;
    if (provider === 'antigravity') body.agyModel = model; if (provider === 'openart') { body.openartModel = model; body.openartMedia = model === 'pixverseV6' ? 'video' : 'image'; }
    try { const r = await apiFetch('/api/studio/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); if (!r.ok) showToast(d.error || 'Generation failed.', 'error'); else { await loadJobs(); if (!queueAnother) prompt = ''; } }
    finally { generating = false; }
  }
  function reuse(g: GalleryItem) { prompt = g.prompt ?? ''; const reusedProvider = g.backend ?? 'codex'; if (settings && reusedProvider !== settings.backend) showToast(`Engine switched to ${reusedProvider} to match this render`, 'info'); hydrateProviderOnLoad = false; provider = reusedProvider; model = g.model ?? MODELS[provider]?.[0]?.value ?? ''; renderSize = g.aspectRatio ?? 'square'; selectedSubjects = g.references ?? []; tab = 'generate'; }
  async function moveToFolder(g: GalleryItem, folderId: string) { await apiFetch(`/api/studio/gallery/${encodeURIComponent(g.filename)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: folderId || null }) }); await loadGallery(); }
  async function createFolder() { if (!newFolderName.trim()) return; await apiFetch('/api/studio/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newFolderName }) }); newFolderName = ''; await loadFolders(); }
  async function deleteFolder(id: string) { await apiFetch(`/api/studio/folders/${id}`, { method: 'DELETE' }); if (folderFilter === id) folderFilter = ''; await loadFolders(); }
  function downloadItem(g: GalleryItem) { const a = document.createElement('a'); a.href = g.url; a.download = `byte-light-studio-${String(downloadCounter++).padStart(4, '0')}.${g.filename.split('.').pop()}`; a.click(); }
  function resetEdit() { editZoom = 1; editRotate = 0; editBrightness = 100; editContrast = 100; editHue = 0; editCrop = '1'; }
  async function applyEdit() {
    if (!selectedEdit || !editorCanvas) return; const img = new Image(); img.crossOrigin = 'anonymous'; img.src = selectedEdit.url; await img.decode();
    const aspect = Number(editCrop); let sw = img.naturalWidth / editZoom; let sh = img.naturalHeight / editZoom; if (sw / sh > aspect) sw = sh * aspect; else sh = sw / aspect;
    editorCanvas.width = Math.round(sw); editorCanvas.height = Math.round(sh); const c = editorCanvas.getContext('2d')!; c.filter = `brightness(${editBrightness}%) contrast(${editContrast}%) hue-rotate(${editHue}deg)`; c.translate(editorCanvas.width / 2, editorCanvas.height / 2); c.rotate(editRotate * Math.PI / 180); c.drawImage(img, -sw / 2, -sh / 2, sw, sh);
    editorCanvas.toBlob((blob) => { if (!blob) return; const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `byte-light-edit-${Date.now()}.png`; a.click(); URL.revokeObjectURL(a.href); }, 'image/png');
  }
  function sketchPoint(canvas: HTMLCanvasElement, e: PointerEvent) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX-r.left)*canvas.width/r.width, y: (e.clientY-r.top)*canvas.height/r.height }; }
  function startDraw(e: PointerEvent) { const canvas = sketchCanvas; if (!canvas) return; drawing = true; sketchHistory = [...sketchHistory.slice(-19), canvas.toDataURL()]; const p = sketchPoint(canvas, e); const c = canvas.getContext('2d')!; c.beginPath(); c.moveTo(p.x,p.y); canvas.setPointerCapture(e.pointerId); }
  function draw(e: PointerEvent) { const canvas = sketchCanvas; if (!drawing || !canvas) return; const p = sketchPoint(canvas, e); const c = canvas.getContext('2d')!; c.globalCompositeOperation = drawTool === 'eraser' ? 'destination-out' : 'source-over'; c.strokeStyle = drawColor; c.lineWidth = brushSize; c.lineCap='round'; c.lineTo(p.x,p.y); c.stroke(); }
  function stopDraw() { drawing = false; }
  function clearSketch() { const canvas = sketchCanvas; if (!canvas) return; sketchHistory = [...sketchHistory.slice(-19), canvas.toDataURL()]; canvas.getContext('2d')!.clearRect(0,0,canvas.width,canvas.height); }
  function undoSketch() { const canvas = sketchCanvas; if (!canvas) return; const last = sketchHistory.at(-1); if (!last) return; sketchHistory = sketchHistory.slice(0,-1); const img = new Image(); img.onload=()=>{ const c=canvas.getContext('2d')!; c.clearRect(0,0,canvas.width,canvas.height); c.drawImage(img,0,0); }; img.src=last; }
  async function useSketch() { const canvas = sketchCanvas; if (!canvas) return; canvas.toBlob(async (blob) => { if (!blob || !drawers[0]) return; const fd=new FormData(); fd.append('file',blob,`sketch-${Date.now()}.png`); const r=await apiFetch(`/api/studio/refs/${drawers[0].slug}`,{method:'POST',body:fd}); if(r.ok){ await loadRefs(); if(!selectedSubjects.includes(drawers[0].slug)) selectedSubjects=[...selectedSubjects,drawers[0].slug]; tab='generate'; showToast('Sketch added as a reference.','success'); } },'image/png'); }
</script>

{#if open}
  <div class="drawer-backdrop" onclick={close} role="presentation"></div>
  <div class="drawer" role="dialog" tabindex="-1" aria-label="Studio — settings, references, gallery, stickers" aria-modal="true">
    <header class="drawer-header">
      <h2>Studio</h2>
      <button class="close-btn" onclick={close} aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </header>

    <nav class="filters" aria-label="Studio tabs" bind:this={tabBar}>
      <button class="filter-btn" class:active={tab === 'generate'} onclick={() => (tab = 'generate')}>Create</button>
      <button class="filter-btn" class:active={tab === 'gallery'} onclick={() => (tab = 'gallery')}>Gallery</button>
      <button class="filter-btn" class:active={tab === 'edit'} onclick={() => (tab = 'edit')}>Edit</button>
      <button class="filter-btn" class:active={tab === 'sketch'} onclick={() => (tab = 'sketch')}>Sketch</button>
      <button class="filter-btn" class:active={tab === 'gif'} onclick={() => (tab = 'gif')}>GIF</button>
      <button class="filter-btn" class:active={tab === 'cutout'} onclick={() => (tab = 'cutout')}>Cutout</button>
      <button class="filter-btn" class:active={tab === 'settings'} onclick={() => (tab = 'settings')}>Settings</button>
      <button class="filter-btn" class:active={tab === 'references'} onclick={() => (tab = 'references')}>References</button>
      <button class="filter-btn" class:active={tab === 'stickers'} onclick={() => (tab = 'stickers')}>Stickers</button>
    </nav>

    <div class="drawer-body">
      {#if tab === 'generate'}
        <section class="workspace-card">
          <label class="row-label" for="studio-prompt">What should we make?</label>
          <textarea id="studio-prompt" class="field prompt" rows="5" bind:value={prompt} placeholder="Describe the image, mood, lighting, composition…"></textarea>
          <div class="control-grid">
            <label>Provider<select class="field select" bind:value={provider} onchange={() => { hydrateProviderOnLoad = false; model = MODELS[provider]?.[0]?.value ?? ''; }}>{#each PROVIDERS as p}<option value={p}>{p}</option>{/each}</select></label>
            <label>Model<select class="field select" bind:value={model}>{#each MODELS[provider] ?? [] as m}<option value={m.value}>{m.label}</option>{/each}</select></label>
            <label>Canvas<select class="field select" bind:value={renderSize}>{#each SIZE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}</select></label>
            <label>Style<select class="field select" bind:value={style}>{#each STYLES as s}<option value={s.name}>{s.name}</option>{/each}</select></label>
          </div>
          {#if renderSize === 'custom'}<div class="key-row"><input class="field" type="number" min="256" max="2048" bind:value={customWidth} aria-label="Width"/><span>×</span><input class="field" type="number" min="256" max="2048" bind:value={customHeight} aria-label="Height"/></div>{/if}
          <div class="subject-picker"><span class="row-label">Reference subjects</span>{#each drawers as d}<button class="chip" class:active={selectedSubjects.includes(d.slug)} onclick={() => toggleSubject(d.slug)}>{markerFor(d)} {d.label} <small>{d.refs.length}</small></button>{/each}</div>
          <div class="subject-picker"><span class="row-label">One-off references · up to 4</span><label class="btn-soft upload-label">+ Add<input class="hidden-file" type="file" accept="image/*" multiple onchange={addOneOffRefs}/></label>{#each oneOffRefs as ref, i}<button class="chip active" title={ref.name} onclick={() => oneOffRefs=oneOffRefs.filter((_,n)=>n!==i)}>{ref.name.slice(0,18)} ×</button>{/each}</div>
          <div class="generate-actions"><button class="btn-soft" disabled={enhancing || !prompt.trim()} title={!prompt.trim() ? 'Write a prompt first' : 'Rewrite your prompt with more detail'} onclick={enhancePrompt}>✨ {enhancing ? 'Enhancing…' : 'Enhance'}</button><button class="primary" disabled={generating || !prompt.trim()} title={!prompt.trim() ? 'Write a prompt first' : 'Generate an image'} onclick={() => generate(false)}>{generating ? 'Queuing…' : 'Generate'}</button><button class="btn-soft" disabled={generating || !prompt.trim()} title={!prompt.trim() ? 'Write a prompt first' : 'Queue another render with these settings'} onclick={() => generate(true)}>Queue another</button></div>
        </section>
        <section class="workspace-card"><div class="row"><span class="row-label">Job tray</span><button class="icon-btn" onclick={loadJobs}>↻</button></div>{#if jobs.length}{#each jobs as j}<div class="job"><span class={`status ${j.status}`}>{j.status}</span><span title={j.prompt}>{j.prompt.slice(0,72)}</span>{#if j.error}<small class="job-error">{j.error}</small>{/if}</div>{/each}{:else}<p class="empty">No queued renders.</p>{/if}</section>
      {:else if tab === 'gif'}
        <div class="gif-studio">
          {#if gifToolsReady === false}<p class="gif-error">{gifToolsReason}</p>{/if}
          <section class="gif-card gif-source">
            <h3>1 · Bring frames</h3>
            <div class="gif-grid gif-two"><label>Extract FPS<input type="number" min="1" max="30" bind:value={gifFps}></label><label>Frame limit<input type="number" min="1" max="300" bind:value={gifMaxFrames}></label></div>
            <div class="gif-actions"><label class="gif-button primary">Upload video / GIF<input hidden type="file" accept="video/*,image/gif" disabled={gifToolsReady !== true} onchange={extractGifFrames}></label><label class="gif-button">Import images<input hidden type="file" accept="image/*" multiple onchange={uploadGifFrames}></label></div>
          </section>

          {#if gifFrames.length}
            <section class="gif-card">
              <div class="gif-section-head"><h3>2 · Timeline <span>{gifSelected.length}/{gifFrames.length}</span></h3><div class="gif-actions"><button onclick={selectAllGifFrames}>All</button><button onclick={() => gifSelected = []}>None</button><button onclick={() => gifPlaying = !gifPlaying}>{gifPlaying ? 'Pause' : 'Play'}</button></div></div>
              <div class="gif-preview">{#if gifActiveFrame}<img src={gifActiveFrame.url} alt="Active frame">{/if}</div>
              <div class="gif-timeline">{#each gifFrames as frame, index (frame.filename)}<button class:selected={gifSelected.includes(index)} class:active={gifActive === index} onclick={() => toggleGifFrame(index)} title={frame.filename}><img src={frame.url} alt={`Frame ${index + 1}`}><span>{index + 1}</span></button>{/each}</div>
            </section>

            <section class="gif-card"><h3>3 · Edit frames</h3>
              <details><summary>Crop every frame</summary><div class="gif-grid gif-four"><label>X<input type="number" min="0" bind:value={gifCropX}></label><label>Y<input type="number" min="0" bind:value={gifCropY}></label><label>Width<input type="number" min="1" bind:value={gifCropW}></label><label>Height<input type="number" min="1" bind:value={gifCropH}></label></div><button class="primary" onclick={cropGif} disabled={!!gifBusy || gifToolsReady !== true}>Apply crop</button></details>
              <details><summary>Remove a background color</summary><div class="gif-grid gif-two"><label>Key color<input type="color" bind:value={gifChromaColor}></label><label>Tolerance · {Math.round(gifChromaTolerance * 100)}%<input type="range" min="0.01" max="0.8" step="0.01" bind:value={gifChromaTolerance}></label><label>Edge blend · {Math.round(gifChromaBlend * 100)}%<input type="range" min="0" max="0.5" step="0.05" bind:value={gifChromaBlend}></label></div><label class="gif-check"><input type="checkbox" bind:checked={gifGreenScreen}> Green-screen mode</label><p class="gif-hint">For an actual green screen, not a flat backdrop. Leave it off and a red background stops taking the pink with it.</p><button class="primary" onclick={chromaGif} disabled={!!gifBusy || !gifSelected.length || gifToolsReady !== true}>Apply to selected</button></details>
              <details><summary>Caption</summary><textarea rows="2" placeholder="Add a caption…" bind:value={gifCaption}></textarea><div class="gif-grid gif-two"><label>Font<select bind:value={gifFontFamily}>{#each gifFonts as font}<option value={font}>{font}</option>{/each}</select></label><label>Position<select bind:value={gifTextPosition}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label><label>Size<input type="number" min="8" max="200" bind:value={gifFontSize}></label><label>Fill / outline<span class="gif-colors"><input type="color" bind:value={gifFontColor}><input type="color" bind:value={gifBorderColor}></span></label></div></details>
            </section>

            <section class="gif-card"><h3>4 · Render</h3><div class="gif-actions"><button onclick={presetDiscordSticker}>Discord Sticker</button><button onclick={presetDiscordEmoji}>Discord Emoji</button><button onclick={presetDiscordStickerKeepColors}>Sticker (keep colors)</button></div><p class="gif-hint">{gifLane.name ? `${gifLane.name} preset: transparent, sized to ${gifOutputWidth}×${gifOutputHeight}, compressed against ${Math.round(gifLane.maxBytes / 1024)}KB.` : `Full color, transparent, compressed against 512KB — at the frames’ own size. Not a Discord sticker: set an output size above for that.`}</p><p class="gif-hint">Animated stickers upload only from Discord desktop or browser server settings; mobile refuses silently.</p>{#if gifPreserveColors}<p class="gif-hint">Keep colors: exports a real APNG — true full color, transparent, {gifOutputWidth || 320}×{gifOutputHeight || 320} fit. Palette, lossy, dither, and auto-fit don't apply; Discord accepts APNG stickers.</p>{/if}<div class="gif-grid gif-two"><label>Output width <small>0 = auto</small><input type="number" min="0" bind:value={gifOutputWidth}></label><label>Output height <small>0 = auto</small><input type="number" min="0" bind:value={gifOutputHeight}></label><label>Speed · {gifSpeed}×<input type="range" min="0.25" max="4" step="0.25" bind:value={gifSpeed}></label><label>Colors · {gifColors}<input type="range" min="2" max="256" step="2" bind:value={gifColors}></label><label>Lossy · {gifLossy}<input type="range" min="0" max="200" step="5" bind:value={gifLossy}></label><label class="gif-check"><input type="checkbox" bind:checked={gifDither}> Dither colors</label><label class="gif-check" title="Allow the Studio to cut colors or raise lossy past your settings until the file fits the size limit. Off = your settings are the floor; an oversized result is reported, never silently degraded."><input type="checkbox" bind:checked={gifAutoFit} disabled={gifPreserveColors}> Auto-fit to {Math.round(gifLane.maxBytes / 1024)}KB</label></div><button class="gif-forge" onclick={createGif} disabled={!!gifBusy || !gifSelected.length || gifToolsReady !== true} title={!gifSelected.length ? 'Select at least one frame in the timeline' : 'Render from your selected frames'}>{gifBusy === 'Forging GIF' ? 'Forging…' : gifLane.name ? `Create ${gifLane.name} ${gifPreserveColors ? 'APNG' : 'GIF'}` : 'Create GIF'}</button></section>
          {/if}

          {#if gifBusy}<p class="gif-status"><span></span>{gifBusy}…</p>{/if}
          {#if gifError}<p class="gif-error">{gifError}</p>{/if}
          {#if gifOutputUrl}
            <section class="gif-card gif-result" class:gif-over={gifOutputTargetKb !== null && !gifOutputFitMet}><h3>{gifOutputTargetKb !== null && !gifOutputFitMet ? 'Over Discord limit' : `Finished ${gifOutputFormat === 'apng' ? 'APNG' : 'GIF'}`}</h3><img src={gifOutputUrl} alt="Created animation"><p>{#if gifOutputW && gifOutputH}{gifOutputW}×{gifOutputH} · {/if}{gifOutputFormat.toUpperCase()} · {gifOutputKb}KB · <span class:ok={gifOutputFitMet}>{gifOutputFitMet ? `✅ under ${gifOutputTargetKb}KB${gifLane.name ? ` — ${gifLane.name}-ready` : ''}` : `Still ${gifOutputOverKb}KB over the ${gifOutputTargetKb}KB limit${gifAutoFit || gifOutputFormat === 'apng' ? ' — try fewer colors, frames, or a smaller size' : ' — enable Auto-fit or lower the settings'}`}</span></p>{#if gifOutputWidth && gifOutputW && gifOutputW < gifOutputWidth}<p class="gif-hint">Rendered at {gifOutputW}×{gifOutputH}, smaller than the requested {gifOutputWidth}×{gifOutputHeight}.</p>{/if}{#if gifOutputNotes.length}<p class="gif-hint">{gifOutputNotes.join(' · ')}</p>{/if}<div class="gif-actions gif-result-bar">{#if gifOutputFormat === 'apng' && gifOutputFitMet === false}<button class="gif-button primary" onclick={makeItFitAsGif} disabled={!!gifBusy} title="Re-renders these frames on the GIF lane with auto-fit — always lands under the limit; any quality cost is reported on the card">Make it fit as GIF</button>{/if}<a class="gif-button primary" href={gifOutputUrl} download={`byte-light.${gifOutputFormat}`}>Download</a><button onclick={keepGif} disabled={!!gifBusy || !!gifGalleryFilename}>{gifGalleryFilename ? 'Saved to gallery' : 'Save to gallery'}</button><button onclick={changeGifSpeed} disabled={!!gifBusy || gifToolsReady !== true} title={gifOutputFormat !== 'gif' ? `Re-renders the APNG with ${gifSpeed}× speed baked in` : `Re-time the render to ${gifSpeed}×`}>Apply {gifSpeed}× speed</button><button onclick={optimizeGif} disabled={!!gifBusy || gifToolsReady !== true} title={gifOutputFormat !== 'gif' ? 'Re-renders the APNG from your frames — Drop every Nth and Scale apply; palette tricks are GIF-only' : 'Optimize from the pristine render'}>Optimize</button></div>{#if gifGalleryFilename}<p class="ok">Saved in Studio gallery · {gifGalleryFilename}</p>{/if}<details><summary>Optimization controls</summary><div class="gif-grid gif-two"><label class="gif-check"><input type="checkbox" bind:checked={gifDropDuplicates}> Drop duplicates</label><label>Drop every Nth<select bind:value={gifRemoveFrames}><option value={0}>Keep all</option><option value={2}>2nd</option><option value={3}>3rd</option><option value={4}>4th</option></select></label><label>Scale · {gifOptimizeScale}%<input type="range" min="25" max="100" step="5" bind:value={gifOptimizeScale}></label></div></details></section>
          {/if}
        </div>
      {:else if tab === 'cutout'}
        <div class="gif-editor">
          <CutoutTab active={tab === 'cutout'} />
        </div>
      {:else if tab === 'settings'}
        {#if settings}
          <section class="set-block">
            <div class="row">
              <span class="row-label">Image generation</span>
              <button class="toggle-btn" class:on={settings.enabled} disabled={saving} onclick={() => putSettings({ enabled: !settings!.enabled })} type="button" aria-label="Toggle image generation">
                <span class="toggle-slider"></span>
              </button>
            </div>
            <p class="hint">When on, we can draw straight into the chat.</p>
          </section>

          <section class="set-block">
            <span class="row-label">Engine</span>
            <div class="eng-tabs">
              {#each PROVIDERS as p}<button class="eng-tab" class:active={settings.backend === p} disabled={saving} onclick={() => switchBackend(p)}>{p}</button>{/each}
            </div>
            <p class="hint">{ENGINE_HINTS[settings.backend]}</p>
          </section>

          {#if settings.backend === 'openai'}
            <section class="set-block">
              <div class="row">
                <span class="row-label">Size</span>
                <select class="field select" value={settings.size} disabled={saving} onchange={(e) => putSettings({ size: (e.target as HTMLSelectElement).value })}>
                  {#each SIZE_OPTS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
              </div>
            </section>

            <section class="set-block">
              <div class="row">
                <span class="row-label">Quality</span>
                <select class="field select" value={settings.quality} disabled={saving} onchange={(e) => putSettings({ quality: (e.target as HTMLSelectElement).value })}>
                  {#each QUALITY_OPTS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
                </select>
              </div>
              <p class="hint">Auto lets the model choose. Higher costs more.</p>
            </section>

            <section class="set-block">
              <span class="row-label">OpenAI API key</span>
              {#if settings.hasOpenaiKey}
                <div class="key-row">
                  <span class="key-set">✓ Key saved</span>
                  <button class="btn-soft" disabled={saving} onclick={clearKey}>Remove</button>
                </div>
              {/if}
              <div class="key-row">
                <input class="field" type="password" placeholder="sk-…" bind:value={apiKeyInput} />
                <button class="btn-soft" disabled={saving || !apiKeyInput.trim()} onclick={saveKey}>Save</button>
              </div>
            </section>

            <section class="set-block">
              <span class="row-label">Monthly budget (USD)</span>
              <div class="key-row">
                <input class="field" type="text" inputmode="decimal" placeholder="0 = no cap" bind:value={budgetInput} />
                <button class="btn-soft" disabled={saving} onclick={saveBudget}>Set</button>
              </div>
              <p class="hint">Spent this month: ${monthlySpend.toFixed(2)}{settings.monthlyBudgetUsd > 0 ? ` / $${settings.monthlyBudgetUsd.toFixed(2)}` : ''}</p>
            </section>
          {/if}
        {:else}
          <p class="empty">Loading…</p>
        {/if}
      {:else if tab === 'references'}
        <p class="hint">A clear portrait plus a body shot keeps us looking like us. Add your own drawers too — friends, sample subject, places. Say a drawer's name and it gets pulled.</p>
        {#each drawers as d (d.slug)}
          <section class="ref-block">
            <header class="ref-head">
              <span class="ref-name">{#if markerFor(d)}{markerFor(d)} {/if}{d.label}</span>
              {#if !d.isDefault}
                <button class="icon-btn" title="Rename drawer" aria-label="Rename" onclick={() => openRename(d)}>✎</button>
                <button class="icon-btn danger" title="Delete drawer" aria-label="Delete drawer" onclick={() => (deleteDrawerTarget = d)}>🗑</button>
              {/if}
              <button class="btn-soft" disabled={uploadingFor === d.slug} onclick={() => fileInputs[d.slug]?.click()}>{uploadingFor === d.slug ? 'Uploading…' : '+ Add'}</button>
              <input type="file" accept="image/*" multiple class="hidden-file" bind:this={fileInputs[d.slug]} onchange={(e) => onPick(d.slug, e)} />
            </header>
            {#if d.refs.length}
              <div class="thumb-grid">
                {#each d.refs as r (r.filename)}
                  <div class="thumb">
                    <img src={r.url} alt={r.filename} loading="lazy" />
                    <button class="thumb-del" aria-label="Remove" onclick={() => delRef(d.slug, r.filename)}>×</button>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="empty">No references yet.</p>
            {/if}
          </section>
        {/each}
        <button class="new-drawer-btn" onclick={() => { createValue = ''; createOpen = true; }}>+ New drawer</button>
      {:else if tab === 'gallery'}
        <section class="workspace-card"><div class="control-grid"><label>Folder<select class="field select" bind:value={folderFilter}><option value="">All folders</option>{#each folders as f}<option value={f.id}>{f.name}</option>{/each}</select></label><label>Subject<select class="field select" bind:value={refFilter}><option value="">All subjects</option>{#each drawers as d}<option value={d.slug}>{d.label}</option>{/each}</select></label></div><div class="key-row"><input class="field" placeholder="New folder" bind:value={newFolderName}/><button class="btn-soft" onclick={createFolder}>Add</button>{#if folderFilter}<button class="icon-btn danger" title="Delete selected folder" onclick={() => deleteFolder(folderFilter)}>🗑</button>{/if}</div></section>
        {#if filteredGallery.length}
          <div class="gal-grid">
            {#each filteredGallery as g (g.filename)}
              <div class="gal-card">
                <button
                  class="gal-thumb"
                  title="Open image"
                  onclick={() => (previewItem = g)}
                >
                  {#if g.mediaType === 'video'}<video src={g.url} muted preload="metadata"></video>{:else}<img src={g.url} alt={g.prompt ?? ''} loading="lazy" />{/if}
                </button>
                <div class="meta"><strong>{g.model ?? 'Legacy render'}</strong><small>{g.backend ?? 'unknown'} · {g.width ?? '?'}×{g.height ?? '?'}</small><span>{g.prompt ?? 'No prompt metadata'}</span></div>
                <select class="field select compact" value={g.folderId ?? ''} onchange={(e) => moveToFolder(g,(e.target as HTMLSelectElement).value)}><option value="">Unfiled</option>{#each folders as f}<option value={f.id}>{f.name}</option>{/each}</select>
                <div class="gal-foot">
                  {#if g.threadId && g.messageId}
                    <button class="gal-thread gal-thread-link" title={`Jump to "${g.threadName ?? 'chat'}"`} onclick={() => jumpTo(g.threadId!, g.messageId!)}>{g.threadName ?? '—'}</button>
                  {:else}
                    <span class="gal-thread" title={g.threadName ?? ''}>{g.threadName ?? '—'}</span>
                  {/if}
                  <button class="icon-btn" title="Reuse settings" onclick={() => reuse(g)}>↺</button><button class="icon-btn" title="Copy prompt" onclick={() => navigator.clipboard.writeText(g.prompt ?? '')}>⧉</button><button class="icon-btn" title="Download" onclick={() => downloadItem(g)}>⇩</button>
                  {#if g.mediaType !== 'video'}<button class="icon-btn" title="Edit" onclick={() => { selectedEdit=g; tab='edit'; }}>✎</button>{/if}
                  <button class="icon-btn danger" aria-label="Delete from gallery" title="Delete from gallery" onclick={() => (deleteGalleryTarget = g)}>🗑</button>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <p class="empty">Nothing made yet. When we generate, it lands here.</p>
        {/if}
      {:else if tab === 'edit'}
        {#if selectedEdit}<section class="workspace-card"><img class="edit-preview" src={selectedEdit.url} alt="Edit preview" style:filter={`brightness(${editBrightness}%) contrast(${editContrast}%) hue-rotate(${editHue}deg)`} style:transform={`scale(${editZoom}) rotate(${editRotate}deg)`}/><div class="sliders"><label>Crop<select class="field select" bind:value={editCrop}><option value="1">1:1</option><option value="0.8">4:5</option><option value="0.6667">2:3</option><option value="1.7778">16:9</option></select></label><label>Zoom<input type="range" min="1" max="3" step="0.05" bind:value={editZoom}/></label><label>Rotate<input type="range" min="-180" max="180" bind:value={editRotate}/></label><label>Brightness<input type="range" min="20" max="180" bind:value={editBrightness}/></label><label>Contrast<input type="range" min="20" max="180" bind:value={editContrast}/></label><label>Hue<input type="range" min="-180" max="180" bind:value={editHue}/></label></div><div class="generate-actions"><button class="btn-soft" onclick={resetEdit}>Reset</button><button class="primary" onclick={applyEdit}>Apply & download</button></div><canvas class="hidden-canvas" bind:this={editorCanvas}></canvas></section>{:else}<p class="empty">Choose an image from Gallery, then tap Edit.</p>{/if}
      {:else if tab === 'sketch'}
        <section class="workspace-card"><canvas class="sketch" width="768" height="768" bind:this={sketchCanvas} onpointerdown={startDraw} onpointermove={draw} onpointerup={stopDraw} onpointercancel={stopDraw}></canvas><div class="draw-tools"><button class="chip" class:active={drawTool==='brush'} onclick={() => drawTool='brush'}>Brush</button><button class="chip" class:active={drawTool==='eraser'} onclick={() => drawTool='eraser'}>Eraser</button><input type="color" bind:value={drawColor} aria-label="Brush color"/><input type="range" min="1" max="60" bind:value={brushSize} aria-label="Brush size"/><button class="btn-soft" onclick={undoSketch}>Undo</button><button class="btn-soft" onclick={clearSketch}>Clear</button><button class="primary" onclick={useSketch}>Use as Ref.</button></div></section>
      {:else if tab === 'stickers'}
        <StickerManager />
      {/if}
    </div>
  </div>
{/if}

<InputModal
  bind:open={createOpen}
  title="New drawer"
  placeholder="e.g. sample subject, sample subject, a jungle"
  bind:value={createValue}
  showEmoji
  bind:emoji={createEmoji}
  confirmLabel="Create"
  onconfirm={confirmCreate}
  oncancel={() => (createOpen = false)}
/>

<InputModal
  open={renameTarget !== null}
  title="Rename drawer"
  bind:value={renameValue}
  showEmoji
  bind:emoji={renameEmoji}
  confirmLabel="Rename"
  onconfirm={confirmRename}
  oncancel={() => (renameTarget = null)}
/>

<ConfirmDialog
  open={deleteDrawerTarget !== null}
  title="Delete drawer?"
  message={deleteDrawerTarget ? `"${deleteDrawerTarget.label}" and all its references will be removed. This can't be undone.` : ''}
  confirmLabel="Delete"
  destructive
  onconfirm={confirmDeleteDrawer}
  oncancel={() => (deleteDrawerTarget = null)}
/>

<ConfirmDialog
  open={deleteGalleryTarget !== null}
  title="Delete image?"
  message="It's removed from the gallery and from the chat where it was sent. This can't be undone."
  confirmLabel="Delete"
  destructive
  onconfirm={confirmDeleteGallery}
  oncancel={() => (deleteGalleryTarget = null)}
/>

{#if previewItem}
  <div class="lightbox" role="dialog" aria-label="Gallery image">
    <button class="lightbox-close" onclick={() => (previewItem = null)} aria-label="Close">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
    <button class="lightbox-backdrop" onclick={() => (previewItem = null)} aria-label="Close"></button>
    <div class="lightbox-shell">
      {#if previewItem.mediaType === 'video'}<video src={previewItem.url} controls autoplay><track kind="captions" /></video>{:else}<img src={previewItem.url} alt={previewItem.prompt ?? ''} />{/if}
      <div class="viewer-meta"><strong>{previewItem.model ?? 'Legacy render'}</strong><span>{previewItem.prompt ?? 'No prompt metadata'}</span></div>
      <div class="lightbox-bar">
        <a class="btn-soft" href={previewItem.url} download={previewItem.filename}>Download</a>
        {#if previewItem.threadId && previewItem.messageId}
          <button class="btn-soft" onclick={() => { const t = previewItem!.threadId!; const m = previewItem!.messageId!; previewItem = null; jumpTo(t, m); }}>Go to chat</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* Drawer shell — mirrors StarredDrawer for app consistency. */
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 80;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100%);
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    z-index: 81;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3);
  }
  .drawer-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1rem 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .drawer-header h2 {
    font-family: var(--font-heading);
    font-size: 1.125rem;
    font-weight: 500;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0;
    margin-right: auto;
  }
  .close-btn {
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .close-btn:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }
  .filters {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .filter-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 0.35rem 0.65rem;
    border-radius: 999px;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .filter-btn:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }
  .filter-btn.active {
    color: var(--accent);
    background: var(--bg-active);
    border-color: var(--border);
  }
  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
  }
  .workspace-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); padding: .8rem; margin-bottom: .75rem; display: grid; gap: .7rem; }
  .prompt { resize: vertical; min-height: 7rem; line-height: 1.4; }
  .control-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem; }
  .control-grid label, .sliders label { display: grid; gap: .25rem; color: var(--text-muted); font-size: .72rem; text-transform: capitalize; }
  .subject-picker { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
  .subject-picker .row-label { width: 100%; }
  .chip { border: 1px solid var(--border); border-radius: 999px; background: var(--bg-secondary); color: var(--text-muted); padding: .3rem .55rem; cursor: pointer; }
  .chip.active { color: var(--accent); border-color: var(--accent); background: var(--bg-active); }
  .chip small { opacity: .65; }
  .generate-actions, .draw-tools { display: flex; gap: .45rem; flex-wrap: wrap; align-items: center; }
  .primary { border: 0; border-radius: 7px; padding: .48rem .8rem; background: var(--accent); color: var(--bg-primary); cursor: pointer; }
  .primary:disabled { opacity: .45; cursor: default; }
  .job { display: grid; grid-template-columns: auto 1fr; gap: .35rem .55rem; align-items: center; padding: .45rem 0; border-top: 1px solid var(--border); font-size: .78rem; }
  .status { border-radius: 999px; padding: .15rem .4rem; font-size: .65rem; text-transform: uppercase; background: var(--bg-secondary); }
  .status.running { color: var(--accent); } .status.completed { color: #65b884; } .status.failed, .job-error { color: var(--danger, #d66); }
  .job-error { grid-column: 2; }
  .meta { display: grid; gap: .15rem; padding: .4rem .5rem 0; font-size: .72rem; min-width: 0; }
  .meta span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
  .compact { margin: .4rem .5rem; width: calc(100% - 1rem); }
  .gal-thumb video { width: 100%; height: 100%; object-fit: cover; }
  .edit-preview { display: block; width: 100%; max-height: 360px; object-fit: contain; transition: filter .1s, transform .1s; }
  .sliders { display: grid; gap: .45rem; }
  .sliders label { grid-template-columns: 6rem 1fr; align-items: center; }
  .hidden-canvas { display: none; }
  .sketch { width: 100%; aspect-ratio: 1; background: #171717; border: 1px solid var(--border); border-radius: 8px; touch-action: none; }
  .viewer-meta { display: grid; gap: .3rem; padding: .6rem; color: var(--text-muted); }
  .lightbox-shell video { display: block; max-width: min(90vw, 960px); max-height: 78vh; }

  /* Engine selector — pill pair. */
  .eng-tabs { display: flex; gap: 0.25rem; }
  .eng-tab {
    flex: 1; padding: 0.375rem 0.5rem;
    background: var(--bg-surface, var(--bg-primary)); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-muted);
    font-size: 0.75rem; letter-spacing: 0.04em; cursor: pointer; white-space: nowrap;
    transition: all var(--transition);
  }
  .eng-tab:hover { color: var(--accent); background: var(--bg-hover); }
  .eng-tab.active { color: var(--accent); border-color: var(--accent); background: var(--bg-active); }
  .eng-tab:disabled { opacity: 0.55; cursor: default; }

  .hint { font-size: 0.8125rem; color: var(--text-muted); margin: 0.4rem 0 0.75rem; line-height: 1.4; }
  .empty { font-size: 0.8125rem; color: var(--text-muted); margin: 0.25rem 0 0.5rem; }

  .ref-block { margin-bottom: 1.25rem; }
  .ref-head { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.5rem; }
  .ref-name { font-family: var(--font-heading); font-size: 0.95rem; color: var(--text-primary); flex: 1; }

  .icon-btn {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 0.85rem; line-height: 1;
    padding: 0.2rem 0.3rem; border-radius: var(--radius-sm);
    transition: color var(--transition), background var(--transition);
  }
  .icon-btn:hover { color: var(--accent); background: var(--bg-hover); }
  .icon-btn.danger:hover { color: var(--status-error, #c0392b); }

  .new-drawer-btn {
    width: 100%; padding: 0.5rem; margin-top: 0.25rem;
    background: transparent; border: 1px dashed var(--border);
    color: var(--text-muted); border-radius: var(--radius-sm);
    font-size: 0.8125rem; cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
  }
  .new-drawer-btn:hover { color: var(--accent); border-color: var(--accent); }

  .thumb-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
  .thumb {
    position: relative; aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
    background: var(--bg-primary); border: 1px solid var(--border); display: block;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-del {
    position: absolute; top: 3px; right: 3px;
    width: 1.25rem; height: 1.25rem; line-height: 1;
    border: none; border-radius: 50%; background: rgba(0,0,0,0.55); color: #fff;
    cursor: pointer; font-size: 0.9rem; display: flex; align-items: center; justify-content: center;
  }
  .thumb-del:hover { background: var(--status-error, #c0392b); }

  /* Gallery cards — image + thread footer (mirrors Files/Starred linkage). */
  .gal-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.6rem; }
  .gal-card { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-surface, var(--bg-primary)); }
  .gal-thumb { display: block; width: 100%; aspect-ratio: 1; border: none; padding: 0; cursor: pointer; background: var(--bg-primary); }
  .gal-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .gal-foot { display: flex; align-items: center; gap: 0.3rem; padding: 0.3rem 0.4rem; }
  .gal-thread { flex: 1; font-size: 0.7rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gal-thread-link { background: none; border: none; padding: 0; margin: 0; text-align: left; font: inherit; font-size: 0.7rem; color: var(--accent); cursor: pointer; }
  .gal-thread-link:hover { text-decoration: underline; }

  /* Image preview lightbox — mirrors MessageBubble's for app consistency. */
  .lightbox { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .lightbox-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.85); border: none; cursor: pointer; }
  .lightbox-close { position: absolute; top: 1rem; right: 1rem; z-index: 1001; padding: 0.5rem; color: white; background: rgba(255, 255, 255, 0.1); border: none; border-radius: 50%; cursor: pointer; transition: background 0.2s; }
  .lightbox-close:hover { background: rgba(255, 255, 255, 0.2); }
  .lightbox-shell { position: relative; z-index: 1001; display: flex; flex-direction: column; align-items: center; gap: 0.75rem; max-width: 90vw; max-height: 90vh; }
  .lightbox-shell img { max-width: 90vw; max-height: 78vh; object-fit: contain; border-radius: var(--radius-sm); display: block; }
  .lightbox-bar { display: flex; gap: 0.5rem; }
  .lightbox-bar .btn-soft { text-decoration: none; }

  .hidden-file { display: none; }

  .btn-soft {
    background: var(--bg-hover); color: var(--accent); border: none;
    padding: 0.3rem 0.65rem; border-radius: var(--radius-sm); font-size: 0.8125rem; cursor: pointer; white-space: nowrap;
  }
  .btn-soft:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-soft:disabled { opacity: 0.5; cursor: default; }

  .set-block { margin-bottom: 1.25rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .row-label { font-family: var(--font-heading); font-size: 0.95rem; color: var(--text-primary); display: block; margin-bottom: 0.4rem; }
  .row .row-label { margin-bottom: 0; }

  /* Canonical app toggle — no hand-rolled artifacts. */
  .toggle-btn {
    position: relative; width: 2.5rem; height: 1.375rem;
    background: var(--border); border: none; border-radius: 1rem;
    cursor: pointer; padding: 0; flex-shrink: 0; transition: background 0.2s;
  }
  .toggle-btn.on { background: var(--accent); }
  .toggle-btn:disabled { opacity: 0.6; cursor: default; }
  .toggle-btn:focus { outline: none; }
  .toggle-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .toggle-slider {
    position: absolute; top: 2px; left: 2px;
    width: 1rem; height: 1rem; border-radius: 50%;
    background: var(--text-secondary); transition: transform 0.2s, background 0.2s;
  }
  .toggle-btn.on .toggle-slider { transform: translateX(1.125rem); background: white; }

  .key-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.4rem; }
  .key-set { font-size: 0.8125rem; color: var(--status-success, var(--accent)); flex: 1; }
  .field {
    flex: 1; min-width: 0; background: var(--bg-primary); border: 1px solid var(--border);
    color: var(--text-primary); padding: 0.4rem 0.6rem; border-radius: var(--radius-sm); font-size: 0.8125rem; font-family: inherit;
  }
  .field:focus { outline: none; border-color: var(--accent); }
  .field.select { flex: 0 1 auto; cursor: pointer; }

  /* GIF workspace — relocated from the standalone GIF Studio drawer. */
  .gif-studio { display: grid; gap: .7rem; }
  .gif-card { padding: .8rem; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); display: grid; gap: .7rem; }
  .gif-card h3 { margin: 0; font-family: var(--font-heading); font-size: .9rem; }
  .gif-card h3 span { color: var(--text-muted); font-family: inherit; font-weight: normal; }
  .gif-section-head, .gif-actions { display: flex; align-items: center; justify-content: space-between; gap: .4rem; flex-wrap: wrap; }
  .gif-grid { display: grid; gap: .55rem; }
  .gif-two { grid-template-columns: 1fr 1fr; }
  .gif-four { grid-template-columns: repeat(4, 1fr); }
  .gif-studio label { display: grid; gap: .25rem; color: var(--text-muted); font-size: .72rem; }
  .gif-studio input, .gif-studio select, .gif-studio textarea, .gif-studio button, .gif-button { font: inherit; }
  .gif-studio input:not([type=color]):not([type=range]):not([type=checkbox]), .gif-studio select, .gif-studio textarea { min-width: 0; background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); padding: .45rem; border-radius: 6px; }
  .gif-studio textarea { resize: vertical; }
  .gif-button, .gif-studio button { border: 1px solid var(--border); background: var(--bg-hover); color: var(--text-primary); border-radius: 6px; padding: .4rem .65rem; cursor: pointer; text-decoration: none; }
  .gif-studio .primary, .gif-forge { background: var(--accent); color: var(--bg-primary); border-color: transparent; }
  .gif-forge { width: 100%; padding: .65rem; font-weight: 700; }
  .gif-studio button:disabled { opacity: .5; cursor: default; }
  .gif-preview { height: 260px; display: flex; justify-content: center; background: repeating-conic-gradient(#222 0 25%,#2d2d2d 0 50%) 50%/18px 18px; border-radius: 8px; overflow: hidden; }
  .gif-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .gif-timeline { display: flex; gap: .35rem; overflow-x: auto; padding-bottom: .3rem; }
  .gif-timeline button { position: relative; padding: 2px; min-width: 64px; height: 64px; background: var(--bg-secondary); opacity: .55; }
  .gif-timeline button.selected { opacity: 1; border-color: var(--accent); }
  .gif-timeline button.active { box-shadow: 0 0 0 2px var(--accent); }
  .gif-timeline img { width: 100%; height: 100%; object-fit: cover; }
  .gif-timeline span { position: absolute; bottom: 2px; right: 3px; background: rgba(0,0,0,.7); color: white; font-size: .6rem; padding: 1px 3px; }
  .gif-studio details { border-top: 1px solid var(--border); padding-top: .6rem; display: grid; gap: .6rem; }
  .gif-studio summary { cursor: pointer; color: var(--accent); font-size: .8rem; }
  .gif-colors { display: flex; gap: .3rem; }
  .gif-check { display: flex !important; align-items: center; align-self: end; padding: .45rem; }
  .gif-status, .gif-error { margin: 0; padding: .6rem; border-radius: 7px; font-size: .8rem; }
  .gif-status { background: var(--bg-active); color: var(--accent); }
  .gif-status span { display: inline-block; width: .7rem; height: .7rem; margin-right: .4rem; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: gif-spin .7s linear infinite; }
  .gif-error { background: rgba(190,60,60,.14); color: var(--status-error,#e47777); }
  .gif-hint { margin: 0; color: var(--text-muted); font-size: .7rem; }
  .gif-over { border-color: var(--status-error,#e47777); }
  .gif-over h3 { color: var(--status-error,#e47777); }
  .gif-result img { display: block; max-width: 100%; max-height: 360px; margin: auto; }
  .gif-result p { margin: 0; color: var(--text-muted); font-size: .8rem; }
  .gif-result .ok { color: var(--status-success,#65b884); }
  @keyframes gif-spin { to { transform: rotate(360deg); } }
  @media (max-width: 520px) { .gif-four { grid-template-columns: 1fr 1fr; } .gif-preview { height: 220px; } }

  /* ── Contained polish pass (theme tokens, cues, rhythm) ─────────────── */

  /* 1 · Native form controls adopt the app accent instead of browser blue.
     Covers range fill, checkbox ticks, and radio dots app-wide in the drawer. */
  .drawer input[type='range'],
  .drawer input[type='checkbox'] {
    accent-color: var(--accent);
  }

  /* Range sliders — theme the track + thumb so they match AppearancePanel's slider. */
  .drawer input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 0.375rem;
    border-radius: 0.25rem;
    background: var(--bg-surface, var(--bg-secondary));
    cursor: pointer;
  }
  .drawer input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
    transition: transform var(--transition);
  }
  .drawer input[type='range']::-webkit-slider-thumb:hover { transform: scale(1.2); }
  .drawer input[type='range']::-moz-range-thumb {
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
  }
  .drawer input[type='range']::-moz-range-track {
    height: 0.375rem;
    border-radius: 0.25rem;
    background: var(--bg-surface, var(--bg-secondary));
  }
  /* Focus rings adopt the accent, not the browser default. */
  .drawer button:focus-visible,
  .drawer input:focus-visible,
  .drawer select:focus-visible,
  .drawer textarea:focus-visible,
  .drawer a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  /* 2 · Tab bar edge fade — signals the row scrolls when tabs overflow. */
  .filters {
    position: relative;
    scroll-behavior: smooth;
    scrollbar-width: none;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 0.75rem, #000 calc(100% - 1.25rem), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 0.75rem, #000 calc(100% - 1.25rem), transparent 100%);
  }
  .filters::-webkit-scrollbar { display: none; }

  /* 4 · Lift secondary/muted copy toward a readable 1am contrast. */
  .hint, .empty,
  .control-grid label, .sliders label, .gif-studio label,
  .gal-thread, .gif-result p {
    color: var(--text-secondary);
  }
  .meta span, .chip small { color: var(--text-secondary); }

  /* 5 · Gallery action tap targets — bigger hit areas on mobile. */
  .gal-foot .icon-btn {
    min-width: 2rem;
    min-height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
  }
  .gal-foot { gap: 0.15rem; padding: 0.35rem 0.4rem; flex-wrap: wrap; }

  /* 7 · Primary actions read as unmistakably primary. */
  .primary, .gif-forge, .gif-studio .primary {
    font-weight: 600;
    letter-spacing: 0.01em;
    box-shadow: 0 1px 6px var(--gold-glow, rgba(0,0,0,0.2));
  }
  .primary:hover:not(:disabled),
  .gif-forge:hover:not(:disabled),
  .gif-studio .primary:hover:not(:disabled) {
    background: var(--accent-hover, var(--accent));
  }
  .generate-actions .primary { padding: 0.5rem 1rem; }

  /* 8 · Normalize field heights + section rhythm for a calm hierarchy. */
  .field, .gif-studio input:not([type=color]):not([type=range]):not([type=checkbox]),
  .gif-studio select, .gif-studio textarea {
    min-height: 2.1rem;
  }
  .workspace-card, .gif-card { padding: 0.9rem; }
  .set-block, .ref-block { margin-bottom: 1rem; }
  .gif-studio summary { padding: 0.15rem 0; }

  /* 9 · Keep the finished-GIF actions in reach when the panel is long. */
  .gif-result-bar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    margin: 0 -0.9rem -0.9rem;
    padding: 0.6rem 0.9rem;
    background: linear-gradient(to top, var(--bg-primary) 70%, transparent);
    border-top: 1px solid var(--border);
  }

  /* 10 · Narrow Android + keyboard open — never let the page scroll sideways. */
  .drawer { max-width: 100vw; }
  .drawer-body { overscroll-behavior: contain; }
  .control-grid, .gif-two, .gif-four { min-width: 0; }
  .control-grid label, .gif-studio label, .sliders label { min-width: 0; }
  .field, .gif-studio input, .gif-studio select, .gif-studio textarea { max-width: 100%; }
  @media (max-width: 400px) {
    .control-grid { grid-template-columns: 1fr; }
  }
</style>
