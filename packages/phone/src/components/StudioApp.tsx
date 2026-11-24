// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download, Eye, Loader2, Palette, Settings, Sparkles, Star, Users, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../bytelight';
import { Button, SegmentedControl } from '../ui';
import { CODEX_MODELS, ANTIGRAVITY_MODELS, OPENART_MODELS, SIZE_PRESETS, RefsPanel, useStudioState, type StudioAppProps, type GeneratedImage } from './studio';
import { RecentGalleryRail } from './studio/RecentGalleryRail';
import { StudioGalleryView } from './studio/StudioGalleryView';
import { MyStylesPanel } from './studio/MyStylesPanel';
import { PromptGamePanel } from './studio/PromptGamePanel';
import { StudioSettingsPanel } from './studio/StudioSettingsPanel';
import { studioRequest, type ImageSettings, type StyleLibrary, type SavedStyle } from './studio/my-styles';
import { ZoomableImage } from './ZoomableImage';
import { StudioTransformPanel } from './studio/StudioTransformPanel';
import { SpellbookPanel } from './studio/SpellbookPanel';
import { DrawingCanvas } from './studio/DrawingCanvas';
import { EditPanel } from './studio/EditPanel';

export function StudioApp({ onClose, onJumpToMessage, themeConfig, themeMode }: StudioAppProps) {
  const colors = themeConfig[themeMode];
  const auth = useAuth();
  const [section, setSection] = useState<'create' | 'gallery' | 'styles' | 'face' | 'smash' | 'spellbook'>('create');
  const [library, setLibrary] = useState<StyleLibrary>({ styles: [], defaultChatStyleId: null });
  const [settings, setSettings] = useState<ImageSettings | null>(null);
  const [styleId, setStyleId] = useState(''), [imageModelId, setImageModelId] = useState('subscription-auto');
  const [busy, setBusy] = useState(false), [enhancing, setEnhancing] = useState(false), [suggestion, setSuggestion] = useState(''), [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(false), [previewBusy, setPreviewBusy] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [writtenSlugs, setWrittenSlugs] = useState<string[]>([]);
  const [galleryDescriptions, setGalleryDescriptions] = useState<NonNullable<GeneratedImage['subjectDescriptions']>>([]);
  const previewRequest = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const state = useStudioState({ themeMode, codexModels: CODEX_MODELS, antigravityModels: ANTIGRAVITY_MODELS, openartModels: OPENART_MODELS, promptStyles: [{ name: 'None', style: '' }], sizePresets: SIZE_PRESETS });
  const { drawers, selectedSubjects, oneOffRefs, setOneOffRefs, addOneOffRefs, viewMode, setViewMode, size, setSize, customWidth, setCustomWidth, customHeight, setCustomHeight, prompt, setPrompt, activeJobs, error, currentImage, setCurrentImage, history, folders, setFolders, uploadingFor, newDrawerName, setNewDrawerName, creatingDrawer, refInputRefs, loadDrawers, deleteRefImage, createDrawer, renameDrawer, deleteDrawer, handleRefFileChange, handleDownload, selectFromHistory, reloadRecent } = state;
  const reloadLibrary = useCallback(async () => setLibrary(await studioRequest<StyleLibrary>('styles')), []);
  const reloadSettings = useCallback(async () => setSettings(await studioRequest<ImageSettings>('settings')), []);
  useEffect(() => {
    if (auth.checking || (auth.required && !auth.authenticated)) return;
    state.setError(null);
    Promise.all([reloadLibrary(), reloadSettings(), loadDrawers(), reloadRecent()]).catch(e => setNotice(e.message));
  }, [auth.checking, auth.required, auth.authenticated, reloadLibrary, reloadSettings]);
  const selectedStyle = library.styles.find(s => s.id === styleId);
  useEffect(() => { ++previewRequest.current; setPreview(false); }, [prompt, styleId, imageModelId, size, customWidth, customHeight, selectedSubjects, writtenSlugs, galleryDescriptions, drawers, oneOffRefs, selectedStyle?.revision]);
  const selectedModel = settings?.models.find(m => m.id === imageModelId);
  useEffect(() => { if (error) setNotice(''); }, [error]);
  const defaultStyle = library.styles.find(s => s.id === library.defaultChatStyleId);
  const photoSubjects = selectedSubjects.flatMap(slug => writtenSlugs.includes(slug) ? [] : drawers.filter(d => d.slug === slug));
  const subjectReferences = {
    subjects: photoSubjects.map(d => d.slug),
    descriptionSubjects: drawers.filter(d => writtenSlugs.includes(d.slug) && !galleryDescriptions.some(ref => ref.slug === d.slug)).map(d => d.slug),
    subjectDescriptions: galleryDescriptions.filter(ref => writtenSlugs.includes(ref.slug) && drawers.some(d => d.slug === ref.slug)),
  };
  const missingDescription = drawers.some(d => subjectReferences.descriptionSubjects.includes(d.slug) && !d.description);
  const refCount = (selectedStyle?.references.length ?? 0) + photoSubjects.reduce((n, d) => n + d.refs.length, 0) + oneOffRefs.length;
  const chooseSubjectMode = (slug: string, mode: 'none' | 'description' | 'photos') => {
    state.setSelectedSubjects(prev => mode === 'photos' ? [...prev.filter(s => s !== slug), slug] : prev.filter(s => s !== slug));
    setWrittenSlugs(prev => mode === 'description' ? [...prev.filter(s => s !== slug), slug] : prev.filter(s => s !== slug));
    setGalleryDescriptions(prev => prev.filter(ref => ref.slug !== slug));
  };
  const panel = cn('rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const field = cn('rounded-xl border p-3 text-sm w-full', colors.panelBg, colors.panelBorder, colors.textMain);
  const go = (next: typeof section) => { setSection(next); setViewMode('generate'); setNotice(''); };
  const usePrompt = (image: GeneratedImage, setup: boolean) => {
    if (setup) { selectFromHistory(image); setImageModelId(image.imageModelId ?? (image.backend === 'openai' && settings?.models.some(m => m.id === image.model) ? image.model : 'subscription-auto')); }
    setPrompt(image.sourcePrompt ?? image.prompt); setSuggestion('');
    if (setup) {
      const descriptions = image.subjectDescriptions ?? [];
      setWrittenSlugs(descriptions.map(ref => ref.slug));
      setGalleryDescriptions(descriptions);
      const saved = library.styles.find(s => s.id === image.styleId); setStyleId(saved?.id ?? '');
      if (image.styleId && !saved) setNotice('That saved style was deleted. The scene was restored without it.');
    } else setStyleId('');
    setSection('create'); setViewMode('generate');
  };
  const generate = async () => {
    if (busy) return; setBusy(true); setNotice('');
    try {
      if (styleId && !selectedStyle) throw new Error('This style was deleted. Select a style again.');
      await studioRequest('generate', 'POST', { prompt, sourcePrompt: prompt, styleId, imageModelId, ...subjectReferences, oneOffRefs: oneOffRefs.map(r => r.token), size, customWidth, customHeight, async: true });
      setNotice('Image submitted. Generation status appears in the job tray.');
    } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  };
  const enhance = async () => { setEnhancing(true); setNotice(''); try { const r = await studioRequest<{ enhanced: string }>('enhance', 'POST', { prompt, styleId }); setSuggestion(r.enhanced); } catch (e) { setNotice((e as Error).message); } finally { setEnhancing(false); } };
  const star = async () => { try { setLibrary(await studioRequest<StyleLibrary>('styles/default-chat', 'PUT', { styleId: library.defaultChatStyleId === styleId ? null : styleId })); } catch (e) { setNotice((e as Error).message); } };
  const showPreview = async () => {
    if (preview) { setPreview(false); return; }
    const request = ++previewRequest.current;
    setPreviewBusy(true); setNotice('');
    try {
      const data = await studioRequest<{ prompt: string; style: SavedStyle | null }>('preview', 'POST', { prompt, styleId, imageModelId, ...subjectReferences });
      if (request === previewRequest.current) { setPreviewText(data.prompt); setPreview(true); }
    } catch (e) { if (request === previewRequest.current) setNotice((e as Error).message); } finally { setPreviewBusy(false); }
  };
  const nav = <div className={cn(panel, 'space-y-3')}>
    <div className="flex items-center gap-2"><button aria-label="Close Studio" onClick={onClose} className="p-2 -ml-2 rounded-xl"><ChevronLeft className="h-5 w-5" /></button><Palette className="h-5 w-5" style={{ color: colors.accent }} /><h1 className="font-semibold flex-1">Art Studio</h1><button aria-label="Manage subject references" onClick={() => { setSection('create'); setViewMode(viewMode === 'refs' ? 'generate' : 'refs'); }} className="p-2 rounded-xl"><Users className="h-5 w-5" /></button><button aria-label="Studio settings" onClick={() => { setSection('create'); setViewMode(viewMode === 'settings' ? 'generate' : 'settings'); }} className="p-2 rounded-xl"><Settings className="h-5 w-5" /></button></div>
    <SegmentedControl colors={colors} options={[{ value: 'create', label: 'Create' }, { value: 'gallery', label: 'Gallery' }, { value: 'styles', label: 'My Styles' }]} value={section} onChange={go} />
    <div className="grid grid-cols-2 gap-2">{([{ id: 'face', label: 'Face Transplant' }, { id: 'smash', label: 'Smash & Mash' }, { id: 'spellbook', label: 'Spellbook' }] as const).map(tool => <button key={tool.id} aria-pressed={section === tool.id} onClick={() => go(tool.id)} className={cn('rounded-xl border px-3 py-2 text-xs font-medium', colors.panelBorder)} style={section === tool.id ? { backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' } : {}}>{tool.label}</button>)}<button className={cn('rounded-xl border px-3 py-2 text-xs font-medium', colors.panelBorder)} aria-pressed={section === 'create' && viewMode === 'draw'} onClick={() => { setSection('create'); setViewMode(viewMode === 'draw' ? 'generate' : 'draw'); }}>Drawing canvas</button></div>
    {(notice || error) && <p role="status" className="text-sm whitespace-pre-wrap">{notice || error}</p>}
  </div>;
  return <div className={cn('relative flex h-full min-h-0 flex-col overflow-hidden', colors.textMain)}>
    {section === 'gallery' ? <StudioGalleryView topSlot={nav} colors={colors} themeMode={themeMode} drawers={drawers} folders={folders} setFolders={setFolders} onUsePrompt={image => usePrompt(image, false)} onReuseSetup={image => usePrompt(image, true)} onDownload={handleDownload} onGalleryChanged={reloadRecent} onJumpToMessage={onJumpToMessage} /> : section === 'spellbook' ? <SpellbookPanel active colors={colors} themeMode={themeMode} topSlot={nav} /> : <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(var(--sab)+1rem)] space-y-4" style={{ paddingTop: 'calc(var(--sat) + 1rem)' }}>
      {nav}
      <div hidden={section !== 'face'}><StudioTransformPanel colors={colors} themeMode={themeMode} kind="face-transplant" settings={settings} imageModelId={imageModelId} onModelChange={setImageModelId} onDownload={handleDownload} /></div>
      <div hidden={section !== 'smash'}><StudioTransformPanel colors={colors} themeMode={themeMode} kind="smash" settings={settings} imageModelId={imageModelId} onModelChange={setImageModelId} onDownload={handleDownload} /></div>
      {section === 'styles' ? <MyStylesPanel colors={colors} library={library} reload={reloadLibrary} /> : section === 'face' || section === 'smash' ? null : viewMode === 'refs' ? <RefsPanel
        colors={colors} themeMode={themeMode} drawers={drawers} uploadingFor={uploadingFor}
        refInputRefs={refInputRefs} handleRefFileChange={handleRefFileChange} deleteRefImage={deleteRefImage}
        renameDrawer={renameDrawer} saveDescription={state.saveDescription} deleteDrawer={deleteDrawer} newDrawerName={newDrawerName}
        setNewDrawerName={setNewDrawerName} createDrawer={createDrawer} creatingDrawer={creatingDrawer} error={error}
      /> : viewMode === 'settings' ? <StudioSettingsPanel colors={colors} themeMode={themeMode} onSettingsChanged={reloadSettings} /> : viewMode === 'draw' ? <div className="h-[32rem] flex flex-col"><DrawingCanvas
        colors={colors} themeMode={themeMode} canvasRef={state.canvasRef} drawTool={state.drawTool} setDrawTool={state.setDrawTool}
        drawColor={state.drawColor} setDrawColor={state.setDrawColor} brushSize={state.brushSize} setBrushSize={state.setBrushSize}
        drawHistory={state.drawHistory} startDrawing={state.startDrawing} draw={state.draw} stopDrawing={state.stopDrawing}
        undoDraw={state.undoDraw} clearCanvas={state.clearCanvas} sketchToReference={state.sketchToReference}
        sendingSketch={state.sendingSketch} referenceDrawerLabel={drawers[0]?.label} error={error}
      /></div> : viewMode === 'edit' && currentImage ? <div className="h-[36rem] flex flex-col gap-3"><EditPanel
        colors={colors} themeMode={themeMode} currentImage={currentImage} crop={state.crop} setCrop={state.setCrop}
        zoom={state.zoom} setZoom={state.setZoom} rotation={state.rotation} setRotation={state.setRotation}
        brightness={state.brightness} setBrightness={state.setBrightness} contrast={state.contrast} setContrast={state.setContrast}
        hue={state.hue} setHue={state.setHue} cropAspect={state.cropAspect} setCropAspect={state.setCropAspect}
        onCropComplete={state.onCropComplete} resetEditState={state.resetEditState}
      /><div className="flex gap-2"><Button colors={colors} onClick={state.applyEdits}>Apply edits</Button><Button colors={colors} onClick={() => setViewMode('generate')}>Back to Create</Button></div></div> : <>
        <section className={cn(panel, 'space-y-4')}>
          <label className="block text-xs font-medium">OpenAI image model<select className={cn(field, 'mt-1')} value={imageModelId} onChange={e => setImageModelId(e.target.value)}>{settings?.models.map(m => <option key={m.id} value={m.id} disabled={m.metered && (!settings.allowMeteredImages || !settings.settings.hasOpenRouterKey)}>{m.label}{m.metered ? ' · paid via OpenRouter' : ''}</option>) ?? <option value="subscription-auto">ChatGPT subscription · automatic image model</option>}</select></label>
          <p className={cn('text-xs leading-relaxed', colors.textMuted)}>{selectedModel?.metered ? 'Uses your existing OpenRouter connection and credits. No separate OpenAI key is needed.' : 'Uses the existing ChatGPT subscription connection. It chooses its image model automatically. Enable paid OpenRouter image models in Settings to choose a specific image model.'}</p>
          <div><label htmlFor="studio-saved-style" className="text-xs font-medium">Saved style</label><div className="flex gap-2 mt-1"><select id="studio-saved-style" className={cn(field, 'min-w-0 flex-1')} value={styleId} onChange={e => setStyleId(e.target.value)}><option value="">No style</option>{library.styles.map(s => <option key={s.id} value={s.id}>{s.title}{s.id === library.defaultChatStyleId ? ' ★' : ''}</option>)}</select><button className={cn('rounded-xl border px-3 disabled:opacity-30', colors.panelBorder)} disabled={!selectedStyle} aria-label={library.defaultChatStyleId === styleId ? 'Clear chat default style' : 'Make selected style the chat default'} aria-pressed={!!styleId && library.defaultChatStyleId === styleId} onClick={star} style={{ color: library.defaultChatStyleId === styleId && styleId ? colors.accent : undefined }}><Star className={cn('h-5 w-5', styleId && library.defaultChatStyleId === styleId && 'fill-current')} /></button></div><p className={cn('text-xs mt-2', colors.textMuted)}>Chat default: {defaultStyle?.title ?? 'no saved style'}. <button className="underline" onClick={() => go('styles')}>Manage styles</button></p></div>
          {selectedStyle && <div className="space-y-2"><p className={cn('text-xs whitespace-pre-wrap line-clamp-3', colors.textMuted)}>{selectedStyle.prompt}</p><div className="flex gap-2 overflow-x-auto">{selectedStyle.references.map((r, i) => <img key={r.id} src={r.url} alt={`Style reference ${i + 1}`} className="h-14 w-14 shrink-0 rounded-xl object-cover" />)}</div></div>}
          <label className="block text-xs font-medium">Scene prompt<textarea id="bytelight-studio-prompt" className={cn(field, 'mt-1 min-h-28')} maxLength={4000} value={prompt} onChange={e => { setPrompt(e.target.value); setSuggestion(''); }} placeholder="What are we making? Describe the scene; your saved style stays separate." /></label>
          <Button colors={colors} disabled={enhancing || !prompt.trim()} onClick={enhance}>{enhancing ? <Loader2 className="inline h-4 w-4 animate-spin mr-1" /> : <Sparkles className="inline h-4 w-4 mr-1" />}Suggest a polished prompt</Button>
          {suggestion && <div className={cn('rounded-xl border p-3 space-y-2', colors.panelBorder)}><p className="text-xs font-semibold">Suggestion · your original is unchanged</p><p className="text-sm whitespace-pre-wrap">{suggestion}</p><div className="flex gap-2"><Button colors={colors} onClick={() => { setPrompt(suggestion); setSuggestion(''); }}>Use suggestion</Button><Button colors={colors} onClick={() => setSuggestion('')}>Dismiss</Button></div></div>}
          <div className="grid grid-cols-2 gap-3"><label className="text-xs font-medium">Image shape<select className={cn(field, 'mt-1')} value={size} onChange={e => setSize(e.target.value as typeof size)}>{SIZE_PRESETS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label><div className="text-xs self-end pb-3">{refCount}/16 reference images</div></div>
          {size === 'custom' && <div className="flex gap-2"><label className="min-w-0 flex-1 text-xs">Width<input type="number" min={256} max={2048} className={field} value={customWidth} onChange={e => setCustomWidth(Number(e.target.value))} /></label><label className="min-w-0 flex-1 text-xs">Height<input type="number" min={256} max={2048} className={field} value={customHeight} onChange={e => setCustomHeight(Number(e.target.value))} /></label></div>}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Subject references</h2><button type="button" className="text-xs underline px-2 py-2" onClick={() => setViewMode('refs')}>Add or manage people</button></div>
            <p className={cn('text-xs', colors.textMuted)}>Choose Description or Photos for each person. Edit what’s saved in their reference drawer.</p>
            {drawers.map(d => {
              const mode = writtenSlugs.includes(d.slug) ? 'description' : selectedSubjects.includes(d.slug) ? 'photos' : 'none';
              return <fieldset key={d.slug} className={cn('min-w-0 rounded-xl border px-3 pb-3', colors.panelBorder)}>
                <legend className="px-1 text-xs font-medium">{d.emoji} {d.label}</legend>
                <div className="flex flex-wrap gap-2">{([{ id: 'none', label: 'None' }, { id: 'description', label: 'Description' }, { id: 'photos', label: `Photos · ${d.refs.length}` }] as const).map(option => <button key={option.id} type="button" aria-pressed={mode === option.id} onClick={() => chooseSubjectMode(d.slug, option.id)} className={cn('min-h-10 rounded-xl border px-3 text-xs', colors.panelBorder)} style={mode === option.id ? { backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' } : {}}>{option.label}</button>)}</div>
                {mode === 'description' && (galleryDescriptions.some(ref => ref.slug === d.slug)
                  ? <p className={cn('mt-2 text-xs', colors.textMuted)}>Using the description from this gallery setup. Tap Description again to use the drawer’s current text.</p>
                  : !d.description && <p className={cn('mt-2 text-xs', colors.textMuted)}>No description saved. <button type="button" className="underline" onClick={() => setViewMode('refs')}>Open reference drawers</button></p>)}
                {mode === 'photos' && !d.refs.length && <p className={cn('mt-2 text-xs', colors.textMuted)}>No saved photos for {d.label}. Add photos under Manage people, or use a description.</p>}
              </fieldset>;
            })}
            {missingDescription && <p className={cn('text-xs', colors.textMuted)}>Save the missing description in its drawer, or choose Photos or None.</p>}
          </div>
          <input ref={uploadInput} type="file" accept="image/*" multiple hidden onChange={e => { void addOneOffRefs(Array.from(e.target.files ?? [])); e.target.value = ''; }} /><Button colors={colors} disabled={oneOffRefs.length >= 4} onClick={() => uploadInput.current?.click()}>Add one-off references · {oneOffRefs.length}/4</Button>
          {oneOffRefs.map(r => <div key={r.token} className="flex items-center gap-2 text-xs"><span className="truncate flex-1">{r.name}</span><button aria-label={`Remove ${r.name}`} onClick={() => setOneOffRefs(oneOffRefs.filter(x => x.token !== r.token))} className="p-2"><X className="h-4 w-4" /></button></div>)}
          {refCount > 16 && <p role="alert" className="text-xs">Too many references. Remove some; none will be silently discarded.</p>}
          <div className="flex flex-wrap gap-2"><Button colors={colors} variant="primary" size="lg" disabled={busy || !prompt.trim() || missingDescription || refCount > 16 || settings?.settings.enabled === false} onClick={generate}>{busy && <Loader2 className="inline h-4 w-4 animate-spin mr-1" />}Generate image{selectedModel?.metered ? ' · metered API' : ''}</Button><Button colors={colors} disabled={previewBusy || !prompt.trim() || missingDescription} onClick={showPreview}><Eye className="inline h-4 w-4 mr-1" />{preview ? 'Hide preview' : 'Preview request'}</Button></div>
          {settings?.settings.enabled === false && <p className={cn('text-xs', colors.textMuted)}>Image generation is off. Enable it in Studio Settings.</p>}
          {preview && <div className={cn('rounded-xl border p-3 space-y-2', colors.panelBorder)}><p className="text-xs font-semibold">Written prompt · server preview</p><p className="text-xs whitespace-pre-wrap select-text">{previewText}</p><p className={cn('text-xs', colors.textMuted)}>{selectedModel?.label ?? imageModelId} · requested shape: {size === 'custom' ? `${customWidth} × ${customHeight}` : size} · {refCount} reference images. Style images first, then subject photos, then one-offs. Provider size/quality and reference-role instructions are applied separately.</p><div className="flex gap-2 overflow-x-auto">{photoSubjects.flatMap(d => d.refs.map(r => <img key={`${d.slug}-${r.filename}`} src={r.url} alt={`${d.label}: ${r.filename}`} className="h-12 w-12 shrink-0 rounded-lg object-cover" />))}</div></div>}
        </section>
        <PromptGamePanel colors={colors} styleId={styleId} onUse={p => { setPrompt(p); setSuggestion(''); }} />
        {activeJobs.length > 0 && <div className={cn(panel, 'space-y-2')}><h2 className="text-sm font-semibold">Generation queue</h2>{activeJobs.map(job => <p key={job.id} className="text-xs truncate"><Loader2 className="inline h-3 w-3 animate-spin mr-2" />{job.status}: {job.prompt}</p>)}</div>}
        {currentImage && <div className={cn(panel, 'space-y-3')}><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Latest result</h2><Button colors={colors} onClick={() => handleDownload(currentImage)}><Download className="inline h-4 w-4 mr-1" />Download</Button></div>{currentImage.mediaType === 'video' ? <video src={currentImage.src} controls className="max-h-96 w-full rounded-xl" /> : <ZoomableImage src={currentImage.src} alt={currentImage.sourcePrompt || currentImage.prompt} className="max-h-[65vh] w-full rounded-xl object-contain" />}</div>}
        {currentImage && currentImage.mediaType !== 'video' && <Button colors={colors} onClick={() => { state.resetEditState(); setViewMode('edit'); }}>Edit result · crop, rotate and color</Button>}
        <RecentGalleryRail colors={colors} images={history} currentImage={currentImage} onSelect={setCurrentImage} onOpenGallery={() => go('gallery')} />
      </>}
    </div>}
  </div>;
}
