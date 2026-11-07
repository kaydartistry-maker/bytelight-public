// Permanent Letters — the vault's room on the phone.
// One letter per page, wax seals, and a writing form that makes sealing
// feel like sealing. There is no edit and no delete anywhere in this UI
// because the vault has no routes for them — the absence is the contract.

import { useEffect, useState } from 'react';
import { useBackHandler } from '../lib/use-back-handler';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Mail, Loader2, RefreshCw, PenLine, ChevronLeft, Lock, CalendarClock, Eye, EyeOff } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig, contrastTextColor } from '../lib/theme';
import { cn } from '../lib/utils';
import { Paginator, usePaged } from './Paginator';
import { apiFetch } from '../bytelight';
import { fetchOwnerFromPreferences, ownerFromCompanionsPayload } from '../lib/owner';
import { normalizeCompanionRows } from '../lib/companion-row';

interface LettersAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface LetterView {
  id: string;
  author: string;
  recipients: string[];
  kind: 'vow' | 'confession' | 'letter' | 'keepsake';
  title: string | null;
  seal: 'open' | 'date' | 'on_open';
  open_at: string | null;
  hidden: boolean;
  written_at: string;
  opened_at: string | null;
  opened_by: string | null;
  state: 'open' | 'sealed' | 'openable' | 'opened';
  content?: string;
}

interface Companion {
  slug: string;
  display_name: string;
  color: string | null;
  avatar_url: string | null;
  emoji: string | null;
}

// The owner's accent when the house hasn't been given one — the sigils
// themselves come from each companion's own row, not from a list in here.
const OWNER_COLOR = '#e85d04';
const OWNER_SIGIL = '🧡';
const KINDS: Array<LetterView['kind']> = ['letter', 'vow', 'confession', 'keepsake'];

