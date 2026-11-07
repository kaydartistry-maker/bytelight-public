import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Loader2, Film } from 'lucide-react';
import { motion } from 'motion/react';
import { ThemeConfig } from '../lib/theme';
import { ThemeMode } from '../types';
import { cn } from '../lib/utils';

interface GifPickerProps {
  onSelect: (url: string) => void;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  apiKey?: string;
}

const FALLBACK_GIFS = [
  { id: 'f1', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKMGpxxfG1D7J04/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKMGpxxfG1D7J04/giphy.gif' },
  { id: 'f2', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlO3BJ8LALPW4sE/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlO3BJ8LALPW4sE/giphy.gif' },
  { id: 'f3', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKVUn7iM8FMEU24/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKVUn7iM8FMEU24/giphy.gif' },
  { id: 'f4', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlR3k7cn46BBUXm/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlR3k7cn46BBUXm/giphy.gif' },
  { id: 'f5', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKDkDbIDJieKbVm/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKDkDbIDJieKbVm/giphy.gif' },
  { id: 'f6', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlO4f8i54X6Yv8Q/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlO4f8i54X6Yv8Q/giphy.gif' },
  { id: 'f7', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKSjRrfIPjeiVyM/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKSjRrfIPjeiVyM/giphy.gif' },
  { id: 'f8', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlCqV35hdEg2GUo/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlCqV35hdEg2GUo/giphy.gif' },
  { id: 'f9', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKsQ8gq8CPZTw0U/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKsQ8gq8CPZTw0U/giphy.gif' },
  { id: 'f10', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlBwsIWjIgEQZXq/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlBwsIWjIgEQZXq/giphy.gif' },
  { id: 'f11', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKUslwxnKVDd6hq/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKUslwxnKVDd6hq/giphy.gif' },
  { id: 'f12', url: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlIGW22k7o8mZfW/giphy.gif', thumb: 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJ6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6eXp6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/l0HlIGW22k7o8mZfW/giphy.gif' },
];

export function GifPicker({ onSelect, onClose, themeConfig, themeMode, apiKey: propApiKey }: GifPickerProps) {
  const [search, setSearch] = useState('');
  const [gifs, setGifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const colors = themeConfig[themeMode];
  const LIMIT = 20;

  const fetchGifs = async (query: string = '', currentOffset: number = 0) => {
    if (currentOffset === 0) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    setUsingFallback(false);
    try {
      // Use prop API key, then environment variable, then hardcoded fallback
      const apiKey = propApiKey || import.meta.env.VITE_GIPHY_API_KEY; 
      if (!apiKey) {
        throw new Error('Giphy API key is missing. Please set it in Settings > Data.');
      }
      const endpoint = query 
        ? `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${LIMIT}&offset=${currentOffset}&rating=g`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${LIMIT}&offset=${currentOffset}&rating=g`;
      
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }
      const data = await response.json();
      
      const newGifs = data.data || [];
      if (currentOffset === 0) {
        setGifs(newGifs);
      } else {
        setGifs(prev => [...prev, ...newGifs]);
      }
      
      setHasMore(newGifs.length === LIMIT);
      setOffset(currentOffset + LIMIT);
    } catch (err) {
      // Only log if it's not a 401 (which we handle with fallback)
      if (!(err instanceof Error && err.message.includes('401'))) {
        console.error('[GifPicker] Error:', err);
      }
      
      // Automatically switch to fallback on error
      if (currentOffset === 0) {
        setGifs(FALLBACK_GIFS.map(g => ({
          id: g.id,
          title: 'Fallback GIF',
          images: {
            fixed_height: { url: g.url },
            fixed_height_small: { url: g.thumb }
          }
        })));
        setHasMore(false);
      }
      setUsingFallback(true);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchGifs('', 0);
  }, []);

  // Debounced auto-search as user types
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchGifs(search, 0);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchGifs(search, 0);
  };

  const loadMore = () => {
    if (!loadingMore && hasMore && !usingFallback) {
      fetchGifs(search, offset);
    }
  };

  const handleSelect = (gif: any) => {
    // Use the i.giphy.com format which is more permissive for cross-domain usage
    const gifId = gif.id;
    const directUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
    onSelect(directUrl);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <motion.div
        key="gif-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[90] bg-black/60"
        onClick={onClose}
      />
      <motion.div
        key="gif-sheet"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[91] border-t rounded-t-3xl overflow-hidden flex flex-col",
          colors.panelBg,
          colors.panelBorder
        )}
        style={{ maxHeight: '70vh' }}
      >
      {/* Same header as Stickers and Emojis: accent icon, uppercase label, small X,
          and NO rule underneath. This one carried a border-b that neither of the
          others had, which is the only thing separating the three trays visually. */}
      <div className="p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film size={16} style={{ color: colors.accent }} />
          <h3 className={cn("text-xs font-bold uppercase tracking-widest", colors.accentText)}>GIFs</h3>
        </div>
        <button onClick={onClose} className={cn("p-1.5 rounded-full transition-colors opacity-60 hover:opacity-100", colors.textMuted, "hover:bg-black/5 dark:hover:bg-white/5")}>
          <X size={14} />
        </button>
      </div>

      <form onSubmit={handleSearch} className="p-3">
        <div className="relative">
          <Search className={cn("absolute left-3 top-1/2 -translate-y-1/2", colors.textMuted)} size={16} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Giphy..."
            className={cn(
              "w-full rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-1 transition-all",
              themeMode === 'dark' ? 'bg-black/20' : 'bg-black/5',
              colors.textMain
            )}
            style={{ '--tw-ring-color': colors.accent } as React.CSSProperties}
          />
        </div>
      </form>

      <div className="flex-1 overflow-y-auto p-3 scrollbar-hide">
        {loading ? (
          <div className="py-10 flex justify-center">
            <Loader2 className="animate-spin" style={{ color: colors.accent }} size={24} />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2 px-1">
              <span className={cn("text-[10px] font-bold uppercase tracking-wider", colors.textMuted)}>
                {search ? 'Search Results' : 'Trending Now'}
              </span>
              {usingFallback && (
                <span className={cn("text-[9px] font-medium", colors.accentText)}>Limited Mode</span>
              )}
            </div>

            {usingFallback && (
              <div 
                className="mb-3 px-2 py-1.5 border rounded-lg text-[10px] text-center leading-tight"
                style={{ 
                  backgroundColor: `${colors.accent}1A`, 
                  borderColor: `${colors.accent}33`,
                  color: colors.accent 
                }}
              >
                Public search is currently limited. Add your own Giphy API Key in Settings for full access.
              </div>
            )}

            {gifs.length === 0 ? (
              <div className={cn("py-10 text-center text-xs", colors.textMuted)}>
                No GIFs found
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {gifs.map((gif, index) => (
                    <button
                      key={`${gif.id}-${index}`}
                      onClick={() => handleSelect(gif)}
                      className={cn(
                        "relative aspect-square rounded-lg overflow-hidden hover:ring-2 transition-all group",
                        themeMode === 'dark' ? 'bg-black/20' : 'bg-black/5'
                      )}
                      style={{ '--tw-ring-color': colors.accent } as React.CSSProperties}
                    >
                      <img
                        src={gif.images.fixed_height_small.url}
                        alt={gif.title}
                        className="w-full h-full object-cover transition-transform group-hover:scale-110"
                        referrerPolicy="no-referrer"
                      />
                    </button>
                  ))}
                </div>
                
                {hasMore && !usingFallback && (
                  <div className="mt-4 mb-2 flex justify-center">
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      className={cn(
                        "px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2 transition-all",
                        themeMode === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-black/5 hover:bg-black/10 text-black'
                      )}
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Loading...
                        </>
                      ) : (
                        'Load More'
                      )}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      
        <div className={cn("p-2 text-[10px] text-center", themeMode === 'dark' ? 'bg-black/40' : 'bg-black/5', colors.textMuted)}>
          Powered by GIPHY
        </div>
      </motion.div>
    </>,
    document.body
  );
}
