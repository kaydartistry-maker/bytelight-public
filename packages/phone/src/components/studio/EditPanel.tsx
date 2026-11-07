import { Sun, Contrast, Palette, RotateCw, RotateCcw } from 'lucide-react';
import Cropper from 'react-easy-crop';
import { cn } from '../../lib/utils';
import type { EditPanelProps } from './types';
import { EDIT_CROP_ASPECT_OPTIONS } from './constants';

export function EditPanel({
  colors,
  themeMode,
  currentImage,
  crop,
  setCrop,
  zoom,
  setZoom,
  rotation,
  setRotation,
  brightness,
  setBrightness,
  contrast,
  setContrast,
  hue,
  setHue,
  cropAspect,
  setCropAspect,
  onCropComplete,
  resetEditState,
}: EditPanelProps) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 relative" style={{ filter: `brightness(${brightness}%) contrast(${contrast}%) hue-rotate(${hue}deg)` }}>
        <Cropper
          image={currentImage.src}
          crop={crop}
          zoom={zoom}
          rotation={rotation}
          aspect={cropAspect}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
          showGrid={true}
          minZoom={0.1}
          maxZoom={5}
          restrictPosition={true}
        />
      </div>
      <div className={cn("p-4 space-y-3 overflow-y-auto max-h-[45vh]", colors.panelBg)}>
        {/* Crop aspect ratio */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn("text-xs font-medium uppercase tracking-wide mr-1", colors.textMuted)}>Crop:</span>
          {EDIT_CROP_ASPECT_OPTIONS.map(opt => (
            <button
              key={opt.label}
              onClick={() => setCropAspect(opt.value)}
              className={cn("px-2 py-0.5 rounded text-xs border transition-colors", cropAspect === opt.value ? "border-current" : cn(colors.panelBorder, colors.textMuted))}
              style={cropAspect === opt.value ? { borderColor: colors.accent, color: colors.accent } : undefined}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Sun className={cn("w-4 h-4 flex-shrink-0", colors.textMuted)} />
          <input type="range" min={50} max={150} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} className="flex-1" style={{ accentColor: colors.accent }} />
          <span className={cn("text-xs w-10 text-right", colors.textMuted)}>{brightness}%</span>
        </div>
        <div className="flex items-center gap-3">
          <Contrast className={cn("w-4 h-4 flex-shrink-0", colors.textMuted)} />
          <input type="range" min={50} max={150} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} className="flex-1" style={{ accentColor: colors.accent }} />
          <span className={cn("text-xs w-10 text-right", colors.textMuted)}>{contrast}%</span>
        </div>
        <div className="flex items-center gap-3">
          <Palette className={cn("w-4 h-4 flex-shrink-0", colors.textMuted)} />
          <input type="range" min={-180} max={180} value={hue} onChange={(e) => setHue(Number(e.target.value))} className="flex-1" style={{ accentColor: colors.accent }} />
          <span className={cn("text-xs w-10 text-right", colors.textMuted)}>{hue}°</span>
        </div>
        <div className="flex items-center gap-3">
          <RotateCw className={cn("w-4 h-4 flex-shrink-0", colors.textMuted)} />
          <input type="range" min={-180} max={180} value={rotation} onChange={(e) => setRotation(Number(e.target.value))} className="flex-1" style={{ accentColor: colors.accent }} />
          <span className={cn("text-xs w-10 text-right", colors.textMuted)}>{rotation}°</span>
        </div>
        <button onClick={resetEditState} className={cn("w-full py-2 rounded-lg text-sm flex items-center justify-center gap-2", colors.panelBorder, "border")}>
          <RotateCcw className="w-4 h-4" />Reset
        </button>
      </div>
    </div>
  );
}