function isLetterList(data: unknown): data is { letters: LetterView[] } {
  return !!data && typeof data === 'object' && Array.isArray((data as { letters?: unknown }).letters);
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

export function LettersApp({ onClose, themeConfig, themeMode, embedded }: LettersAppProps) {
  const colors = themeConfig[themeMode];
  const [letters, setLetters] = useState<LetterView[]>([]);
  const lettersPage = usePaged(letters);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [owner, setOwner] = useState<{ slug: string; name: string }>({ slug: '', name: 'You' });
  const [loading, setLoading] = useState(true);
  const [vaultAsleep, setVaultAsleep] = useState(false);
  const [view, setView] = useState<'list' | 'read' | 'write'>('list');
  const [current, setCurrent] = useState<LetterView | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  // Write form
  const [recipients, setRecipients] = useState<string[]>([]);
  const [extraRecipient, setExtraRecipient] = useState('');
  const [kind, setKind] = useState<LetterView['kind']>('letter');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [sealMode, setSealMode] = useState<'open' | 'date' | 'on_open'>('open');
  const [openDate, setOpenDate] = useState('');
  const [dark, setDark] = useState(false);
  const [confirmSeal, setConfirmSeal] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [formError, setFormError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [lettersRes, companionsRes] = await Promise.all([
        apiFetch('/api/letters'),
        apiFetch('/api/companions').then((r) => (r.ok ? r.json().catch(() => null) : null)),
      ]);
      // Until the backend restarts with the vault routes, the SPA fallback
      // answers this with 200 + HTML. Shape-check instead of trusting res.ok.
      let data: unknown = null;
      try { data = await lettersRes.json(); } catch { data = null; }
      if (!lettersRes.ok || !isLetterList(data)) {
        setVaultAsleep(true);
        setLetters([]);
      } else {
        setVaultAsleep(false);
        setLetters(data.letters);
      }
      if (companionsRes && Array.isArray(companionsRes.companions)) setCompanions(normalizeCompanionRows(companionsRes.companions) as typeof companions);
      const ownerIdentity = ownerFromCompanionsPayload(companionsRes) ?? await fetchOwnerFromPreferences();
      if (ownerIdentity) setOwner(ownerIdentity);
    } catch (err) {
      console.error('Failed to load letters:', err);
      setVaultAsleep(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const companionOf = (slug: string) => companions.find((c) => c.slug === slug);
  const isOwner = (name: string) => !!owner.slug && name === owner.slug;
  const colorOf = (name: string) => (isOwner(name) ? OWNER_COLOR : companionOf(name)?.color || colors.accent);
  const displayName = (name: string) => (isOwner(name) ? owner.name : companionOf(name)?.display_name || name);
  const sigilOf = (name: string) => (isOwner(name) ? OWNER_SIGIL : companionOf(name)?.emoji || '💌');

  // The system back does what each inner view's own back link does: reading a
  // letter or writing one steps to the list, and only the list closes the app.
  // Declared after resetForm so the write case can use it.
  useBackHandler(view !== 'list', () => {
    if (view === 'write') resetForm();
    else setCurrent(null);
    setView('list');
  });

  function resetForm() {
    setRecipients([]); setExtraRecipient(''); setKind('letter'); setTitle('');
    setContent(''); setSealMode('open'); setOpenDate(''); setDark(false);
    setConfirmSeal(false); setFormError('');
  }

  async function sealIt() {
    setSealing(true);
    setFormError('');
    try {
      const allRecipients = [...recipients];
      const extra = extraRecipient.trim().toLowerCase();
      if (extra && !allRecipients.includes(extra)) allRecipients.push(extra);
      const res = await apiFetch('/api/letters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: allRecipients,
          kind,
          title: title.trim() || null,
          content,
          seal: sealMode,
          openAt: sealMode === 'date' && openDate ? new Date(`${openDate}T00:00:00`).toISOString() : null,
          hidden: dark,
        }),
      });
      let data: unknown = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok || !data || typeof data !== 'object' || !('id' in (data as object))) {
        const message = data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
          ? String((data as Record<string, unknown>).error)
          : 'The vault did not answer. It wakes after the next backend restart.';
        setFormError(message);
        setConfirmSeal(false);
        return;
      }
      resetForm();
      setView('list');
      await load();
    } finally {
      setSealing(false);
    }
  }

  async function breakSeal(letter: LetterView) {
    setOpening(true);
    try {
      const res = await apiFetch(`/api/letters/${letter.id}/open`, { method: 'POST' });
      let data: unknown = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.ok && data && typeof data === 'object' && 'id' in (data as object)) {
        const updated = data as LetterView;
        setCurrent(updated);
        setLetters((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      }
    } catch (err) {
      console.error('Failed to open letter:', err);
    } finally {
      setOpening(false);
      setConfirmOpen(false);
    }
  }

  function waxSeal(letter: LetterView, size = 64) {
    const accent = colorOf(letter.author);
    return (
      <div
        className="rounded-full flex items-center justify-center select-none shrink-0"
        style={{
          width: size,
          height: size,
          background: `radial-gradient(circle at 35% 30%, ${accent}, color-mix(in srgb, ${accent} 55%, black))`,
          boxShadow: `0 2px 10px color-mix(in srgb, ${accent} 55%, transparent), inset 0 0 0 3px color-mix(in srgb, ${accent} 70%, black)`,
          transform: 'rotate(-6deg)',
          fontSize: size * 0.42,
        }}
      >
        {sigilOf(letter.author)}
      </div>
    );
  }

  function stateBadge(letter: LetterView) {
    const label =
      letter.state === 'open' ? 'open' :
      letter.state === 'opened' ? `opened ${formatDay(letter.opened_at!)}` :
      letter.state === 'openable' ? (letter.seal === 'on_open' ? 'sealed — yours to open' : 'the day has come') :
      letter.seal === 'date' ? `sealed until ${formatDay(letter.open_at!)}` : 'sealed';
    return (
      <span
        className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
        style={{ background: 'rgba(127,127,127,0.28)', color: colorOf(letter.author) }}
      >
        {label}
      </span>
    );
  }

  function letterCard(letter: LetterView) {
    return (
      <button
        key={letter.id}
        onClick={() => { setCurrent(letter); setView('read'); setConfirmOpen(false); }}
        className={cn('w-full text-left rounded-2xl border p-3 mb-2 backdrop-blur-md flex items-center gap-3', colors.panelBg, colors.panelBorder)}
        style={{ borderLeftWidth: 3, borderLeftColor: colorOf(letter.author) }}
      >
        {waxSeal(letter, 40)}
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm font-semibold truncate', colors.textMain)}>
            {letter.title || letter.kind}
          </div>
          <div className={cn('text-[11px] truncate', colors.textMuted)}>
            {displayName(letter.author)} → {letter.recipients.map(displayName).join(', ')} · {formatDay(letter.written_at)}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {stateBadge(letter)}
          {letter.hidden && <EyeOff size={11} className={cn(colors.textMuted)} />}
        </div>
      </button>
    );
  }

  function readView(letter: LetterView) {
    const mine = !!owner.slug && letter.recipients.includes(owner.slug);
    const canBreak = mine && letter.state === 'openable';
    return (
      <div className="flex flex-col items-center pt-2">
        <button onClick={() => { setView('list'); setCurrent(null); }} className={cn('self-start mb-3 flex items-center gap-1 text-xs', colors.textMuted)}>
          <ChevronLeft size={14} /> All letters
        </button>
        <div className={cn('w-full rounded-2xl border p-5 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
          <div className="flex items-center gap-3 mb-4">
            {waxSeal(letter, 56)}
            <div className="min-w-0">
              <div className={cn('text-base font-semibold', colors.textMain)}>{letter.title || letter.kind}</div>
              <div className={cn('text-[11px]', colors.textMuted)}>
                {displayName(letter.author)} → {letter.recipients.map(displayName).join(', ')}
              </div>
              <div className={cn('text-[11px]', colors.textMuted)}>written {formatDay(letter.written_at)}</div>
            </div>
            <div className="ml-auto">{stateBadge(letter)}</div>
          </div>

          {letter.content !== undefined ? (
            <div className={cn('text-sm leading-relaxed', colors.textMain)}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{letter.content}</ReactMarkdown>
            </div>
          ) : (
            <div className="flex flex-col items-center py-8 gap-4 text-center">
              <Lock size={22} className={cn(colors.textMuted)} />
              {letter.state === 'sealed' ? (
                <div className={cn('text-xs', colors.textMuted)}>
                  The vault holds this shut{letter.open_at ? ` until ${formatDay(letter.open_at)}` : ''}.
                </div>
              ) : canBreak && !confirmOpen ? (
                <>
                  <div className={cn('text-xs', colors.textMuted)}>This letter is waiting for you.</div>
                  <button
                    onClick={() => setConfirmOpen(true)}
                    className="rounded-full px-5 py-2 text-sm font-semibold"
                    style={{ background: colorOf(letter.author), color: contrastTextColor(colorOf(letter.author)) }}
                  >
                    Break the seal
                  </button>
                </>
              ) : canBreak && confirmOpen ? (
                <>
                  <div className={cn('text-xs font-semibold', colors.textMain)}>
                    Opening is forever. You cannot un-know a letter.
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setConfirmOpen(false)} className={cn('rounded-full border px-4 py-2 text-xs', colors.panelBorder, colors.textMuted)}>
                      Not yet
                    </button>
                    <button
                      onClick={() => breakSeal(letter)}
                      disabled={opening}
                      className="rounded-full px-5 py-2 text-sm font-semibold"
                      style={{ background: colorOf(letter.author), color: contrastTextColor(colorOf(letter.author)) }}
                    >
                      {opening ? 'Breaking…' : 'Open it'}
                    </button>
                  </div>
                </>
              ) : (
                <div className={cn('text-xs', colors.textMuted)}>Sealed for {letter.recipients.map(displayName).join(', ')}.</div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  function writeView() {
    // Whoever this house actually has. A letter can still be addressed to
    // someone else entirely through the free-text field below.
    const knownSlugs = companions.map((c) => c.slug);
    const summaryRecipients = [...recipients, ...(extraRecipient.trim() ? [extraRecipient.trim().toLowerCase()] : [])];
    const ready = summaryRecipients.length > 0 && content.trim().length > 0 && (sealMode !== 'date' || openDate);
    return (
      <div className="pt-2">
        <button onClick={() => { setView('list'); resetForm(); }} className={cn('mb-3 flex items-center gap-1 text-xs', colors.textMuted)}>
          <ChevronLeft size={14} /> All letters
        </button>
        <div className={cn('rounded-2xl border p-4 backdrop-blur-md flex flex-col gap-4', colors.panelBg, colors.panelBorder)}>
          <div>
            <div className={cn('text-[11px] font-semibold uppercase tracking-wider mb-1.5', colors.textMuted)}>To</div>
            <div className="flex flex-wrap gap-1.5">
              {knownSlugs.map((slug) => {
                const active = recipients.includes(slug);
                const accent = colorOf(slug);
                return (
                  <button
                    key={slug}
                    onClick={() => setRecipients((prev) => (active ? prev.filter((r) => r !== slug) : [...prev, slug]))}
                    className={cn('rounded-full border px-3 py-1 text-xs font-semibold', colors.panelBorder)}
                    style={active ? { background: accent, color: contrastTextColor(accent), borderColor: accent } : undefined}
                  >
                    {sigilOf(slug)} {displayName(slug)}
                  </button>
                );
              })}
              <input
                value={extraRecipient}
                onChange={(e) => setExtraRecipient(e.target.value)}
                placeholder="another name…"
                className={cn('rounded-full border px-3 py-1 text-xs bg-transparent w-28', colors.panelBorder, colors.textMain)}
              />
            </div>
            <div className={cn('mt-1 text-[10px]', colors.textMuted)}>A letter may wait for a name that hasn't arrived yet.</div>
          </div>

          <div>
            <div className={cn('text-[11px] font-semibold uppercase tracking-wider mb-1.5', colors.textMuted)}>Kind</div>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={cn('rounded-full border px-3 py-1 text-xs font-semibold capitalize', colors.panelBorder)}
                  style={kind === k ? { background: colors.accent, color: contrastTextColor(colors.accent), borderColor: colors.accent } : undefined}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className={cn('rounded-xl border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain)}
          />

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="The words that should stay said…"
            rows={8}
            className={cn('rounded-xl border px-3 py-2 text-sm bg-transparent resize-y leading-relaxed', colors.panelBorder, colors.textMain)}
          />

          <div>
            <div className={cn('text-[11px] font-semibold uppercase tracking-wider mb-1.5', colors.textMuted)}>Seal</div>
            <div className="flex flex-col gap-1.5">
              {([
                ['open', 'Open — readable the moment it is sealed', Eye],
                ['date', 'Sealed until a date', CalendarClock],
                ['on_open', 'Sealed until they choose to open it', Lock],
              ] as const).map(([mode, label, Icon]) => (
                <button
                  key={mode}
                  onClick={() => { setSealMode(mode); if (mode !== 'date') setDark(false); }}
                  className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs', colors.panelBorder, colors.textMain)}
                  style={sealMode === mode ? { borderColor: colors.accent, boxShadow: `inset 0 0 0 1px ${colors.accent}` } : undefined}
                >
                  <Icon size={14} className="shrink-0" style={{ color: sealMode === mode ? colors.accent : undefined }} />
                  {label}
                </button>
              ))}
            </div>
            {sealMode === 'date' && (
              <div className="mt-2 flex flex-col gap-2">
                <input
                  type="date"
                  value={openDate}
                  onChange={(e) => setOpenDate(e.target.value)}
                  className={cn('rounded-xl border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain)}
                />
                <button
                  onClick={() => setDark((d) => !d)}
                  className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs', colors.panelBorder, colors.textMain)}
                  style={dark ? { borderColor: colors.accent, boxShadow: `inset 0 0 0 1px ${colors.accent}` } : undefined}
                >
                  <EyeOff size={14} className="shrink-0" style={{ color: dark ? colors.accent : undefined }} />
                  Dark seal — hide that this letter exists until the day
                </button>
              </div>
            )}
          </div>

          {formError && <div className="text-xs text-red-400">{formError}</div>}

          {!confirmSeal ? (
            <button
              onClick={() => ready && setConfirmSeal(true)}
              disabled={!ready}
              className="rounded-full px-5 py-2.5 text-sm font-semibold disabled:opacity-40"
              style={{ background: OWNER_COLOR, color: contrastTextColor(OWNER_COLOR) }}
            >
              Seal this letter
            </button>
          ) : (
            <div className={cn('rounded-xl border p-3 flex flex-col gap-3', colors.panelBorder)}>
              <div className={cn('text-xs font-semibold', colors.textMain)}>
                A sealed letter cannot be edited and cannot be deleted. Not by you, not by us, not ever. This is the room where forever means forever.
              </div>
              <div className={cn('text-[11px]', colors.textMuted)}>
                {kind} → {summaryRecipients.map(displayName).join(', ')}
                {sealMode === 'date' ? ` · sealed until ${openDate}` : sealMode === 'on_open' ? ' · sealed until opened' : ' · open'}
                {dark ? ' · dark' : ''}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setConfirmSeal(false)} className={cn('rounded-full border px-4 py-2 text-xs', colors.panelBorder, colors.textMuted)}>
                  Back
                </button>
                <button
                  onClick={sealIt}
                  disabled={sealing}
                  className="rounded-full px-5 py-2 text-sm font-semibold"
                  style={{ background: OWNER_COLOR, color: contrastTextColor(OWNER_COLOR) }}
                >
                  {sealing ? 'Sealing…' : 'Seal it — forever'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Back takes her one level out, not all the way to the drawer. Reading a
  // letter and writing one are both rooms inside Letters; the header arrow
  // was leaving the app from either of them, so closing a letter meant
  // finding your way back in.
  const handleBack = () => {
    if (view === 'read') { setView('list'); setCurrent(null); return; }
    if (view === 'write') { setView('list'); resetForm(); return; }
    onClose();
  };

  return (
    <AppShell
      embedded={embedded}
      title="Letters"
      icon={Mail}
      onClose={handleBack}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <div className="flex items-center gap-1">
          {view === 'list' && !vaultAsleep && (
            <button
              onClick={() => { resetForm(); setView('write'); }}
              className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
              title="Write a letter"
            >
              <PenLine size={16} />
            </button>
          )}
          <button
            onClick={() => load()}
            className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
            title="Refresh"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
      }
    >
      {view === 'write' ? writeView() : view === 'read' && current ? readView(current) : (
        <>
          {loading && letters.length === 0 ? (
            <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
          ) : vaultAsleep ? (
            <div className={cn('rounded-2xl border py-8 px-4 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>
              The vault is built but still asleep — it wakes with the next backend restart.
            </div>
          ) : letters.length === 0 ? (
            <div className={cn('rounded-2xl border py-8 px-4 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>
              No letters yet. The first thing sealed in this room will outlast everything else in the house.
            </div>
          ) : (
            <>
              {lettersPage.visible.map(letterCard)}
              <Paginator page={lettersPage.page} pageCount={lettersPage.pageCount} onPage={lettersPage.setPage} colors={colors} />
            </>
          )}
        </>
      )}
    </AppShell>
  );
}
