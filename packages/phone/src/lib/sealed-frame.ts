// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The sealed frame: companion-written React run where it can touch nothing.
//
// The Artifacts app was the first to need it and the Story Shelf's scene
// widgets are the second, so the runtime lives here once. A frame is a srcdoc
// iframe with sandbox="allow-scripts" and never allow-same-origin: a null
// origin that cannot read the app's cookies, reach into the parent page or
// call the house's authenticated routes. Everything it needs is handed in
// rather than fetched, because it has nowhere to fetch from.
//
// A scene widget is sealed further than an artifact. It carries its own
// Content-Security-Policy that refuses every network request outright, and it
// gets a small bridge: its scene's data at load, and one thing it may say back
// to the page, a move.

// The sealed preview frame cannot fetch its own runtime: a srcdoc iframe
// inherits this page's CSP, and inside the null-origin sandbox script-src
// 'self' matches nothing — the on-device failure was the frame being refused
// /vendor/react. So the parent fetches the three vendor scripts here, where
// 'self' does apply, and inlines them into the srcdoc, which the same CSP
// permits via 'unsafe-inline'. A frame that loads nothing has nothing left
// to be refused. The script-close escape keeps vendor source from ending its
// own inline tag early.
let vendorTagsPromise: Promise<string> | null = null;
export function getVendorBundle(): Promise<string> {
  if (!vendorTagsPromise) {
    vendorTagsPromise = Promise.all(
      ['react.production.min.js', 'react-dom.production.min.js', 'babel.min.js'].map((file) =>
        fetch(`/vendor/${file}`).then((res) => {
          if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
          return res.text();
        }),
      ),
    ).then((sources) =>
      sources
        .map((src) => `<script>${src.replace(/<\/script/gi, '<\\/script')}<\/script>`)
        .join('\n'),
    );
    vendorTagsPromise.catch(() => {
      vendorTagsPromise = null;
    });
  }
  return vendorTagsPromise;
}

// House images inside artifacts break the same way the runtime did: the sealed
// frame sends no login with its requests, so /api/files answers 401 and the
// picture X's out. Same cure as the runtime — the parent fetches each
// referenced file with their person's session and hands it in as a data: URL, which the
// inherited CSP's img-src permits. ?w=768 rides the chat thumbnail convention.
const fileDataUrlCache = new Map<string, Promise<string>>();
function fileToDataUrl(path: string): Promise<string> {
  let p = fileDataUrlCache.get(path);
  if (!p) {
    p = fetch(`${path}?w=768`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      );
    fileDataUrlCache.set(path, p);
    p.catch(() => {
      fileDataUrlCache.delete(path);
    });
  }
  return p;
}

async function inlineRefs(code: string, pattern: RegExp): Promise<string> {
  const refs = Array.from(new Set(code.match(pattern) ?? []));
  const pairs = await Promise.all(
    refs.map(async (ref) => {
      try {
        return [ref, await fileToDataUrl(ref)] as const;
      } catch {
        return [ref, null] as const; // an unreachable file stays as-is
      }
    }),
  );
  let out = code;
  for (const [ref, dataUrl] of pairs) {
    if (dataUrl) out = out.split(ref).join(dataUrl);
  }
  return out;
}

/** The house files an artifact names (/api/files/<id>), handed in as data: URLs. */
export function inlineHouseImages(code: string): Promise<string> {
  return inlineRefs(code, /\/api\/files\/[A-Za-z0-9-]+/g);
}

/**
 * The same for a scene widget, which may also name a picture from the Studio
 * gallery. A widget's own CSP refuses every request, so anything it shows or
 * plays has to arrive inside it. Non-images (a recording, say) come back whole:
 * the files route ignores ?w= for anything it cannot shrink.
 */
export function inlineHouseMedia(code: string): Promise<string> {
  return inlineRefs(code, /\/api\/(?:files\/[A-Za-z0-9-]+|studio\/gallery\/[A-Za-z0-9._%-]+)/g);
}

/**
 * A scene widget's own policy, on top of the one the frame inherits: the two
 * are both enforced, so this can only take things away. It takes away the
 * network. Scripts and styles may run inline, which is how the runtime arrives;
 * pictures and sound only as data: or blob: URLs, which is how the house hands
 * them in; and nothing may connect, frame, post a form or load from anywhere.
 */
export const STORY_WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** The one kind of message a scene widget may send the page. */
export const STORY_MOVE_MESSAGE = 'story-move';

