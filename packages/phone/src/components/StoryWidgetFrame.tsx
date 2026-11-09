// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// A scene's own widget, written fresh by the companions for that scene: a
// recovered recording, a lock to pick, a map. It runs in the sealed frame the
// Artifacts app uses (lib/sealed-frame.ts), sealed further: its own policy
// refuses every network request, so whatever it shows or plays is handed in
// with it, and it can say exactly one thing back, a move.
//
// The move is not taken from here. It goes to the book, which shows it to the
// owner and sends it only when they say so: a widget can be written to answer
// by itself, and their person's moves are theirs.

import { useEffect, useRef, useState } from 'react';
import type { StoryBookSummary, StoryPage } from '@bytelight/shared';
import { cn } from '../lib/utils';
import type { ThemeColors } from '../lib/theme';
import {
  STORY_WIDGET_CSP,
  fillSealedPage,
  getVendorBundle,
  inlineHouseMedia,
  sealedPageTemplate,
  storyWidgetColorStyle,
  storyWidgetPrelude,
} from '../lib/sealed-frame';
import { readWidgetMove } from '../lib/story-shelf';

const HAIRLINE = 'color-mix(in oklch, var(--bytelight-border) 80%, transparent)';

/** The frame's two heights: enough for most widgets, and room for a map. */
const FRAME_HEIGHT = { short: 340, tall: 560 } as const;

/** The house's colors as the frame can use them, read off the page as it stands. */
function houseColors(fallbackAccent: string) {
  const vars = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => vars.getPropertyValue(name).trim() || fallback;
  return {
    accent: read('--bytelight-accent', fallbackAccent),
    onAccent: read('--bytelight-on-accent', 'white'),
    text: read('--bytelight-text', 'currentColor'),
    muted: read('--bytelight-text-muted', 'gray'),
    panel: read('--bytelight-panel-base', 'transparent'),
    border: read('--bytelight-border', 'gray'),
  };
}

export function StoryWidgetFrame({
  book,
  page,
  themeMode,
  colors,
  onMove,
}: {
  book: Pick<StoryBookSummary, 'id' | 'title' | 'genre'>;
  page: StoryPage;
  themeMode: 'light' | 'dark';
  colors: ThemeColors;
  onMove: (value: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [tall, setTall] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const latestOnMove = useRef(onMove);
  latestOnMove.current = onMove;

  // The book is read again every few seconds while a page is on its way, and
  // every read hands over fresh objects. Rebuilding the frame on each would
  // wipe whatever their person was in the middle of doing in it, so it is rebuilt only
  // when what it was handed actually changes.
  const handed = JSON.stringify({ state: page.state, choices: page.choices });

  // Build the frame's document: the runtime and the widget's own pictures
  // are fetched here, with their person's session, and handed in, because the frame
  // itself can reach nothing.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !page.widget) return;
    setFailed(null);
    const houseRoot = document.querySelector('.bytelight-root');
    const houseFont = (houseRoot && getComputedStyle(houseRoot).fontFamily)
      || '"Geist", ui-sans-serif, system-ui, sans-serif';
    const template = sealedPageTemplate({
      themeMode,
      accent: colors.accent,
      houseFont,
      headStart: `<meta http-equiv="Content-Security-Policy" content="${STORY_WIDGET_CSP}">\n  `
        + storyWidgetColorStyle(houseColors(colors.accent)),
      prelude: storyWidgetPrelude({
        book: { id: book.id, title: book.title, genre: book.genre },
        page: { id: page.id },
        state: page.state,
        choices: page.choices,
      }),
      propsExpression: 'window.story',
      // Its own policy refuses the house's font files like everything else,
      // so it asks for none and writes in the system's sans.
      houseFonts: false,
    });
    let stale = false;
    Promise.all([getVendorBundle(), inlineHouseMedia(page.widget)])
      .then(([vendorTags, code]) => {
        if (!stale && frameRef.current === frame) frame.srcdoc = fillSealedPage(template, vendorTags, code);
      })
      .catch((error) => {
        if (!stale) setFailed(error instanceof Error ? error.message : String(error));
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `handed` stands for page.state and page.choices
  }, [book.id, book.title, book.genre, page.id, page.widget, handed, themeMode, colors.accent]);

  // The one message it may send. Anything that is not a well-formed move from
  // this frame, whoever sent it, is not heard at all.
  useEffect(() => {
    const heard = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const value = readWidgetMove(event.data);
      if (value) latestOnMove.current(value);
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, []);

  if (failed) {
    return (
      <p className={cn('mt-3 rounded-xl border px-3 py-2 text-[12px] italic', colors.panelBorder, colors.textMuted)}>
        This scene’s widget could not be set up just now ({failed}). The choices below still work.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <div className="overflow-hidden rounded-xl border" style={{ borderColor: HAIRLINE }}>
        {/* Scripts only, and never the same-origin flag: a null origin, walled
            off from the app's cookies, its page and its authenticated routes.
            The two flags together would undo the sandbox entirely. */}
        <iframe
          ref={frameRef}
          title={`Something to try in “${book.title}”`}
          sandbox="allow-scripts"
          className="block w-full border-0"
          style={{ height: tall ? FRAME_HEIGHT.tall : FRAME_HEIGHT.short }}
        />
      </div>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={() => setTall((was) => !was)}
          className={cn('rounded-[var(--shape-control)] px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
        >
          {tall ? 'Make it smaller' : 'Make it taller'}
        </button>
      </div>
    </div>
  );
}
