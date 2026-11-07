// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0.
import React, { useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft, Download, Info, PenTool,
  Settings, Users, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { SegmentedControl } from '../ui';
import { GifApp } from './GifApp';
import { CutoutApp } from './CutoutApp';
import {
  ACCENT_TEXT_COLOR_BY_THEME,
  ANTIGRAVITY_MODELS,
  CODEX_MODELS,
  OPENART_MODELS,
  DrawingCanvas,
  EditPanel,
  GenerationControls,
  GenerationResults,
  PROMPT_STYLES,
  RefsPanel,
  SIZE_PRESETS,
  useStudioState,
  type StudioAppProps,
  type GeneratedImage,
  type StudioSection,
} from './studio';
import { RecentGalleryRail } from './studio/RecentGalleryRail';
import { StudioGalleryView } from './studio/StudioGalleryView';
import { StudioSettingsPanel } from './studio/StudioSettingsPanel';
import { ZoomableImage } from './ZoomableImage';

export function StudioApp({ onClose, onJumpToMessage, themeConfig, themeMode }: StudioAppProps) {
  const colors = themeConfig[themeMode];
  const [section, setSection] = useState<StudioSection>('create');

  const {
    backend, setBackend,
    drawers, selectedSubjects, oneOffRefs, setOneOffRefs, addOneOffRefs,
    viewMode, setViewMode,
    codexModel, setCodexModel,
    agyModel, setAgyModel,
    openartModel, setOpenartModel,
    size, setSize,
    customWidth, setCustomWidth,
    customHeight, setCustomHeight,
    prompt, setPrompt,
    selectedStyle, setSelectedStyle,
    generating,
    activeJobs,
    enhancing,
    error,
    currentImage, setCurrentImage,
    history,
    folders, setFolders,
    crop, setCrop,
    zoom, setZoom,
    rotation, setRotation,
    brightness, setBrightness,
    contrast, setContrast,
    hue, setHue,
    cropAspect, setCropAspect,
    canvasRef,
    drawColor, setDrawColor,
    brushSize, setBrushSize,
    drawTool, setDrawTool,
    drawHistory,
    showSettings, setShowSettings,
    showStylePicker, setShowStylePicker,
    showSubjects, setShowSubjects,
    viewingImage, setViewingImage,
    uploadingFor,
    newDrawerName, setNewDrawerName,
    creatingDrawer,
    refInputRefs,
    toggleSubject,
    loadDrawers,
    deleteRefImage,
    createDrawer,
    renameDrawer,
    deleteDrawer,
    handleRefFileChange,
    handleGenerate,
    handleEnhance,
    handleDownload,
    selectFromHistory,
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
    reloadRecent,
  } = useStudioState({
    themeMode,
    codexModels: CODEX_MODELS,
    antigravityModels: ANTIGRAVITY_MODELS,
    openartModels: OPENART_MODELS,
    promptStyles: PROMPT_STYLES,
    sizePresets: SIZE_PRESETS,
  });

  const focusPrompt = () => {
    window.setTimeout(() => document.getElementById('bytelight-studio-prompt')?.focus(), 80);
  };

  const usePrompt = useCallback((image: GeneratedImage, includeSetup: boolean) => {
    if (includeSetup) selectFromHistory(image);
    setPrompt(image.sourcePrompt ?? image.prompt ?? '');
    // New assets retain the selected style separately. Legacy assets contain
    // only the already-expanded prompt, so clearing style prevents duplication.
    setSelectedStyle(image.sourcePrompt ? (image.styleId ?? '') : '');
    setViewMode('generate');
    setSection('create');
    focusPrompt();
  }, [selectFromHistory, setPrompt, setSelectedStyle, setViewMode]);

  const changeSection = (next: StudioSection) => {
    setViewMode('generate');
    setSection(next);
  };

  const sectionTabs = (
    <div className={cn('mb-4 rounded-2xl border p-2 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <SegmentedControl
        options={[
          { value: 'create', label: 'Create' },
          { value: 'gif', label: 'GIF Lab' },
          { value: 'cutout', label: 'Cutout' },
          { value: 'gallery', label: 'Gallery' },
        ]}
        value={section}
        onChange={changeSection}
        colors={colors}
        className="justify-center"
      />
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className={cn("absolute inset-0 flex flex-col z-20")}
    >
      {/* Header */}
      <header
        className={cn("bytelight-shell-header flex items-center gap-3 px-4 pb-3", colors.pageBg)}
        style={{ paddingTop: 'calc(var(--sat) + 0.75rem)', borderBottom: 'none' }}
      >
        <button
          onClick={viewMode === 'generate' ? onClose : () => setViewMode('generate')}
          className={cn("p-1.5 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className={cn("text-lg font-semibold", colors.textMain)}>
            {viewMode === 'edit' ? 'Edit Image' : viewMode === 'draw' ? 'Sketch' : viewMode === 'refs' ? 'References' : viewMode === 'settings' ? 'Studio settings' : 'Studio'}
          </h1>
        </div>
        {viewMode === 'generate' && section === 'create' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setViewMode('refs'); loadDrawers(); }}
              className={cn("p-2 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
              title="References"
            >
              <Users className="w-5 h-5" />
            </button>
            <button
              onClick={() => setViewMode('draw')}
              className={cn("p-2 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
              title="Sketch"
            >
              <PenTool className="w-5 h-5" />
            </button>
            <button
              onClick={() => setViewMode('settings')}
              className={cn("p-2 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
              title="Studio settings"
            >
              <Settings className="w-5 h-5" />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className={cn("p-2 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
              title="About the backends"
            >
              {/* Info, not a gear: the panel behind this explains what each backend
                  is and changes no setting. */}
              <Info className="w-5 h-5" />
            </button>
          </div>
        )}
        {viewMode === 'edit' && (
          <button
            onClick={applyEdits}
            className="px-4 py-1.5 rounded-full text-sm font-medium"
            style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
          >
            Apply
          </button>
        )}
      </header>

      {/* Rendered INSIDE each section's scroll container rather than pinned above
          them, so it scrolls away with the page like every other app's nav row.
          Studio has four separate scrollers (create, gif, cutout, and the gallery
          component), which is why this is a variable handed to each of them
          instead of one element sitting up here. */}

      {/* Edit Mode */}
      {viewMode === 'edit' && currentImage && (
        <EditPanel
          colors={colors}
          themeMode={themeMode}
          currentImage={currentImage}
          crop={crop}
          setCrop={setCrop}
          zoom={zoom}
          setZoom={setZoom}
          rotation={rotation}
          setRotation={setRotation}
          brightness={brightness}
          setBrightness={setBrightness}
          contrast={contrast}
          setContrast={setContrast}
          hue={hue}
          setHue={setHue}
          cropAspect={cropAspect}
          setCropAspect={setCropAspect}
          onCropComplete={onCropComplete}
          resetEditState={resetEditState}
        />
      )}

      {/* Draw Mode */}
      {viewMode === 'draw' && (
        <DrawingCanvas
          colors={colors}
          themeMode={themeMode}
          canvasRef={canvasRef}
          drawTool={drawTool}
          setDrawTool={setDrawTool}
          drawColor={drawColor}
          setDrawColor={setDrawColor}
          brushSize={brushSize}
          setBrushSize={setBrushSize}
          drawHistory={drawHistory}
          startDrawing={startDrawing}
          draw={draw}
          stopDrawing={stopDrawing}
          undoDraw={undoDraw}
          clearCanvas={clearCanvas}
          sketchToReference={sketchToReference}
          sendingSketch={sendingSketch}
          referenceDrawerLabel={drawers[0]?.label}
          error={error}
        />
      )}

      {/* Refs Mode */}
      {viewMode === 'refs' && (
        <RefsPanel
          colors={colors}
          themeMode={themeMode}
          drawers={drawers}
          uploadingFor={uploadingFor}
          refInputRefs={refInputRefs}
          handleRefFileChange={handleRefFileChange}
          deleteRefImage={deleteRefImage}
          renameDrawer={renameDrawer}
          deleteDrawer={deleteDrawer}
          newDrawerName={newDrawerName}
          setNewDrawerName={setNewDrawerName}
          createDrawer={createDrawer}
          creatingDrawer={creatingDrawer}
          error={error}
        />
      )}

      {/* Settings Mode */}
      {viewMode === 'settings' && (
        <StudioSettingsPanel
          colors={colors}
          themeMode={themeMode}
          onEngineSwitched={(engine) => {
            // Create only drives the engines it has controls for; the others are
            // still valid server defaults for images drawn from chat.
            if (engine === 'codex' || engine === 'antigravity' || engine === 'openart') setBackend(engine);
          }}
        />
      )}

      {/* Create */}
      {viewMode === 'generate' && section === 'create' && (
        <div className="bytelight-app-body flex-1 overflow-y-auto p-4 space-y-4">
          {sectionTabs}
          <GenerationControls
            colors={colors}
            themeMode={themeMode}
            backend={backend}
            setBackend={setBackend}
            codexModel={codexModel}
            setCodexModel={setCodexModel}
            agyModel={agyModel}
            setAgyModel={setAgyModel}
            openartModel={openartModel}
            setOpenartModel={setOpenartModel}
            size={size}
            setSize={setSize}
            customWidth={customWidth}
            setCustomWidth={setCustomWidth}
            customHeight={customHeight}
            setCustomHeight={setCustomHeight}
            drawers={drawers}
            selectedSubjects={selectedSubjects}
            toggleSubject={toggleSubject}
            oneOffRefs={oneOffRefs}
            setOneOffRefs={setOneOffRefs}
            addOneOffRefs={addOneOffRefs}
            showSubjects={showSubjects}
            setShowSubjects={setShowSubjects}
            prompt={prompt}
            setPrompt={setPrompt}
            selectedStyle={selectedStyle}
            setSelectedStyle={setSelectedStyle}
            showStylePicker={showStylePicker}
            setShowStylePicker={setShowStylePicker}
            generating={generating}
            handleGenerate={handleGenerate}
            enhancing={enhancing}
            handleEnhance={handleEnhance}
            error={error}
          />
          <GenerationResults
            colors={colors}
            themeMode={themeMode}
            currentImage={currentImage}
            setViewMode={setViewMode}
            setViewingImage={setViewingImage}
            handleDownload={handleDownload}
            setPrompt={setPrompt}
          />
          {activeJobs.length > 0 && (
            <div className={cn("p-3 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
              <label className={cn("text-xs font-medium uppercase tracking-wide mb-2 block", colors.textMuted)}>
                Queue ({activeJobs.length})
              </label>
              <div className="space-y-1.5">
                {activeJobs.map((job, i) => (
                  <div
                    key={job.id}
                    className={cn("flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs", colors.panelBorder)}
                    style={{ backgroundColor: 'rgba(0,0,0,0.1)' }}
                  >
                    <div
                      className={cn("w-2 h-2 rounded-full", job.status === 'running' ? "animate-pulse" : "")}
                      style={{ backgroundColor: job.status === 'running' ? colors.accent : 'rgba(128,128,128,0.5)' }}
                    />
                    <span className={cn("flex-1 truncate", colors.textMuted)}>
                      {i === 0 && job.status === 'running' ? 'Generating...' : `#${i + 1} queued`}
                    </span>
                    <span className={cn("truncate max-w-[120px]", colors.textMuted)} title={job.prompt}>
                      {job.prompt.slice(0, 30)}{job.prompt.length > 30 ? '...' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <RecentGalleryRail
            colors={colors}
            images={history}
            currentImage={currentImage}
            onSelect={selectFromHistory}
            onOpenGallery={() => setSection('gallery')}
          />
        </div>
      )}

      {/* GIF Lab stays mounted while Studio is open so a section switch does
          not tear down the working frame set or optimizer controls. */}
      {viewMode === 'generate' && (
        <>
          <div className={cn(section === 'gif' ? 'bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4' : 'hidden')}>
            {section === 'gif' && sectionTabs}
            <GifApp embedded active={section === 'gif'} onClose={() => setSection('create')} themeConfig={themeConfig} themeMode={themeMode} />
          </div>
          <div className={cn(section === 'cutout' ? 'bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4' : 'hidden')}>
            {section === 'cutout' && sectionTabs}
            <CutoutApp active={section === 'cutout'} themeConfig={themeConfig} themeMode={themeMode} />
          </div>
        </>
      )}

      {viewMode === 'generate' && section === 'gallery' && (
        <StudioGalleryView
          topSlot={sectionTabs}
          colors={colors}
          themeMode={themeMode}
          drawers={drawers}
          folders={folders}
          setFolders={setFolders}
          onUsePrompt={(image) => usePrompt(image, false)}
          onReuseSetup={(image) => usePrompt(image, true)}
          onDownload={handleDownload}
          onGalleryChanged={() => { void reloadRecent().catch(() => undefined); }}
          onJumpToMessage={onJumpToMessage}
        />
      )}

      {/* Full-screen preview for the current Create result. Gallery has its
          own metadata-rich viewer. */}
      <AnimatePresence>
        {viewMode === 'generate' && section === 'create' && viewingImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex flex-col bg-black/95 text-white"
          >
            <div className="flex items-center justify-between p-4" style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}>
              <button type="button" onClick={() => setViewingImage(null)} className="rounded-full bg-white/10 p-2"><X className="h-5 w-5" /></button>
              <button type="button" onClick={() => handleDownload(viewingImage)} className="rounded-full bg-white/10 p-2"><Download className="h-4 w-4" /></button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              {viewingImage.mediaType === 'video'
                ? <video src={viewingImage.src} className="max-h-full max-w-full" controls loop playsInline autoPlay />
                : <ZoomableImage src={viewingImage.src} alt={viewingImage.prompt} className="rounded-xl" />}
            </div>
            <div className="space-y-3 border-t border-white/10 p-4 pb-[calc(var(--sab)+1rem)]">
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-sm">{viewingImage.prompt}</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setViewingImage(null); usePrompt(viewingImage, false); }} className="rounded-xl py-2.5 text-xs font-semibold" style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}>Use prompt</button>
                <button type="button" onClick={() => { setViewingImage(null); usePrompt(viewingImage, true); }} className="rounded-xl bg-white/10 py-2.5 text-xs font-semibold">Reuse setup</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-30 flex items-center justify-center p-6">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowSettings(false)} />
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className={cn("relative w-full max-w-sm rounded-2xl border p-6 space-y-4", colors.panelBg, colors.panelBorder)}>
              <div className="flex items-center justify-between">
                <h2 className={cn("text-lg font-semibold", colors.textMain)}>Backends</h2>
                <button onClick={() => setShowSettings(false)} className={colors.textMuted}><X className="w-5 h-5" /></button>
              </div>
              <div className={cn("p-3 rounded-lg text-xs space-y-2", colors.panelBorder, "border")}>
                <p className={colors.textMain}><strong>Codex:</strong> Free image generation using your ChatGPT subscription. Supports reference subjects from your drawers.</p>
                <p className={colors.textMain}><strong>Gemini:</strong> Free image generation using your Google One AI subscription via Antigravity CLI.</p>
                <p className={colors.textMain}><strong>OpenArt:</strong> Images and video against your OpenArt credits. Trained character models live here.</p>
              </div>
              <button onClick={() => setShowSettings(false)} className="w-full py-2.5 rounded-xl font-semibold text-sm" style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}>Done</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