export interface SealedPageOptions {
  themeMode: 'light' | 'dark';
  accent: string;
  houseFont: string;
  /** Markup placed straight after the charset, before anything loads: a widget's own CSP goes here. */
  headStart?: string;
  /** A script run after the runtime arrives and before the component is found: a widget's bridge. */
  prelude?: string;
  /** A JavaScript expression for the props the component is rendered with. */
  propsExpression?: string;
  /**
   * Whether the frame asks the house for its own font files (the default). A
   * widget's policy refuses every request, fonts included, so a widget page
   * leaves them out and falls back to the system's sans rather than filling
   * the console with refusals.
   */
  houseFonts?: boolean;
}

/** The house's font files, which the frame fetches from the house itself. */
const HOUSE_FONT_FACES = `    @font-face {
      font-family: 'Geist';
      src: url('/fonts/Geist-Regular.woff2') format('woff2');
      font-weight: 400; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('/fonts/Geist-Medium.woff2') format('woff2');
      font-weight: 500; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('/fonts/Geist-SemiBold.woff2') format('woff2');
      font-weight: 600; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('/fonts/Geist-Bold.woff2') format('woff2');
      font-weight: 700; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      src: url('/fonts/JetBrainsMono-Regular.woff2') format('woff2');
      font-weight: 400; font-style: normal; font-display: swap;
    }
`;

/**
 * The frame's document, with two holes the caller fills once the vendor
 * scripts and the code are in hand (fillSealedPage). With no widget options
 * this is, character for character, the document the Artifacts app has always
 * built.
 */
export function sealedPageTemplate({ themeMode, accent, houseFont, headStart, prelude, propsExpression, houseFonts = true }: SealedPageOptions): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">${headStart ? `\n  ${headStart}` : ''}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
${houseFonts ? HOUSE_FONT_FACES : ''}    * { box-sizing: border-box; margin: 0; padding: 0; }
    img, video, canvas { max-width: 100%; height: auto; }
    body {
      font-family: ${houseFont};
      background: ${themeMode === 'dark' ? '#0a0a0f' : '#ffffff'};
      color: ${themeMode === 'dark' ? '#ffffff' : '#1a1a1a'};
      padding: 0;
      margin: 0;
      min-height: 100%;
      height: 100%;
    }
    html { height: 100%; }
    /* Themed scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: ${themeMode === 'dark' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'}; border-radius: 3px; }
    ::-webkit-scrollbar-thumb { background: ${accent}; border-radius: 3px; }
    * { scrollbar-width: thin; scrollbar-color: ${accent} ${themeMode === 'dark' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'}; }
    #root { width: 100%; }
    .error { color: ${accent}; padding: 1rem; background: ${themeMode === 'dark' ? 'rgba(127,127,127,0.1)' : 'rgba(0,0,0,0.05)'}; border-radius: 8px; }
    .loading { color: #888; text-align: center; padding: 2rem; }
  </style>
</head>
<body>
  <div id="root"><div class="loading">Loading...</div></div>
  __VENDOR_SCRIPTS__${prelude ? `\n  <script>${prelude.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
  <script>
    (function() {
      // An artifact written wider than this screen gets zoomed to fit whole
      // rather than clipped: zoom reflows layout, so no ghost scrollbars.
      function fitToScreen() {
        var rootEl = document.getElementById('root');
        if (!rootEl) return;
        rootEl.style.zoom = '';
        var w = rootEl.scrollWidth;
        var vw = document.documentElement.clientWidth;
        if (w > vw + 4) rootEl.style.zoom = String(vw / w);
      }
      window.addEventListener('resize', fitToScreen);

      function onReady() {
        try {
          var code = decodeURIComponent(atob('__ARTIFACT_CODE__'));

          // Check if code has JSX (looks for < followed by uppercase or common tags)
          var hasJSX = /<[A-Z]|<div|<span|<button|<input|<img|<a |<p>|<h[1-6]/.test(code);
          // Check if code has imports (needs stripping)
          var hasImports = /^\\s*import\\s+/m.test(code);

          // Strip module syntax unconditionally — a pre-compiled artifact can
          // carry an export without carrying any JSX or imports.
          code = code.replace(/^\\s*import\\s+.*?['"].*?['"];?\\s*$/gm, '');
          code = code.replace(/export\\s+default\\s+/g, '');
          code = code.replace(/^\\s*export\\s+(?=(?:function|class|const|let|var)\\s)/gm, '');

          var execCode = code;
          if (hasJSX && typeof Babel !== 'undefined') {
            // Transform JSX to createElement calls
            var result = Babel.transform(code, {
              presets: ['react'],
              filename: 'artifact.jsx'
            });
            execCode = result.code;
          }

          // Execute the code using indirect eval (global scope) and capture result
          // Wrap code to assign any defined components to window
          // Conventional names win, then ANY capitalised top-level declaration in
          // the artifact itself — so a component doesn't have to be named from a
          // fixed menu to be renderable. Later declarations are tried first, since
          // helpers are usually defined above the component that uses them.
          var preferredNames = ['App', 'Main', 'Artifact', 'Default'];
          var discovered = [];
          var declRe = /(?:^|\\n)\\s*(?:function|class|const|let|var)\\s+([A-Z][A-Za-z0-9_$]*)/g;
          var declMatch;
          while ((declMatch = declRe.exec(execCode)) !== null) {
            if (preferredNames.indexOf(declMatch[1]) === -1 && discovered.indexOf(declMatch[1]) === -1) {
              discovered.unshift(declMatch[1]);
            }
          }
          var componentNames = preferredNames.concat(discovered);

          // Use Function constructor to run in global scope
          var fn = new Function('React', 'ReactDOM', 'useState', 'useEffect', 'useRef', 'useCallback',
            execCode + ';\\n' +
            'var __candidates = [];\\n' +
            componentNames.map(function(n) {
              return 'try { if (typeof ' + n + ' === "function") __candidates.push(' + n + '); } catch(e) {}';
            }).join('\\n') + '\\n' +
            'return __candidates[0] || null;'
          );

          var Component = fn(React, ReactDOM, React.useState, React.useEffect, React.useRef, React.useCallback);

          if (Component) {
            var root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(React.createElement(Component${propsExpression ? `, ${propsExpression}` : ''}));
            setTimeout(fitToScreen, 100);
            setTimeout(fitToScreen, 600);
          } else {
            document.getElementById('root').innerHTML = '<div class="error">No renderable component found. Define App, Main, Artifact, or a named export.</div>';
          }
        } catch (err) {
          document.getElementById('root').innerHTML = '<div class="error">Error: ' + err.message + '</div>';
          console.error('Artifact render error:', err);
        }
      }

      onReady();
    })();
  </script>
</body>
</html>`;
}

/**
 * Fill the template's two holes. The function-form replace keeps $-sequences
 * in minified vendor source from being read as replacement patterns.
 */
