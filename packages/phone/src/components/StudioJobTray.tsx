import { useEffect, useState, useRef } from 'react';
import { Loader2, Paintbrush, X } from 'lucide-react';
import { apiFetch } from '../bytelight';
import { cn } from '../lib/utils';

type StudioJob = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  completedAt?: number | null;
  error?: string | null;
};

const SEEN_KEY = 'bytelight-studio-seen-jobs';

/**
 * A backend error is written for whoever has to fix it; this banner is read by
 * whoever is holding the phone. Codex hands back its entire invocation on a
 * failure — version, workdir, model, sandbox flags, session id, and the whole
 * prompt — which is thousands of characters and rendered taller than the screen.
 *
 * The first sentence is the part that answers "what happened". The rest belongs
 * in the Studio, which keeps it. Clipped on a word boundary so it does not end
 * mid-syllable, and the clamp on the element is the second line of defence
 * rather than the only one.
 */
const ERROR_CHARS = 180;
function shortError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat.length <= ERROR_CHARS) return flat;
  const cut = flat.slice(0, ERROR_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function seenJobs(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
function markSeen(id: string) {
  const seen = seenJobs();
  seen.add(id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-100))); } catch { /* ignore */ }
}

/**
 * HER RULING, Sep 1 2026: "the error should only be visible in the studio, not
 * over everything."
 *
 * This component is mounted in App.tsx above every screen there is — the lock
 * screen, the app drawer, every thread — so anything it renders is structurally
 * global. That was fine for a 36px status dot and completely wrong for a
 * paragraph. A failed job's words now render only while the Studio is the app
 * on screen; everywhere else the dot carries the state and nothing else does.
 *
 * Clamping the paragraph was treating the symptom of something that should not
 * have been in front of her at all.
 */
