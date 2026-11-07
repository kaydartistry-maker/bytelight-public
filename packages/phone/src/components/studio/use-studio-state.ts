// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
import { useState, useRef, useEffect, useCallback, type ChangeEvent, type MouseEvent, type TouchEvent } from 'react';
import { apiFetch } from '../../bytelight';
import { DRAW_CANVAS_BACKGROUND_BY_THEME, ANTIGRAVITY_DEFAULT_MODEL, clampDimension } from './constants';
import { galleryItemToImage } from './gallery-utils';
import { saveHref } from '../../lib/download';
import type { ViewMode, Backend, AspectRatioValue, DrawTool, GeneratedImage, StudioFolder, RefDrawer, UseStudioStateParams } from './types';
import { MAX_ONE_OFF_REFS, oneOffUploadError, parseOneOffRef, type OneOffRef } from './one-off-refs';

export function useStudioState({
  themeMode,
  codexModels,
  antigravityModels,
  openartModels,
  promptStyles,
  sizePresets,
}: UseStudioStateParams) {
  const [drawers, setDrawers] = useState<RefDrawer[]>([]);
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>([]);
  const [oneOffRefs, setOneOffRefs] = useState<OneOffRef[]>([]);
  const oneOffRefsRef = useRef<OneOffRef[]>([]);
  const oneOffUploadRef = useRef<Promise<void>>(Promise.resolve());

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('generate');

  // Codex (GPT) model state — persist selection across sessions
  const [codexModel, setCodexModel] = useState(() => {
    try { return localStorage.getItem('bytelight-studio-codex-model') || codexModels[1]?.id || 'gpt-image-2'; } catch { return codexModels[1]?.id || 'gpt-image-2'; }
  });
  // Antigravity (Gemini) model state
  const [agyModel, setAgyModel] = useState(() => {
    // A stored id survives a model being retired upstream, so validate it
    // against the live list rather than trusting whatever is in localStorage.
    const fallback = antigravityModels.find(m => m.id === ANTIGRAVITY_DEFAULT_MODEL)?.id ?? antigravityModels[0].id;
    try {
      const saved = localStorage.getItem('bytelight-studio-agy-model');
      return saved && antigravityModels.some(m => m.id === saved) ? saved : fallback;
    } catch { return fallback; }
  });
  // OpenArt model state — holds the picker key (kling appears once per media)
  const [openartModel, setOpenartModel] = useState(() => {
    try { return localStorage.getItem('bytelight-studio-openart-model') || openartModels[0].key; } catch { return openartModels[0].key; }
  });
  // Backend state persistence
  const [backend, setBackendState] = useState<Backend>(() => {
    try { return (localStorage.getItem('bytelight-studio-backend') as Backend) || 'codex'; } catch { return 'codex'; }
  });
  const setBackend = useCallback((b: Backend) => {
    setBackendState(b);
    try { localStorage.setItem('bytelight-studio-backend', b); } catch {}
  }, []);

  // Generation state
  const [size, setSize] = useState<AspectRatioValue>('square');
  const [customWidth, setCustomWidth] = useState(1024);
  const [customHeight, setCustomHeight] = useState(1024);
  const [prompt, setPrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [activeJobs, setActiveJobs] = useState<Array<{ id: string; status: string; prompt: string }>>([]);
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Results state
  const [currentImage, setCurrentImage] = useState<GeneratedImage | null>(null);
  const [history, setHistory] = useState<GeneratedImage[]>([]);
  const [folders, setFolders] = useState<StudioFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [currentRefFilter, setCurrentRefFilter] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Edit state
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [hue, setHue] = useState(0);
  const [cropAspect, setCropAspect] = useState<number>(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);

  // Draw state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawColor, setDrawColor] = useState('#ffffff');
  const [brushSize, setBrushSize] = useState(5);
  const [drawTool, setDrawTool] = useState<DrawTool>('brush');
  const [drawHistory, setDrawHistory] = useState<string[]>([]);

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [showStylePicker, setShowStylePicker] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const [showSubjects, setShowSubjects] = useState(false);
  const [viewingImage, setViewingImage] = useState<GeneratedImage | null>(null);
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerPan, setViewerPan] = useState({ x: 0, y: 0 });
  const [confirmDelete, setConfirmDelete] = useState<GeneratedImage | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // Refs management state
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [newDrawerName, setNewDrawerName] = useState('');
  const [creatingDrawer, setCreatingDrawer] = useState(false);
  const refInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const currentOpenartModel = openartModels.find(m => m.key === openartModel);

  const reloadRecent = useCallback(async () => {
    const response = await apiFetch('/api/studio/gallery');
    if (!response.ok) throw new Error(`Gallery request failed (${response.status})`);
    const data = await response.json();
    const recent = Array.isArray(data.items) ? data.items.map(galleryItemToImage) : [];
    setHistory(recent.slice(0, 30));
    return recent;
  }, []);

  // Persist model selections to localStorage
  useEffect(() => { try { localStorage.setItem('bytelight-studio-codex-model', codexModel); } catch {} }, [codexModel]);
  useEffect(() => { try { localStorage.setItem('bytelight-studio-agy-model', agyModel); } catch {} }, [agyModel]);
  useEffect(() => { try { localStorage.setItem('bytelight-studio-openart-model', openartModel); } catch {} }, [openartModel]);

  // Fetch reference drawers from backend
  useEffect(() => {
    const fetchDrawers = async () => {
      try {
        const r = await apiFetch('/api/studio/refs');
        if (r.ok) {
          const data = await r.json();
          if (data.drawers) setDrawers(data.drawers);
        }
      } catch { /* ignore */ }
    };

    fetchDrawers();
  }, []);

  // Track job IDs we've already processed so we don't add duplicates to history
  const processedJobsRef = useRef<Set<string>>(new Set());

  // Poll for all active jobs. This handles both recovery on remount and
  // queueing multiple jobs — when a job completes, add it to history.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const check = async () => {
      try {
        const r = await apiFetch('/api/studio/jobs');
        if (!r.ok || !alive) return;
        const data = await r.json();
        const jobs = data.jobs || [];

        // Find active jobs to set generating state and display queue
        const active = jobs.filter((job: any) => job.status === 'pending' || job.status === 'running');
        setGenerating(active.length > 0);
        setActiveJobs(active.map((job: any) => ({ id: job.id, status: job.status, prompt: job.prompt || '' })));

        // Find newly completed jobs and add to history. The jobs list is
        // newest-first, so the first collected image is the latest one.
        const completedNew: GeneratedImage[] = [];
        for (const job of jobs) {
          if (job.status === 'completed' && job.url && !processedJobsRef.current.has(job.id)) {
            processedJobsRef.current.add(job.id);
            const newImage: GeneratedImage = {
              id: job.filename || job.id,
              src: job.url,
              prompt: job.prompt || '',
              model: job.model || 'unknown',
              backend: job.backend || 'codex',
              width: Number(job.width) || 1024,
              height: Number(job.height) || 1024,
              timestamp: job.completedAt || Date.now(),
              sourcePrompt: job.sourcePrompt || undefined,
              styleId: job.styleId || undefined,
              references: job.referenceDrawers || [],
              referenceDrawers: job.referenceDrawers || [],
              aspectRatio: job.aspectRatio || undefined,
              mediaType: job.mediaType || 'image',
            };
            setHistory(prev => {
              // Don't add if already in history (by id/filename)
              if (prev.some(img => img.id === newImage.id)) return prev;
              return [newImage, ...prev].slice(0, 30);
            });
            completedNew.push(newImage);
          }
        }
        // Preview lands on the newest finished image — on remount the sweep
        // recovers several at once and the oldest must not win the last write.
        if (completedNew.length > 0) setCurrentImage(completedNew[0]);

        // Continue polling if there are active jobs
        if (active.length > 0) {
          timer = window.setTimeout(check, 500);
        } else {
          // Slower poll when idle to catch new jobs
          timer = window.setTimeout(check, 2000);
        }
      } catch { /* the global tray will retry too */ }
    };
    void check();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, []);

  // Load history from server gallery + folders
  useEffect(() => {
    const loadServerData = async () => {
      let serverLoaded = false;
      try {
        // Load gallery from server (persistent across devices)
        await reloadRecent();
        serverLoaded = true;
        // The server gallery is the source of truth. Keep only a small recent
        // rail on-device; the full archive is cursor-paged by Gallery.
        try { localStorage.removeItem('bytelight-studio-history'); } catch {}

        // Load folders from server
        const foldersRes = await apiFetch('/api/studio/folders');
        if (foldersRes.ok) {
          const data = await foldersRes.json();
          if (data.folders && Array.isArray(data.folders)) {
            setFolders(data.folders);
          }
        }
      } catch (e) {
        console.error('Failed to load studio data from server:', e);
      }

      // Only fall back to localStorage if server didn't load
      if (!serverLoaded) {
        try {
          const saved = localStorage.getItem('bytelight-studio-history');
          if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) setHistory(parsed.slice(0, 30));
          }
        } catch {}
      }
      setHistoryLoaded(true);
    };
    loadServerData();
  }, [reloadRecent]);

  // Folders are now synced to server, no localStorage save needed for them

  // Initialize drawing canvas
  useEffect(() => {
    if (viewMode === 'draw') {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = DRAW_CANVAS_BACKGROUND_BY_THEME[themeMode];
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      setDrawHistory([canvas.toDataURL()]);
    }
  }, [viewMode, themeMode]);

  const toggleSubject = (slug: string) => {
    setSelectedSubjects(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  // Each file uploads on its own: one the server refuses is reported and the
  // rest of the batch still goes, as the desktop Studio does it.
  const addOneOffRefs = (files: File[]) => {
    oneOffUploadRef.current = oneOffUploadRef.current.then(async () => {
      const capacity = MAX_ONE_OFF_REFS - oneOffRefsRef.current.length;
      const accepted = files.slice(0, Math.max(0, capacity));
      const failures: string[] = [];
      for (const file of accepted) {
        try {
          const form = new FormData();
          form.append('file', file);
          const response = await apiFetch('/api/studio/one-off-refs', { method: 'POST', body: form });
          const data: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(oneOffUploadError(data));
          const reference = parseOneOffRef(file.name, data);
          if (!reference) throw new Error('Reference upload returned no token');
          if (oneOffRefsRef.current.length < MAX_ONE_OFF_REFS) {
            oneOffRefsRef.current = [...oneOffRefsRef.current, reference];
            setOneOffRefs(oneOffRefsRef.current);
          }
        } catch (cause) {
          failures.push(`${file.name}: ${cause instanceof Error ? cause.message : 'Reference upload failed.'}`);
        }
      }
      if (failures.length) setError(failures.join(' · '));
    });
  };
  const replaceOneOffRefs = (refs: OneOffRef[]) => {
    oneOffRefsRef.current = refs.slice(0, MAX_ONE_OFF_REFS);
    setOneOffRefs(oneOffRefsRef.current);
  };

  // Refs management functions
  const loadDrawers = async () => {
    try {
      const r = await apiFetch('/api/studio/refs');
      if (r.ok) {
        const data = await r.json();
        if (data.drawers) {
          setDrawers(data.drawers);
          const live = new Set<string>(data.drawers.map((drawer: RefDrawer) => drawer.slug));
          setSelectedSubjects((current) => current.filter((slug) => live.has(slug)));
        }
      } else {
        const data = await r.json().catch(() => ({}));
        setError(data.error || 'References could not be refreshed');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'References could not be refreshed');
    }
  };

  const uploadRefImage = async (slug: string, file: File) => {
    const maxBytes = 25 * 1024 * 1024;
    if (file.size > maxBytes) {
      setError(`${file.name} is larger than the 25 MB reference limit.`);
      return;
    }
    // Android document providers frequently omit or generalize MIME. The
    // backend validates the actual byte signature and returns a clear 415.
    setUploadingFor(slug);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const r = await apiFetch(`/api/studio/refs/${encodeURIComponent(slug)}`, {
        method: 'POST',
        body: formData,
      });
      if (r.ok) {
        await loadDrawers();
      } else {
        const data = await r.json().catch(() => ({}));
        setError(data.error || 'Upload failed');
      }
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploadingFor(null);
    }
  };

  const deleteRefImage = async (slug: string, filename: string) => {
    setError(null);
    try {
      const r = await apiFetch(`/api/studio/refs/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({ success: true }));
        if (data.success === false) throw new Error(data.error || 'Reference was not found');
        await loadDrawers();
      } else {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${r.status})`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reference could not be deleted');
    }
  };

  const createDrawer = async () => {
    if (!newDrawerName.trim() || creatingDrawer) return;
    setCreatingDrawer(true);
    try {
      const r = await apiFetch('/api/studio/drawers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newDrawerName.trim() }),
      });
      if (r.ok) {
        setNewDrawerName('');
        await loadDrawers();
      } else {
        const data = await r.json();
        setError(data.error || 'Could not create drawer');
      }
    } catch (err: any) {
      setError(err.message || 'Could not create drawer');
    } finally {
      setCreatingDrawer(false);
    }
  };

  // Rename a custom drawer: PATCH /api/studio/drawers/:slug with { label, emoji }.
  // The backend refuses the default drawers; the panel only offers custom ones.
  const renameDrawer = async (slug: string, label: string, emoji?: string): Promise<boolean> => {
    try {
      const r = await apiFetch(`/api/studio/drawers/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, emoji }),
      });
      if (r.ok) {
        await loadDrawers();
        return true;
      }
      const data = await r.json().catch(() => ({}));
      setError(data.error || 'Could not rename.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename.');
    }
    return false;
  };

  const deleteDrawer = async (slug: string) => {
    try {
      const r = await apiFetch(`/api/studio/drawers/${slug}`, {
        method: 'DELETE',
      });
      if (r.ok) {
        setSelectedSubjects((current) => current.filter((subject) => subject !== slug));
        await loadDrawers();
      } else {
        const data = await r.json().catch(() => ({}));
        setError(data.error || 'Drawer could not be deleted');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Drawer could not be deleted');
    }
  };

  const handleRefFileChange = async (slug: string, e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      await uploadRefImage(slug, file);
    }
    e.target.value = '';
  };

  const buildFullPrompt = () => {
    let fullPrompt = prompt.trim();
    if (selectedStyle) {
      const style = promptStyles.find(s => s.name === selectedStyle);
      if (style && style.style) {
        fullPrompt = `${fullPrompt}, ${style.style}`;
      }
    }
    return fullPrompt;
  };

  const getImageDimensions = (): { width: number; height: number } => {
    // Clamped here as well as in the field: the field holds what she typed
    // until it loses focus, so an in-progress number must never leave the phone.
    if (size === 'custom') return { width: clampDimension(customWidth), height: clampDimension(customHeight) };
    const preset = sizePresets.find(p => p.value === size);
    if (preset?.dims) {
      const [w, h] = preset.dims.split('×').map(Number);
      return { width: w, height: h };
    }
    // Fallbacks for legacy values
    if (size === 'portrait') return { width: 1024, height: 1536 };
    if (size === 'landscape') return { width: 1536, height: 1024 };
    return { width: 1024, height: 1024 };
  };

  const handleEnhance = async () => {
    if (!prompt.trim() || enhancing) return;
    setEnhancing(true);
    setError(null);

    try {
      // If using Codex backend, pass the model so we use that for enhancement
      const body: Record<string, string> = { prompt: prompt.trim() };
      if (backend === 'codex' && codexModel) {
        body.backend = 'codex';
        body.codexModel = codexModel;
      }

      const res = await apiFetch('/api/studio/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const { enhanced } = await res.json();
      if (enhanced) setPrompt(enhanced);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enhancement failed');
    } finally {
      setEnhancing(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setError(null);

    try {
      // Every backend runs through our async job pipeline. Submit and return
      // immediately — the polling effect will pick up completion.
      const startRes = await apiFetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: buildFullPrompt(),
          sourcePrompt: prompt.trim(),
          styleId: selectedStyle || undefined,
          subjects: selectedSubjects.length > 0 ? selectedSubjects : undefined,
          oneOffRefs: oneOffRefs.map((reference) => reference.token),
          size,
          backend,
          ...(backend === 'codex' ? { codexModel } : {}),
          ...(backend === 'antigravity' ? { agyModel } : {}),
          ...(backend === 'openart' && currentOpenartModel
            ? { openartModel: currentOpenartModel.id, openartMedia: currentOpenartModel.media }
            : {}),
          ...(size === 'custom' ? { customWidth: clampDimension(customWidth), customHeight: clampDimension(customHeight) } : {}),
        }),
      });

      if (!startRes.ok) {
        const data = await startRes.json();
        throw new Error(data.error || `HTTP ${startRes.status}`);
      }

      const { jobId } = await startRes.json();
      if (!jobId) throw new Error('No job ID returned');

      // Job submitted — the polling effect will handle completion
      setGenerating(true);
      return;
    } catch (err: any) {
      setError(err.message || 'Failed to generate');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = (img: GeneratedImage) => {
    const a = document.createElement('a');
    // Ask for the file, not the view — the native shell only saves what the
    // server marks as an attachment (it ignores the download attribute).
    a.href = saveHref(img.src);
    // Get backend type from model name for the prefix
    let backendPrefix = 'studio';
    const modelLower = img.model.toLowerCase();
    if (modelLower.includes('gemini')) backendPrefix = 'gemini';
    else if (modelLower.includes('codex')) backendPrefix = 'codex';
    else if (modelLower.includes('nano')) backendPrefix = 'nano';
    // Sequential counter per backend, stored in localStorage
    const counterKey = `bytelight-studio-dl-counter-${backendPrefix}`;
    let counter = 1;
    try {
      const stored = localStorage.getItem(counterKey);
      if (stored) counter = parseInt(stored, 10) + 1;
      localStorage.setItem(counterKey, String(counter));
    } catch {}
    // Clean filename: backend-NNNN.png (no prompt, no double extension)
    const ext = img.mediaType === 'video' ? '.mp4' : '.png';
    a.download = `${backendPrefix}-${String(counter).padStart(4, '0')}${ext}`;
    a.click();
  };

  const selectFromHistory = (img: GeneratedImage) => {
    setCurrentImage(img);
    // Load the image's settings into the pickers
    if (img.aspectRatio) {
      const validSizes: AspectRatioValue[] = ['square', 'portrait', 'landscape', '16:9', '9:16', '21:9', '2:3', '3:2', '4:5', '5:4', '3:4', '4:3', 'custom'];
      if (validSizes.includes(img.aspectRatio as AspectRatioValue)) {
        setSize(img.aspectRatio as AspectRatioValue);
        if (img.aspectRatio === 'custom') {
          if (Number.isFinite(img.width) && img.width > 0) setCustomWidth(img.width);
          if (Number.isFinite(img.height) && img.height > 0) setCustomHeight(img.height);
        }
      }
    }
    if (img.backend) {
      setBackend(img.backend as Backend);
    }
    if (img.model) {
      // Set the appropriate model based on backend
      if (img.backend === 'codex') setCodexModel(img.model);
      else if (img.backend === 'antigravity') setAgyModel(img.model);
      else if (img.backend === 'openart') {
        // Meta stores the OpenArt model id; the picker keys on id + media
        const match = openartModels.find(m => m.id === img.model && (!img.mediaType || m.media === img.mediaType));
        if (match) setOpenartModel(match.key);
      }
    }
    const replayDrawers = img.referenceDrawers ?? img.references ?? [];
    const liveDrawers = new Set(drawers.map((drawer) => drawer.slug));
    // A retired scratch drawer (`<person>-temp`) replays onto that person's
    // real drawer, so old images still restore their cast.
    const mergedDrawer = (slug: string) => {
      if (liveDrawers.has(slug)) return slug;
      const base = slug.replace(/-temp$/, '');
      return base !== slug && liveDrawers.has(base) ? base : slug;
    };
    setSelectedSubjects(Array.from(new Set(replayDrawers
      .map(mergedDrawer)
      .filter((slug) => liveDrawers.has(slug)))));
  };

  const clearHistory = () => {
    setHistory([]);
    setCurrentImage(null);
    try { localStorage.removeItem('bytelight-studio-history'); } catch {}
  };

  const deleteFromHistory = async (id: string) => {
    // Remove from local state immediately
    setHistory(prev => prev.filter(img => img.id !== id));
    if (currentImage?.id === id) setCurrentImage(null);
    // Delete from server (id is the filename)
    try {
      await apiFetch(`/api/studio/gallery/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete from server:', e);
    }
  };

  // Edit functions
  const onCropComplete = useCallback((_croppedArea: any, cropPixels: any) => {
    setCroppedAreaPixels(cropPixels);
  }, []);

  const applyEdits = async () => {
    if (!currentImage || !croppedAreaPixels) return;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = currentImage.src;

    await new Promise(resolve => image.onload = resolve);

    const canvas = document.createElement('canvas');
    canvas.width = croppedAreaPixels.width;
    canvas.height = croppedAreaPixels.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) hue-rotate(${hue}deg)`;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(
      image,
      croppedAreaPixels.x,
      croppedAreaPixels.y,
      croppedAreaPixels.width,
      croppedAreaPixels.height,
      -canvas.width / 2,
      -canvas.height / 2,
      canvas.width,
      canvas.height
    );
    ctx.restore();

    const newSrc = canvas.toDataURL('image/png');
    const newImage: GeneratedImage = {
      ...currentImage,
      id: Date.now().toString(),
      src: newSrc,
      timestamp: Date.now(),
    };
    setCurrentImage(newImage);
    setHistory(prev => [newImage, ...prev].slice(0, 30));
    setViewMode('generate');
    resetEditState();
  };

  const resetEditState = () => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
    setBrightness(100);
    setContrast(100);
    setHue(0);
    setCropAspect(1);
  };

  // Draw functions
  const startDrawing = (e: MouseEvent | TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (('touches' in e) ? e.touches[0].clientX - rect.left : (e as MouseEvent).clientX - rect.left) * scaleX;
    const y = (('touches' in e) ? e.touches[0].clientY - rect.top : (e as MouseEvent).clientY - rect.top) * scaleY;

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.strokeStyle = drawTool === 'eraser' ? DRAW_CANVAS_BACKGROUND_BY_THEME[themeMode] : drawColor;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    setIsDrawing(true);
  };

  const draw = (e: MouseEvent | TouchEvent) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (('touches' in e) ? e.touches[0].clientX - rect.left : (e as MouseEvent).clientX - rect.left) * scaleX;
    const y = (('touches' in e) ? e.touches[0].clientY - rect.top : (e as MouseEvent).clientY - rect.top) * scaleY;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) {
      setDrawHistory(prev => [...prev, canvas.toDataURL()].slice(-20));
    }
  };

  const undoDraw = () => {
    if (drawHistory.length <= 1) return;
    const newHistory = drawHistory.slice(0, -1);
    setDrawHistory(newHistory);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.src = newHistory[newHistory.length - 1];
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = DRAW_CANVAS_BACKGROUND_BY_THEME[themeMode];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setDrawHistory([canvas.toDataURL()]);
  };

  // Sketch → reference, as the desktop Studio does it: the canvas goes up as a PNG
  // into the FIRST drawer, the drawers reload, that drawer is selected as a
  // subject, and the view goes back to Generate.
  const [sendingSketch, setSendingSketch] = useState(false);
  const sketchToReference = async () => {
    const canvas = canvasRef.current;
    const target = drawers[0];
    if (!canvas || !target || sendingSketch) return;
    setSendingSketch(true);
    setError(null);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The sketch could not be exported');
      const form = new FormData();
      form.append('file', blob, `sketch-${Date.now()}.png`);
      const r = await apiFetch(`/api/studio/refs/${target.slug}`, { method: 'POST', body: form });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Sketch could not be added as a reference');
      }
      await loadDrawers();
      setSelectedSubjects((current) => current.includes(target.slug) ? current : [...current, target.slug]);
      setViewMode('generate');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sketch could not be added as a reference');
    } finally {
      setSendingSketch(false);
    }
  };

  // Folder functions (synced to server)
  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const res = await apiFetch('/api/studio/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setFolders(prev => [...prev, data.folder]);
      }
    } catch (e) {
      console.error('Failed to create folder:', e);
    }
    setNewFolderName('');
  };

  const deleteFolder = async (id: string) => {
    try {
      await apiFetch(`/api/studio/folders/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete folder:', e);
    }
    setFolders(prev => prev.filter(f => f.id !== id));
    setHistory(prev => prev.map(img => img.folderId === id ? { ...img, folderId: undefined } : img));
    if (currentFolderId === id) setCurrentFolderId(null);
  };

  const moveToFolder = async (imageId: string, folderId: string | null) => {
    const img = history.find(h => h.id === imageId);
    if (!img) return;
    try {
      await apiFetch(`/api/studio/gallery/${encodeURIComponent(img.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      setHistory(prev => prev.map(h => h.id === imageId ? { ...h, folderId: folderId || undefined } : h));
    } catch (e) {
      console.error('Failed to move to folder:', e);
    }
  };

  const filteredHistory = history.filter(img => {
    // Folder filter is optional; the default recent rail spans every folder.
    const folderMatch = currentFolderId ? img.folderId === currentFolderId : true;
    // Ref filter: if a ref is selected, only show images that used that reference
    const refMatch = currentRefFilter
      ? img.references?.includes(currentRefFilter)
      : true;
    return folderMatch && refMatch;
  });

  return {
    backend, setBackend,
    drawers, setDrawers,
    selectedSubjects, setSelectedSubjects,
    oneOffRefs, setOneOffRefs: replaceOneOffRefs, addOneOffRefs,
    viewMode, setViewMode,
    codexModel, setCodexModel,
    agyModel, setAgyModel,
    openartModel, setOpenartModel,
    size, setSize,
    customWidth, setCustomWidth,
    customHeight, setCustomHeight,
    prompt, setPrompt,
    selectedStyle, setSelectedStyle,
    generating, setGenerating,
    activeJobs,
    enhancing, setEnhancing,
    error, setError,
    currentImage, setCurrentImage,
    history, setHistory,
    folders, setFolders,
    currentFolderId, setCurrentFolderId,
    currentRefFilter, setCurrentRefFilter,
    newFolderName, setNewFolderName,
    historyLoaded, setHistoryLoaded,
    crop, setCrop,
    zoom, setZoom,
    rotation, setRotation,
    brightness, setBrightness,
    contrast, setContrast,
    hue, setHue,
    cropAspect, setCropAspect,
    croppedAreaPixels, setCroppedAreaPixels,
    canvasRef,
    isDrawing, setIsDrawing,
    drawColor, setDrawColor,
    brushSize, setBrushSize,
    drawTool, setDrawTool,
    drawHistory, setDrawHistory,
    showSettings, setShowSettings,
    showStylePicker, setShowStylePicker,
    showFolders, setShowFolders,
    showSubjects, setShowSubjects,
    viewingImage, setViewingImage,
    viewerZoom, setViewerZoom,
    viewerPan, setViewerPan,
    confirmDelete, setConfirmDelete,
    historyRef,
    uploadingFor, setUploadingFor,
    newDrawerName, setNewDrawerName,
    creatingDrawer, setCreatingDrawer,
    refInputRefs,
    toggleSubject,
    loadDrawers,
    uploadRefImage,
    deleteRefImage,
    createDrawer,
    renameDrawer,
    deleteDrawer,
    handleRefFileChange,
    buildFullPrompt,
    getImageDimensions,
    handleGenerate,
    handleEnhance,
    handleDownload,
    selectFromHistory,
    clearHistory,
    deleteFromHistory,
    onCropComplete,
    applyEdits,
    resetEditState,
    startDrawing,
    draw,
    stopDrawing,
    undoDraw,
    clearCanvas,
    sketchToReference,
    sendingSketch,
    createFolder,
    deleteFolder,
    moveToFolder,
    filteredHistory,
    reloadRecent,
  };
}