export function fillSealedPage(template: string, vendorTags: string, code: string): string {
  const encodedCode = btoa(encodeURIComponent(code));
  return template
    .replace('__VENDOR_SCRIPTS__', () => vendorTags)
    .replace('__ARTIFACT_CODE__', () => encodedCode);
}

/** What a scene widget is handed at load, as `story` on its props and on window. */
export interface StoryWidgetData {
  book: { id: string; title: string; genre: string };
  page: { id: string };
  state: unknown;
  choices: Array<{ id: string; label: string; hint?: string }>;
}

/**
 * The widget's bridge, run inside the frame before the widget. It puts its
 * scene's data on window.story, and window.story.move(value) is the one thing
 * it can say back: a move, posted to the page as { type: 'story-move', value }.
 * The data is base64 of URI-encoded JSON so nothing in it can close a tag.
 */
export function storyWidgetPrelude(data: StoryWidgetData): string {
  const packed = btoa(encodeURIComponent(JSON.stringify(data)));
  return [
    '(function () {',
    `  var story = JSON.parse(decodeURIComponent(atob('${packed}')));`,
    '  story.move = function (value) {',
    `    window.parent.postMessage({ type: '${STORY_MOVE_MESSAGE}', value: String(value) }, '*');`,
    '  };',
    '  window.story = story;',
    '  window.storyMove = story.move;',
    '})();',
  ].join('\n');
}

/**
 * The house's colors, handed to a widget as CSS variables so it can match the
 * room it sits in without guessing: --story-accent, --story-on-accent,
 * --story-text, --story-muted, --story-panel and --story-border.
 */
export function storyWidgetColorStyle(colors: Record<'accent' | 'onAccent' | 'text' | 'muted' | 'panel' | 'border', string>): string {
  const safe = (value: string) => value.replace(/[<>;{}]/g, '');
  return `<style>:root { --story-accent: ${safe(colors.accent)}; --story-on-accent: ${safe(colors.onAccent)}; `
    + `--story-text: ${safe(colors.text)}; --story-muted: ${safe(colors.muted)}; --story-panel: ${safe(colors.panel)}; `
    + `--story-border: ${safe(colors.border)}; }</style>`;
}
