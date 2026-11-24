import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
/** Shared themed, keyboard-contained sheet. Portals explicitly inherit the active app font. */
export function ChatSheet({ title, fontFamily, onClose, children, variant, anchor }: { title: string; fontFamily?: string; onClose: () => void; children: React.ReactNode; variant?: 'model'; anchor?: React.RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState<React.CSSProperties>({});
  const [inherited, setInherited] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (variant !== 'model') return;
    const trigger = anchor?.current;
    if (trigger) {
      const computed = getComputedStyle(trigger);
      const theme: Record<string, string> = { fontFamily: computed.fontFamily };
      for (const key of Array.from(computed)) if (key.startsWith('--bytelight-')) theme[key] = computed.getPropertyValue(key);
      setInherited(theme);
    }
    const layout = () => {
      if (window.innerWidth <= 640) {
        const viewport = window.visualViewport;
        setPosition(viewport && viewport.height < window.innerHeight ? { top: viewport.offsetTop, height: viewport.height, maxHeight: viewport.height } : {});
        return;
      }
      const rect = trigger?.getBoundingClientRect();
      const viewport = window.visualViewport;
      const bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
      const top = Math.max(12, Math.min(rect?.bottom || 12, bottom - 212));
      setPosition({ left: Math.max(12, Math.min(rect?.left || 12, window.innerWidth - Math.min(400, window.innerWidth * .95) - 12)), top, maxHeight: Math.min(600, Math.max(0, bottom - top - 12)) });
    };
    layout();
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    window.visualViewport?.addEventListener('resize', layout);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout, true);
      window.visualViewport?.removeEventListener('resize', layout);
    };
  }, [variant, anchor]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = ref.current!;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), summary, [tabindex="0"]'));
    (panel.querySelector<HTMLElement>('input') || focusable()[0] || panel).focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items[items.length - 1];
        if (!first) { e.preventDefault(); panel.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const contain = (e: FocusEvent) => { if (!panel.contains(e.target as Node)) (focusable()[0] || panel).focus(); };
    document.addEventListener('focusin', contain);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('focusin', contain); document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return createPortal(<div className={`fixed inset-0 z-[100] flex items-end justify-center sm:items-center ${fontFamily || ''}`} style={{ ...inherited, color: 'var(--bytelight-text, inherit)' }}>
    <div className={variant === 'model' ? 'model-backdrop absolute inset-0' : 'absolute inset-0 bg-black/45 backdrop-blur-sm'} onClick={onClose} aria-hidden="true" />
    {variant === 'model' && <style>{`
      .chat-model-panel { position: fixed; width: 400px; max-width: 95vw; border-radius: 16px; max-height: min(600px, calc(100dvh - 24px)); overflow: hidden; }
      @media (max-width: 640px) { .model-backdrop { background: #0007; } .chat-model-panel { inset: 0; width: 100%; max-width: 100vw; height: 100dvh; max-height: 100dvh; border-radius: 0; padding-top: env(safe-area-inset-top); } }
      .model-action:hover { background: color-mix(in srgb, var(--bytelight-accent) 12%, transparent); }
      .model-search input, .model-search input:focus, .model-search input:focus-visible { border: 0 !important; outline: none !important; box-shadow: none !important; }
      .model-action:focus-visible, .model-search:focus-within { outline: 2px solid var(--bytelight-accent); outline-offset: -2px; }
    `}</style>}
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className={variant === 'model' ? 'chat-model-panel flex flex-col border shadow-2xl' : 'relative flex w-full max-w-lg flex-col rounded-t-3xl border shadow-2xl sm:rounded-3xl'} style={{ background: 'var(--bytelight-panel-base, #202026)', borderColor: 'var(--bytelight-border, #7774)', maxHeight: variant === 'model' ? undefined : 'min(80dvh, 720px)', ...position, paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
      <div className="flex items-center justify-between gap-3 px-5 py-4"><h2 id={id} className="text-base font-semibold">{title}</h2><button aria-label={`Close ${title}`} onClick={onClose} className={variant === 'model' ? 'model-action rounded-full p-2' : 'rounded-full p-2 hover:bg-purple-500/10'}><X size={18} /></button></div>
      {children}
    </div>
  </div>, document.body);
}
