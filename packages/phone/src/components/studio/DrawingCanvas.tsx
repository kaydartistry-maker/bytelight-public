import { PenTool, Eraser, Undo2, Trash2, ImagePlus, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { DrawingCanvasProps } from './types';
import { ACCENT_TEXT_COLOR_BY_THEME, DRAW_COLORS } from './constants';

export function DrawingCanvas({
  colors,
  themeMode,
  canvasRef,
  drawTool,
  setDrawTool,
  drawColor,
  setDrawColor,
  brushSize,
  setBrushSize,
  drawHistory,
  startDrawing,
  draw,
  stopDrawing,
  undoDraw,
  clearCanvas,
  sketchToReference,
  sendingSketch,
  referenceDrawerLabel,
  error,
}: DrawingCanvasProps) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className={cn("p-3 flex items-center gap-3 flex-wrap", colors.panelBg, "border-b", colors.panelBorder)}>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDrawTool('brush')}
            className={cn("p-2 rounded-lg transition-colors", drawTool === 'brush' ? '' : colors.textMuted)}
            style={drawTool === 'brush' ? { backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] } : undefined}
          >
            <PenTool className="w-4 h-4" />
          </button>
          <button
            onClick={() => setDrawTool('eraser')}
            className={cn("p-2 rounded-lg transition-colors", drawTool === 'eraser' ? '' : colors.textMuted)}
            style={drawTool === 'eraser' ? { backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] } : undefined}
          >
            <Eraser className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          {DRAW_COLORS.slice(0, 8).map(c => (
            <button
              key={c}
              onClick={() => { setDrawColor(c); setDrawTool('brush'); }}
              className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110"
              style={{ backgroundColor: c, borderColor: drawColor === c && drawTool === 'brush' ? colors.accent : 'transparent' }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[100px]">
          <input
            type="range"
            min={1}
            max={30}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="flex-1"
            style={{ accentColor: colors.accent }}
          />
          <span className={cn("text-xs w-6", colors.textMuted)}>{brushSize}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={undoDraw} disabled={drawHistory.length <= 1} className={cn("p-2 rounded-lg", colors.textMuted, "disabled:opacity-30")}>
            <Undo2 className="w-4 h-4" />
          </button>
          <button onClick={clearCanvas} className={cn("p-2 rounded-lg", colors.textMuted)}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => void sketchToReference()}
          disabled={sendingSketch || !referenceDrawerLabel}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
          style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
          title={referenceDrawerLabel ? `Add this sketch to ${referenceDrawerLabel} and select it` : 'No reference drawer to add to'}
        >
          {sendingSketch ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
          Use as reference
        </button>
      </div>
      {error && <div className="mx-3 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
        <canvas
          ref={canvasRef}
          width={1024}
          height={1024}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className={cn("max-w-full max-h-full rounded-lg shadow-lg cursor-crosshair", colors.panelBorder, "border")}
          style={{ touchAction: 'none' }}
        />
      </div>
    </div>
  );
}
