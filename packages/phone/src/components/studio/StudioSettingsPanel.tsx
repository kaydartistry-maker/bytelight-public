import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../../ui';
import type { StudioPanelProps } from './types';
import { studioRequest, type ImageSettings } from './my-styles';

export function StudioSettingsPanel({ colors, onSettingsChanged }: StudioPanelProps & { onSettingsChanged?: () => Promise<void> }) {
  const [data, setData] = useState<ImageSettings | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [budget, setBudget] = useState('');
  const load = async () => { const value = await studioRequest<ImageSettings>('settings'); setData(value); setBudget(String(value.settings.monthlyBudgetUsd)); };
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  const save = async (patch: unknown) => { if (busy) return; setBusy(true); setError(''); try { await studioRequest('settings', 'PUT', patch); await load(); await onSettingsChanged?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const panel = cn('rounded-2xl border p-4 space-y-3 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const field = cn('w-full rounded-xl border p-3 text-sm', colors.panelBg, colors.panelBorder);
  if (!data) return <div className={panel}>{error || 'Loading Studio settings…'}</div>;
  return <div className="space-y-4">
    <section className={panel}><h2 className="text-sm font-semibold">Image generation</h2><label className="flex items-center justify-between text-sm gap-3">Enable image generation<input type="checkbox" checked={data.settings.enabled} disabled={busy} onChange={e => save({ enabled: e.target.checked })} /></label><label className="block text-xs">Quality<select className={cn(field, 'mt-1')} value={data.settings.quality} disabled={busy} onChange={e => save({ quality: e.target.value })}>{['auto', 'low', 'medium', 'high'].map(q => <option key={q}>{q}</option>)}</select></label><p className={cn('text-xs', colors.textMuted)}>The ChatGPT subscription route stays available without enabling API billing. Its image model is selected by the connection, not a GPT text-model picker.</p></section>
    <section className={panel}>
      <h2 className="text-sm font-semibold">OpenAI image models through OpenRouter · paid</h2>
      <p className={cn('text-xs leading-relaxed', colors.textMuted)}>Uses your existing OpenRouter connection and its credits. No separate OpenAI key is needed. This is separate from your ChatGPT subscription; enabling it does not generate an image or change your chat image model.</p>
      <p className={cn('text-xs', colors.textMuted)}>OpenRouter connection: {data.settings.hasOpenRouterKey ? 'connected' : 'no key saved — connect OpenRouter in Integrations'}.</p>
      <label className="flex items-center justify-between gap-3 text-sm">Allow paid OpenRouter image models<input type="checkbox" checked={data.allowMeteredImages} disabled={busy || (!data.settings.hasOpenRouterKey && !data.allowMeteredImages)} onChange={e => save({ allowMeteredImages: e.target.checked })} /></label>
      <label className="block text-xs">Monthly image API budget in USD<input type="number" min="0" step="1" className={cn(field, 'mt-1')} value={budget} onChange={e => setBudget(e.target.value)} /></label>
      <p className={cn('text-xs', colors.textMuted)}>Recorded spend (may include estimates): ${data.monthlySpendUsd.toFixed(2)}. 0 means no cap. This blocks new requests after recorded spend reaches the budget; it is not an account-wide hard spending limit.</p>
      <Button colors={colors} disabled={busy || budget.trim() === '' || !Number.isFinite(Number(budget)) || Number(budget) < 0} onClick={() => save({ monthly_budget_usd: Number(budget) })}>Save budget</Button>
    </section>
    <section className={panel}><h2 className="text-sm font-semibold">Model for images generated in chat</h2><select aria-label="Chat image model" className={field} value={data.chatImageModel} disabled={busy} onChange={e => save({ chatImageModel: e.target.value })}>{data.models.map(m => <option key={m.id} value={m.id} disabled={m.metered && (!data.allowMeteredImages || !data.settings.hasOpenRouterKey)}>{m.label}{m.metered ? ' · paid via OpenRouter' : ''}</option>)}</select><p className={cn('text-xs', colors.textMuted)}>Image generation only; companion chat models are unchanged. Choose the default style with the star in My Styles.</p></section>
    {error && <p role="alert" className={cn(panel, 'text-sm')}>{error}</p>}
  </div>;
}
