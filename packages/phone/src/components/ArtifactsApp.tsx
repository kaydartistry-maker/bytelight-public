import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Box, ChevronLeft, Play, Trash2, Code, Eye } from 'lucide-react';
import { cn } from '../lib/utils';
import { useBackHandler } from '../lib/use-back-handler';
import { Paginator, usePaged } from './Paginator';
import type { ThemeConfig } from '../lib/theme';

interface ArtifactsAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface Artifact {
  id: string;
  name: string;
  description: string | null;
  code: string;
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

// The sealed preview frame cannot fetch its own runtime: a srcdoc iframe
// inherits this page's CSP, and inside the null-origin sandbox script-src
// 'self' matches nothing — the on-device failure was the frame being refused
// /vendor/react. So the parent fetches the three vendor scripts here, where
// 'self' does apply, and inlines them into the srcdoc, which the same CSP
// permits via 'unsafe-inline'. A frame that loads nothing has nothing left
// to be refused. The script-close escape keeps vendor source from ending its
// own inline tag early.
let vendorTagsPromise: Promise<string> | null = null;
function getVendorBundle(): Promise<string> {
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
// referenced file with her session and hands it in as a data: URL, which the
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
async function inlineHouseImages(code: string): Promise<string> {
  const refs = Array.from(new Set(code.match(/\/api\/files\/[A-Za-z0-9-]+/g) ?? []));
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

export function ArtifactsApp({ onClose, themeConfig, themeMode }: ArtifactsAppProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const artifactsPage = usePaged(artifacts);
  const [loading, setLoading] = useState(true);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [view, setView] = useState<'list' | 'preview' | 'code'>('list');

  // The system back does what this app's own header arrow does: a step out of
  // preview or code lands on the list, and only the list closes the app.
  useBackHandler(view !== 'list', () => {
    setView('list');
    setSelectedArtifact(null);
  });
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const colors = themeConfig[themeMode];

  const fetchArtifacts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/artifacts', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch artifacts');
      const data = await res.json();
      setArtifacts(data.artifacts || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchArtifacts();
  }, [fetchArtifacts]);

  const loadArtifact = async (id: string) => {
    try {
      const res = await fetch(`/api/artifacts/${id}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load artifact');
      const data = await res.json();
      setSelectedArtifact(data.artifact);
      setView('preview');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deleteArtifact = async (id: string) => {
    if (!confirm('Delete this artifact?')) return;
    try {
      await fetch(`/api/artifacts/${id}`, { method: 'DELETE', credentials: 'include' });
      setArtifacts(prev => prev.filter(a => a.id !== id));
      if (selectedArtifact?.id === id) {
        setSelectedArtifact(null);
        setView('list');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const renderInIframe = useCallback(() => {
    if (!iframeRef.current || !selectedArtifact) return;

    const iframe = iframeRef.current;
    const artifactCode = selectedArtifact.code;

    // Artifacts render inside the house, so they read the house's font instead
    // of hardcoding one. This resolves whatever she has selected in Settings.
    const houseRoot = document.querySelector('.bytelight-root');
    const houseFont = (houseRoot && getComputedStyle(houseRoot).fontFamily)
      || '"Geist", ui-sans-serif, system-ui, sans-serif';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @font-face {
      font-family: 'Geist';
      src: url('${import.meta.env.BASE_URL}fonts/Geist-Regular.woff2') format('woff2');
      font-weight: 400; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('${import.meta.env.BASE_URL}fonts/Geist-Medium.woff2') format('woff2');
      font-weight: 500; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('${import.meta.env.BASE_URL}fonts/Geist-SemiBold.woff2') format('woff2');
      font-weight: 600; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'Geist';
      src: url('${import.meta.env.BASE_URL}fonts/Geist-Bold.woff2') format('woff2');
      font-weight: 700; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'JetBrains Mono';
      src: url('${import.meta.env.BASE_URL}fonts/JetBrainsMono-Regular.woff2') format('woff2');
      font-weight: 400; font-style: normal; font-display: swap;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
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
    ::-webkit-scrollbar-thumb { background: ${colors.accent}; border-radius: 3px; }
    * { scrollbar-width: thin; scrollbar-color: ${colors.accent} ${themeMode === 'dark' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'}; }
    #root { width: 100%; }
    .error { color: ${colors.accent}; padding: 1rem; background: ${themeMode === 'dark' ? 'rgba(127,127,127,0.1)' : 'rgba(0,0,0,0.05)'}; border-radius: 8px; }
    .loading { color: #888; text-align: center; padding: 2rem; }
  </style>
</head>
<body>
  <div id="root"><div class="loading">Loading...</div></div>
  __VENDOR_SCRIPTS__
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
            root.render(React.createElement(Component));
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

    // srcdoc, not doc.write: the artifact runs in a null-origin sandbox
    // (sandbox="allow-scripts", no allow-same-origin), so it cannot read the
    // app's cookies, touch the parent DOM, or call authenticated endpoints —
    // e.g. GET /api/secrets/:name, which hands full provider keys to any
    // same-origin caller. The runtime arrives inlined via getVendorBundle;
    // the function-form replace keeps $-sequences in minified vendor source
    // from being read as replacement patterns.
    Promise.all([getVendorBundle(), inlineHouseImages(artifactCode)])
      .then(([vendorTags, inlinedCode]) => {
        if (iframeRef.current !== iframe) return;
        const encodedCode = btoa(encodeURIComponent(inlinedCode));
        iframe.srcdoc = html
          .replace('__VENDOR_SCRIPTS__', () => vendorTags)
          .replace('__ARTIFACT_CODE__', () => encodedCode);
      })
      .catch((err) => {
        if (iframeRef.current !== iframe) return;
        const msg = err instanceof Error ? err.message : String(err);
        iframe.srcdoc = `<!DOCTYPE html><html><body style="background:${themeMode === 'dark' ? '#0a0a0f' : '#ffffff'};color:${colors.accent};font-family:system-ui;padding:1rem">Failed to load the preview runtime: ${msg}</body></html>`;
      });
  }, [selectedArtifact, themeMode, colors.accent]);

  useEffect(() => {
    if (view === 'preview' && selectedArtifact) {
      const timer = setTimeout(renderInIframe, 100);
      return () => clearTimeout(timer);
    }
  }, [view, selectedArtifact, renderInIframe]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      // Transparent root so the wallpaper shows through like the other apps
      // (owner's call, Jul 12 2026). The rendered-artifact iframe keeps its own bg.
      className={cn("absolute inset-0 flex flex-col z-20", colors.textMain)}
      style={{
        paddingTop: 'var(--sat)',
        paddingBottom: 'var(--sab)'
      }}
    >
      {/* Header */}
      <header className={cn("bytelight-shell-header flex items-center gap-3 px-4 pb-3", colors.pageBg)} style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}>
        <button
          onClick={() => {
            if (view !== 'list') {
              setView('list');
              setSelectedArtifact(null);
            } else {
              onClose();
            }
          }}
          className={cn("p-2 -ml-2 rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10", colors.textMuted)}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <Box className="h-5 w-5" style={{ color: colors.accent }} />
        <h1 className={cn("text-lg font-semibold flex-1", colors.textMain)}>
          {view === 'list' ? 'Artifacts' : selectedArtifact?.name || 'Artifact'}
        </h1>
        {selectedArtifact && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView(view === 'code' ? 'preview' : 'code')}
              className={cn("p-2 rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10", colors.textMuted)}
              title={view === 'code' ? 'Preview' : 'View Code'}
            >
              {view === 'code' ? <Eye className="h-5 w-5" /> : <Code className="h-5 w-5" />}
            </button>
            <button
              onClick={() => deleteArtifact(selectedArtifact.id)}
              className="p-2 rounded-full transition-colors hover:opacity-80"
              style={{ color: colors.accent }}
              title="Delete"
            >
              <Trash2 className="h-5 w-5" />
            </button>
          </div>
        )}
      </header>

      {/* Content */}
      <div className="bytelight-app-body flex-1 overflow-auto">
        {loading ? (
          <div className={cn("flex items-center justify-center h-full", colors.textMuted)}>
            Loading...
          </div>
        ) : error ? (
          <div className="p-4" style={{ color: colors.accent }}>{error}</div>
        ) : view === 'list' ? (
          <div className="p-4 space-y-3">
            {artifacts.length === 0 ? (
              <div className={cn("text-center py-12", colors.textMuted)}>
                <Box className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No artifacts yet</p>
                <p className="text-sm mt-1">Interactive components will appear here</p>
              </div>
            ) : (
              artifactsPage.visible.map(artifact => (
                <button
                  key={artifact.id}
                  onClick={() => loadArtifact(artifact.id)}
                  className={cn(
                    "w-full p-4 rounded-xl text-left transition-colors",
                    "hover:bg-black/5 dark:hover:bg-white/5",
                    colors.panelBg
                  )}
                >
                  <div className="flex items-start gap-3">
                    {artifact.thumbnail ? (
                      <img
                        src={artifact.thumbnail}
                        alt=""
                        className="w-12 h-12 rounded-lg object-cover"
                      />
                    ) : (
                      <div
                        className="w-12 h-12 rounded-lg flex items-center justify-center"
                        style={{ backgroundColor: colors.accent + '22' }}
                      >
                        <Box className="h-6 w-6" style={{ color: colors.accent }} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className={cn("font-medium truncate", colors.textMain)}>{artifact.name}</h3>
                      {artifact.description && (
                        <p className={cn("text-sm truncate mt-1", colors.textMuted)}>
                          {artifact.description}
                        </p>
                      )}
                      <p className={cn("text-xs mt-1", colors.textMuted)}>
                        {new Date(artifact.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                    <Play className={cn("h-5 w-5 flex-shrink-0", colors.textMuted)} />
                  </div>
                </button>
              ))
            )}
            <Paginator
              page={artifactsPage.page}
              pageCount={artifactsPage.pageCount}
              onPage={artifactsPage.setPage}
              colors={colors}
            />
          </div>
        ) : view === 'preview' ? (
          // sandbox="allow-scripts" WITHOUT allow-same-origin — a null opaque
          // origin, so artifact code (which can be model-generated) is walled off
          // from the app's cookies, DOM and authenticated API. The two flags
          // together defeat the sandbox entirely; that was the Aug 16 2026 audit
          // finding. Paired with srcdoc in renderInIframe above.
          <iframe
            ref={iframeRef}
            className="w-full h-full border-0"
            sandbox="allow-scripts"
            title="Artifact Preview"
          />
        ) : (
          <pre className={cn("p-4 text-sm overflow-auto h-full font-mono", colors.textMain)}>
            {selectedArtifact?.code}
          </pre>
        )}
      </div>
    </motion.div>
  );
}