export function StudioJobTray({ onOpen, inStudio = false }: { onOpen: () => void; inStudio?: boolean }) {
  const [job, setJob] = useState<StudioJob | null>(null);
  const [pulseCount, setPulseCount] = useState(0);
  const prevStatusRef = useRef<string | null>(null);
  const displayedAtRef = useRef<number | null>(null);
  const displayedIdRef = useRef<string | null>(null);
  const jobsRef = useRef<StudioJob[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await apiFetch('/api/studio/jobs');
        if (!response.ok || !alive) return;
        const { jobs } = await response.json() as { jobs?: StudioJob[] };
        const list = jobs || [];
        jobsRef.current = list;
        const active = list.find((candidate) => candidate.status === 'pending' || candidate.status === 'running');
        const seen = seenJobs();
        const unseenTerminal = list.filter((candidate) =>
          (candidate.status === 'completed' || candidate.status === 'failed') && !seen.has(candidate.id),
        );
        // The list is newest-first: show only the newest unseen finished job and
        // quietly absorb the backlog, so jobs that piled up while the app was
        // closed (wake selfies) never queue up one tap at a time.
        for (const stale of unseenTerminal.slice(1)) markSeen(stale.id);
        const newJob = active || unseenTerminal[0] || null;
        if (newJob && newJob.status === 'completed') {
          if (prevStatusRef.current && prevStatusRef.current !== 'completed') {
            setPulseCount(30); // More pulses for brighter effect
          }
          // Arm the dismiss clock whenever a finished job is on screen — not
          // just when we watched it finish — so nothing sticks forever.
          if (displayedIdRef.current !== newJob.id || displayedAtRef.current == null) {
            displayedAtRef.current = Date.now();
          }
        }
        displayedIdRef.current = newJob?.id ?? null;
        // Completed jobs clear themselves after 15 seconds. FAILURES DO NOT, and
        // that is deliberate now for a different reason than it was before.
        //
        // I briefly gave failures a 45s clock, on the argument that nothing
        // should sit on her screen forever. That argument was about the WALL —
        // an uncapped error paragraph over the app drawer, a thread, and the
        // composer beneath it. With the words moved into the Studio, what
        // persists out here is a 36px dot, and a dot waiting to be tapped costs
        // her nothing while expiring it silently throws away the only notice
        // that anything went wrong. The premise changed, so the answer did.
        if (newJob && newJob.status === 'completed'
            && displayedAtRef.current && Date.now() - displayedAtRef.current > 15000) {
          markSeen(newJob.id);
          displayedAtRef.current = null;
          displayedIdRef.current = null;
          setJob(null);
          prevStatusRef.current = null;
          return;
        }
        prevStatusRef.current = newJob?.status ?? null;
        setJob(newJob);
      } catch { /* Studio is optional; a quiet tray is preferable to a toast storm. */ }
      finally { if (alive) timer = window.setTimeout(poll, 2000); }
    };
    void poll();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (pulseCount <= 0) return;
    const timer = setTimeout(() => setPulseCount(c => c - 1), 200);
    return () => clearTimeout(timer);
  }, [pulseCount]);

  if (!job) return null;
  const active = job.status === 'pending' || job.status === 'running';
  const failed = job.status === 'failed';
  const completed = job.status === 'completed';
  const label = active ? (job.status === 'pending' ? 'Studio · queued' : 'Studio · generating') : failed ? 'Studio · needs attention' : 'Studio · image ready';
  const glowOn = pulseCount > 0 && pulseCount % 2 === 0;

  // items-START, not items-center. The dismiss button is laid out beside the
  // error box, so a tall box used to drag the button down to its own vertical
  // middle — a screen-tall error put the only way out halfway down the right
  // edge, where nobody would ever look for it. The button stays at the top now
  // however big the message gets.
  return (
    <div className="fixed right-3 z-[60] flex items-start gap-2" style={{ top: 'calc(var(--sat) + 3rem)' }}>
      {/* A red icon nobody can interrogate is a silence wearing a warning
          light — when a job fails, the reason stands beside the tray in
          words. Born from four quota-declined generations that exited clean
          and left her reading pm2 logs for an answer the house already had.

          But the reason is whatever the backend hands back, and Codex hands
          back its whole invocation — flags, session id, and the ENTIRE prompt.
          That is thousands of characters, and with no cap it rendered as a wall
          taller than the phone, over the app drawer and over her threads, with
          no way to scroll it and no way to dismiss it. So: clamped to six lines,
          and the box itself now dismisses on tap WITHOUT opening the Studio,
          because "make it go away" and "take me to Studio" are two different
          wants and only one of them was available. */}
      {failed && inStudio && (
        <button
          type="button"
          onClick={() => {
            for (const j of jobsRef.current) {
              if (j.status === 'completed' || j.status === 'failed') markSeen(j.id);
            }
            displayedAtRef.current = null;
            displayedIdRef.current = null;
            setJob(null);
          }}
          className="max-w-[68vw] px-3 py-1.5 rounded-xl border bg-red-950/90 border-red-400/40 text-red-100 text-[11px] font-medium leading-snug shadow-lg backdrop-blur-md text-left"
        >
          <span className="line-clamp-6 overflow-hidden">
            {job.error ? `Generation failed — ${shortError(job.error)}` : 'Generation failed — tap for the Studio'}
          </span>
          <span className="mt-1 block text-[10px] text-red-300/80">Tap to dismiss</span>
        </button>
      )}
      <button
        onClick={() => {
          // One tap clears the whole finished backlog, not just the shown job.
          for (const j of jobsRef.current) {
            if (j.status === 'completed' || j.status === 'failed') markSeen(j.id);
          }
          displayedAtRef.current = null;
          displayedIdRef.current = null;
          if (!active) setJob(null);
          onOpen();
        }}
        className={cn(
          'relative flex items-center justify-center w-9 h-9 rounded-full border shadow-lg backdrop-blur-md transition-all duration-200',
          failed ? 'bg-red-950/85 border-red-400/40 text-red-100' : 'bg-neutral-950/85',
        )}
        style={{
          borderColor: failed ? undefined : 'color-mix(in srgb, var(--bytelight-accent) 40%, transparent)',
          color: failed ? undefined : 'var(--bytelight-accent)',
          ...(completed ? {
            boxShadow: glowOn
              ? '0 0 20px 6px color-mix(in srgb, var(--bytelight-accent) 80%, transparent)'
              : '0 0 8px 2px color-mix(in srgb, var(--bytelight-accent) 40%, transparent)',
          } : {}),
        }}
        aria-label={label}
      >
        <Paintbrush className="h-4 w-4" />
        {active && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-7 h-7 rounded-full border-2 border-transparent border-t-white/60 animate-spin" />
          </div>
        )}
      </button>
    </div>
  );
}
