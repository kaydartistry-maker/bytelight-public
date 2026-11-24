import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Upload, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../ui';
import { ZoomableImage } from '../ZoomableImage';
import { galleryItemToImage } from './gallery-utils';
import { studioRequest, type ImageSettings } from './my-styles';
import type { GeneratedImage, StudioPanelProps } from './types';
import { transformationInput, type TransformationKind, type TransformationUpload } from './transformation-input';

export function StudioTransformPanel({ colors, kind, settings, imageModelId, onModelChange, onDownload }: StudioPanelProps & {
  kind: TransformationKind; settings: ImageSettings | null; imageModelId: string;
  onModelChange: (id: string) => void; onDownload: (image: GeneratedImage) => void;
}) {
  const face = kind === 'face-transplant';
  const [slots, setSlots] = useState<Array<TransformationUpload | null>>([null, null, null]);
  const [uploading, setUploading] = useState([false, false, false]);
  const [edits, setEdits] = useState(''), [assignments, setAssignments] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [jobId, setJobId] = useState('');
  const [status, setStatus] = useState(''), [result, setResult] = useState<GeneratedImage | null>(null);
  const tickets = useRef([0, 0, 0]), previews = useRef(new Set<string>()), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const p of previews.current) URL.revokeObjectURL(p); previews.current.clear(); }; }, []);
  useEffect(() => {
    if (!jobId) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await studioRequest<{ status: string; error?: string; filename?: string; url?: string; accountingWarning?: string }>(`jobs/${encodeURIComponent(jobId)}`);
        if (!alive) return;
        setStatus(job.status);
        if (job.status === 'completed') {
          setJobId(''); setBusy(false);
          if (!job.filename || !job.url) throw new Error('The completed image could not be loaded. Find it in Gallery.');
          setResult(galleryItemToImage(job));
          if (job.accountingWarning) setError(job.accountingWarning);
          return;
        }
        if (['failed', 'cancelled'].includes(job.status)) { setError(job.error || 'The edit could not be completed.'); setJobId(''); setBusy(false); return; }
      } catch (e) { if (alive) setError((e as Error).message); }
      if (alive) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [jobId]);
  const upload = async (index: number, file?: File) => {
    if (!file) return;
    const ticket = ++tickets.current[index];
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) { setError('Choose an image no larger than 10 MB.'); return; }
    setError(''); setUploading(u => u.map((v, i) => i === index ? true : v));
    try {
      const form = new FormData(); form.append('file', file);
      const response = await studioRequest<{ token: string }>('one-off-refs', 'POST', form);
      if (!mounted.current || tickets.current[index] !== ticket) return;
      if (!response.token) throw new Error('The image upload returned no reference token.');
      const preview = URL.createObjectURL(file); previews.current.add(preview);
      setSlots(current => current.map((s, i) => { if (i !== index) return s; if (s) { URL.revokeObjectURL(s.preview); previews.current.delete(s.preview); } return { token: response.token, name: file.name, preview }; }));
    } catch (e) { if (mounted.current && tickets.current[index] === ticket) setError((e as Error).message); }
    finally { if (mounted.current && tickets.current[index] === ticket) setUploading(u => u.map((v, i) => i === index ? false : v)); }
  };
  const generate = async () => {
    if (busy || uploading.some(Boolean)) return;
    setError('');
    try {
      const input = transformationInput(kind, slots, imageModelId, edits, assignments);
      setBusy(true);
      const response = await studioRequest<{ jobId: string }>('transform', 'POST', input);
      if (!response.jobId) throw new Error('No image job was returned.');
      setResult(null); setStatus('queued'); setJobId(response.jobId);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const field = cn('mt-1 w-full rounded-xl border p-3 text-sm', colors.panelBg, colors.panelBorder, colors.textMain);
  const model = settings?.models.find(m => m.id === imageModelId);
  const blocked = !settings || !settings.settings.enabled || (!!model?.metered && (!settings.allowMeteredImages || !settings.settings.hasOpenRouterKey));
  const labels = face ? ['Image 1 · Base artwork', 'Image 2 · First person’s face', 'Image 3 · Second person’s face (optional)'] : ['Image 1 · First reference', 'Image 2 · Second reference'];
  return <section aria-label={face ? 'Face Transplant' : 'Smash & Mash'} className={cn('rounded-2xl border p-4 space-y-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
    <div><h2 className="font-semibold">{face ? 'Face Transplant' : 'Smash & Mash'}</h2><p className={cn('mt-1 text-xs leading-relaxed', colors.textMuted)}>{face ? 'Change who is depicted while preserving the base artwork’s style and presentation. Your fixed Face Transplant instructions are applied automatically.' : 'Two equal references, one cohesive new image. Your fixed Smash prompt is applied automatically.'} These uploads stay separate from My Styles and character drawers.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">{labels.map((label, index) => <div key={label} className={cn('rounded-xl border p-3 space-y-2 min-w-0', colors.panelBorder)}>
      <p className="text-xs font-medium">{label}</p>
      {slots[index] && <><img src={slots[index]!.preview} alt={label} className="h-36 w-full rounded-lg object-contain" /><p className="truncate text-xs">{slots[index]!.name}</p></>}
      <label className={cn('inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer', colors.panelBorder)}>{uploading[index] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{slots[index] ? 'Replace image' : 'Add image'}<input aria-label={`Upload ${label}`} type="file" accept="image/*" disabled={busy || uploading[index]} className="sr-only" onChange={e => { void upload(index, e.target.files?.[0]); e.target.value = ''; }} /></label>
      {slots[index] && <button aria-label={`Remove ${label}`} disabled={busy || uploading[index]} className="p-2" onClick={() => { tickets.current[index]++; URL.revokeObjectURL(slots[index]!.preview); previews.current.delete(slots[index]!.preview); setSlots(s => s.map((v, i) => i === index ? null : v)); }}><X className="h-4 w-4" /></button>}
    </div>)}</div>
    {face && <><label className="block text-xs font-medium">Face assignments {slots[2] ? '· required for two people' : '· optional'}<textarea rows={2} className={field} value={assignments} maxLength={1000} disabled={busy} onChange={e => setAssignments(e.target.value)} placeholder="Image 2 → woman on the left; Image 3 → man on the right" /></label><label className="block text-xs font-medium">Additional edits · optional<textarea rows={3} className={field} value={edits} maxLength={4000} disabled={busy} onChange={e => setEdits(e.target.value)} placeholder="Any other changes you want in this edit…" /></label></>}
    <label className="block text-xs font-medium">Image model<select className={field} value={imageModelId} disabled={busy || !settings} onChange={e => onModelChange(e.target.value)}>{(settings?.models ?? [{ id: 'subscription-auto', label: 'ChatGPT subscription · automatic', metered: false }]).map(m => <option key={m.id} value={m.id} disabled={m.metered && (!settings?.allowMeteredImages || !settings?.settings.hasOpenRouterKey)}>{m.label}{m.metered ? ' · paid OpenRouter' : ''}</option>)}</select></label>
    <p className={cn('text-xs', colors.textMuted)}>Uses only the {face ? 'two or three' : 'two'} uploaded images above. Paid models require opt-in in Studio Settings.</p>
    {error && <p role="alert" className="text-xs whitespace-pre-wrap">{error}</p>}
    <Button colors={colors} variant="primary" disabled={busy || uploading.some(Boolean) || !slots[0] || !slots[1] || (face && !!slots[2] && !assignments.trim()) || blocked} onClick={generate}>{busy && <Loader2 className="inline h-4 w-4 mr-2 animate-spin" />}{busy ? `Working · ${status}` : face ? 'Transplant face' : 'Smash & Mash'}{model?.metered ? ' · metered API' : ''}</Button>
    {settings && !settings.settings.enabled && <p className="text-xs">Enable image generation in Studio Settings first.</p>}
    {result && <div className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Result</h3><Button colors={colors} onClick={() => onDownload(result)}><Download className="inline h-4 w-4 mr-1" />Save image</Button></div><ZoomableImage src={result.src} alt={face ? 'Face Transplant result' : 'Smash & Mash result'} className="max-h-[65vh] w-full rounded-xl object-contain" /><p className={cn('text-xs', colors.textMuted)}>Also saved in Studio Gallery.</p></div>}
  </section>;
}
