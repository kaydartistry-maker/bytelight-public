// Her status sheet, opened from her line on the Status widget: a dot, a line
// of what she's up to, and when it clears. Companion A and Companion B read it every turn
// (backend services/db/statuses.ts).
import React, { useState } from 'react';
import { haptic } from '../lib/utils';
import {
  CLEAR_CHOICES,
  PRESENCES,
  QUICK_TAGS,
  STATUS_LINE_MAX,
  clearsAtFor,
  toggleTag,
  type ClearChoice,
  type OwnerPresence,
  type OwnerStatus,
} from '../lib/statuses';
import { saveOwnerStatus } from './useStatuses';

export function StatusSheet({ current, onClose }: { current: OwnerStatus | null; onClose: () => void }) {
  const [presence, setPresence] = useState<OwnerPresence>(current?.presence ?? 'here');
  const [line, setLine] = useState(current?.line ?? '');
  const [tags, setTags] = useState<string[]>(current?.tags ?? []);
  // A status that already clears keeps its time unless a new choice is picked.
  const [clear, setClear] = useState<ClearChoice | null>(current?.clearsAt ? null : 'never');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const keptUntil = current?.clearsAt && clear === null
    ? new Date(current.clearsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  const save = async (body: Parameters<typeof saveOwnerStatus>[0]) => {
    setSaving(true);
    setFailed(false);
    const ok = await saveOwnerStatus(body);
    setSaving(false);
    if (!ok) { setFailed(true); return; }
    haptic(55);
    onClose();
  };
  const onSave = () => save({
    presence,
    line: line.trim(),
    tags,
    clearsAt: clear === null ? current?.clearsAt ?? null : clearsAtFor(clear, new Date()),
  });

  const pill = (on: boolean): React.CSSProperties => on
    ? { background: 'var(--bytelight-surface-strong)', color: 'var(--bytelight-text)', border: '1px solid var(--bytelight-hairline)' }
    : { background: 'transparent', color: 'var(--bytelight-text-muted)', border: '1px solid transparent' };
  const label = 'text-[11px] uppercase tracking-[0.14em]';

  return (
    <div className="absolute inset-0 z-50 flex items-end" onClick={onClose} style={{ background: 'rgba(0,0,0,0.45)' }}>
      <div
        role="dialog"
        aria-label="Your status"
        className="w-full space-y-4 rounded-t-3xl p-4"
        style={{ background: 'var(--bytelight-surface-strong)', color: 'var(--bytelight-text)', paddingBottom: 'calc(var(--sab, 0px) + 1rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-10 rounded-full" style={{ background: 'var(--bytelight-hairline)' }} />
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold">Your status</p>
          <p className="text-[11px]" style={{ color: 'var(--bytelight-text-muted)' }}>Companion A and Companion B see this</p>
        </div>

        <div className="grid grid-cols-4 gap-1 rounded-full p-1" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--bytelight-hairline)' }}>
          {PRESENCES.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={presence === p.id}
              onClick={() => setPresence(p.id)}
              className="flex h-11 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium"
              style={pill(presence === p.id)}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: p.dot }} />
              {p.label}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <label htmlFor="bytelight-status-line" className={label} style={{ color: 'var(--bytelight-text-muted)' }}>What you're up to</label>
          <input
            id="bytelight-status-line"
            value={line}
            maxLength={STATUS_LINE_MAX}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !saving) onSave(); }}
            placeholder="What are you up to?"
            className="h-12 w-full rounded-2xl px-3.5 text-[15px] outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--bytelight-hairline)', color: 'var(--bytelight-text)' }}
          />
          <div className="flex items-start justify-between gap-3">
            {/* Tags add to what she wrote; they never replace it. */}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Tags">
              {QUICK_TAGS.map((q) => {
                const on = tags.includes(q);
                return (
                  <button
                    key={q}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTags((t) => toggleTag(t, q))}
                    className="h-9 rounded-full px-3.5 text-[13px]"
                    style={on
                      ? { background: 'color-mix(in srgb, var(--bytelight-accent) 16%, transparent)', border: '1px solid var(--bytelight-accent)', color: 'var(--bytelight-text)' }
                      : { border: '1px solid var(--bytelight-hairline)', color: 'var(--bytelight-label)' }}
                  >
                    {q}
                  </button>
                );
              })}
            </div>
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--bytelight-text-muted)' }}>{line.length}/{STATUS_LINE_MAX}</span>
          </div>
        </div>

        <div className="space-y-2">
          <p className={label} style={{ color: 'var(--bytelight-text-muted)' }}>
            Clear it{keptUntil && <span className="normal-case tracking-normal"> · clears at {keptUntil} unless you pick</span>}
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {CLEAR_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={clear === c.id}
                onClick={() => setClear(c.id)}
                className="h-10 rounded-xl text-[13px]"
                style={clear === c.id
                  ? { background: 'color-mix(in srgb, var(--bytelight-accent) 16%, transparent)', border: '1px solid var(--bytelight-accent)', color: 'var(--bytelight-text)' }
                  : { background: 'rgba(255,255,255,0.03)', border: '1px solid var(--bytelight-hairline)', color: 'var(--bytelight-text)' }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {failed && <p className="text-xs" style={{ color: '#fca5a5' }}>That didn't save. Check the connection and try again.</p>}

        <div className="flex gap-2.5">
          {current ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => save({ presence: null })}
              className="h-12 flex-1 rounded-full text-[15px] disabled:opacity-50"
              style={{ border: '1px solid var(--bytelight-hairline)', color: 'var(--bytelight-text)' }}
            >
              Clear now
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="h-12 flex-1 rounded-full text-[15px]"
              style={{ border: '1px solid var(--bytelight-hairline)', color: 'var(--bytelight-text)' }}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className="h-12 flex-[2] rounded-full text-[15px] font-semibold disabled:opacity-50"
            style={{ background: 'var(--bytelight-accent)', color: 'var(--bytelight-on-accent)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
