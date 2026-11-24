import { useState } from 'react';
import { Copy, Dices, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ThemeColors } from '../../lib/theme';
import { Button } from '../../ui';
import { copyStudioText } from './gallery-utils';
import { studioRequest } from './my-styles';

export function PromptGamePanel({ colors, styleId, onUse }: { colors: ThemeColors; styleId: string; onUse: (prompt: string) => void }) {
  const [words, setWords] = useState(''), [prompts, setPrompts] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const copy = async (text: string, label: string) => { try { await copyStudioText(text); setCopied(label); } catch { setError('Clipboard unavailable. You can select and copy the prompt text.'); } };
  const generate = async () => { setBusy(true); setError(''); setCopied(''); try { const result = await studioRequest<{ prompts: string[] }>('prompt-game', 'POST', { words, styleId }); setPrompts(result.prompts); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <details className={cn('rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
    <summary className="cursor-pointer font-semibold text-sm"><Dices className="inline h-4 w-4 mr-2" />Prompt Game</summary>
    <div className="space-y-3 mt-3"><p className={cn('text-xs', colors.textMuted)}>Random words → three short, distinct Midjourney-style prompts. No flags. Uses the selected written style as context; never changes it.</p>
      <label className="block text-xs font-medium">Random words<input className={cn('mt-1 w-full rounded-xl border p-3 text-sm', colors.panelBg, colors.panelBorder)} maxLength={4000} value={words} onChange={e => { setWords(e.target.value); setCopied(''); }} placeholder="e.g. celadon, lunaria, tarnished silver" onKeyDown={e => { if (e.key === 'Enter' && !busy && words.trim()) void generate(); }} /></label>
      <Button colors={colors} variant="primary" disabled={busy || !words.trim()} onClick={generate}>{busy && <Loader2 className="inline h-4 w-4 animate-spin mr-1" />}Make three prompts</Button>
      {error && <p role="alert" className="text-xs">{error}</p>}
      {prompts.map((prompt, i) => <div key={i} className={cn('rounded-xl border p-3 space-y-2', colors.panelBorder)}><label className="block text-xs font-medium">Prompt {i + 1}<textarea aria-label={`Prompt ${i + 1}`} rows={3} maxLength={650} value={prompt} onChange={e => { const text = e.target.value; setPrompts(current => current.map((p, n) => n === i ? text : p)); setCopied(''); }} className="mt-1 w-full resize-y rounded-lg bg-transparent p-1 text-sm leading-relaxed outline-none focus:ring-1 focus:ring-[var(--bytelight-accent)]" /></label><div className="flex gap-2"><Button colors={colors} onClick={() => copy(prompt, String(i))}><Copy className="inline h-3.5 w-3.5 mr-1" />{copied === String(i) ? 'Copied' : 'Copy'}</Button><Button colors={colors} onClick={() => onUse(prompt)}>Use as scene</Button></div></div>)}
      {prompts.length === 3 && <Button colors={colors} onClick={() => copy(prompts.join('\n\n'), 'all')}>{copied === 'all' ? 'Copied all three' : 'Copy all three'}</Button>}
    </div>
  </details>;
}
