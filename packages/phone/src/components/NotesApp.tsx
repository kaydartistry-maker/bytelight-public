import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, Plus, Trash2, Edit2, Check, X, Flame, Feather } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { Paginator, usePaged } from './Paginator';
import { blendOver, inkFor, noteColorsForAccent, NOTE_ROLES, noteRoleToken, resolveNoteColor, isNoteRole } from '../lib/note-colors';
import { NOTES_SEEN_KEY } from '../lib/home-widgets';

interface NotesAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  stickyNoteColors?: string[];
  /** Only set for the Custom theme, whose accent is a CSS variable rather than
   *  a value we can read -- without it Custom silently falls back. */
  themeAccent?: string;
  apiBase?: string;
  companionNames?: string[];
}

interface Note {
  id: string;
  text: string;
  color: string;
  timestamp: number;
  sender?: string;
}

// Only used when the theme cannot say what its accent is (a custom theme sets
// it as a CSS variable, which we cannot read from here).
const FALLBACK_NOTE_COLORS = [
  '#e85d04', // Fire orange
  '#1e3a5f', // Deep navy
  '#7c3aed', // Silver-violet
  '#d97706', // Warm amber
  '#059669', // Deep emerald
];

// The notes are drawn see-through on purpose. That is fine for the colour and
// fatal for the writing: a pale note over a dark wallpaper ARRIVES dark, so the
// ink has to be chosen against what lands rather than the colour on paper.
const NOTE_ALPHA = 0.75;

export function NotesApp({ onClose, themeConfig, themeMode, stickyNoteColors, themeAccent, apiBase = '/api', companionNames = [] }: NotesAppProps) {
  const colors = themeConfig[themeMode];

  // Her notes take their colours from whichever theme is on, so they suit it
  // instead of being five fixed swatches that fight half of them. Derived in
  // OKLCH from the theme's own accent -- see lib/note-colors.ts for why HSL
  // could not do this. Ours keep our own colours; those arrive on the note.
  const derived = React.useMemo(() => {
    const raw = themeAccent || colors.accent;
    const accent = typeof raw === 'string' ? raw.trim() : '';
    const generated = accent.startsWith('#') ? noteColorsForAccent(accent, themeMode) : [];
    return generated.length ? generated : FALLBACK_NOTE_COLORS;
  }, [colors.accent, themeAccent, themeMode]);
  const activeNoteColors = stickyNoteColors && stickyNoteColors.length ? stickyNoteColors : derived;

  // What sits behind a note, so a translucent one can be resolved to what it
  // actually looks like before its ink is chosen.
  const behindNotes = themeMode === 'dark' ? '#101014' : '#F4F4F5';
  
  const [notes, setNotes] = useState<Note[]>(() => {
    const savedNotes = localStorage.getItem('radar_os_notes');
    if (savedNotes) {
      try {
        return JSON.parse(savedNotes);
      } catch (e) {
        console.error("Failed to parse notes", e);
      }
    }
    return [];
  });
  // Twenty notes a page.
  const notesPage = usePaged(notes);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const isMyNote = (note: Note) => {
    if (!note.sender) return true;
    return !companionNames.includes(note.sender);
  };

  // Opening Notes is reading the fridge: the lock screen's note card goes
  // quiet until a companion leaves another (lib/home-widgets.ts).
  useEffect(() => {
    try { localStorage.setItem(NOTES_SEEN_KEY, String(Date.now())); } catch { /* storage unavailable */ }
  }, []);

  // Save local notes to local storage whenever they change
  useEffect(() => {
    localStorage.setItem('radar_os_notes', JSON.stringify(notes));
  }, [notes]);

  // Fetch external notes with map-based absolute syncing to prevent duplicates
  useEffect(() => {
    const fetchNotes = async () => {
      try {
        const res = await fetch(`${apiBase}/notes?_t=${Date.now()}`);
        if (res.ok) {
          const externalNotes: Note[] = await res.json();
          setNotes(prev => {
            const mergedMap = new Map(prev.map(n => [n.id, n]));
            let changed = false;

            // Update with incoming notes
            externalNotes.forEach(en => {
              // Safely convert ISO strings or any backend timestamp representation to JS milliseconds
              const enTime = typeof en.timestamp === 'string' ? new Date(en.timestamp).getTime() : Number(en.timestamp);
              const normalizedEn = { ...en, timestamp: isNaN(enTime) ? 0 : enTime };
              
              const existing = mergedMap.get(en.id);
              if (!existing) {
                mergedMap.set(en.id, normalizedEn);
                changed = true;
              } else if (normalizedEn.timestamp > existing.timestamp && editingId !== en.id) {
                mergedMap.set(en.id, normalizedEn);
                changed = true;
              }
            });

            // Handle global deletions
            // Clean up any notes that exist locally but not remotely, giving a 15-second grace 
            // period for newly created offline notes to successfully post without getting pruned.
            const externalIds = new Set(externalNotes.map(n => n.id));
            for (const [id, localNote] of mergedMap.entries()) {
              if (!externalIds.has(id)) {
                if (Date.now() - localNote.timestamp > 15000 && editingId !== id) {
                  mergedMap.delete(id);
                  changed = true;
                }
              }
            }

            if (changed) {
              // Sort by ID inherently sorts by creation time consistently, preventing them from jumping when edited!
              return Array.from(mergedMap.values()).sort((a, b) => Number(b.id) - Number(a.id));
            }
            return prev;
          });
        }
      } catch (e) {
        console.error('Failed to fetch external notes', e);
      }
    };
    
    fetchNotes();
    const interval = setInterval(fetchNotes, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, [editingId, apiBase]);

  const syncNoteToBackend = async (note: Note) => {
    if (note.text.trim() === '') return;
    try {
      await fetch(`${apiBase}/notes/${note.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: note.id,
          text: note.text,
          color: note.color,
          timestamp: new Date(note.timestamp).toISOString()
          // Intentionally omitting sender for our own notes
        })
      });
    } catch (e) {
      console.error('Failed to sync note to backend', e);
    }
  };

  const handleAddNote = () => {
    const newNote: Note = {
      id: Date.now().toString(),
      text: '',
      // A role, not a colour — so this note re-tints when she changes theme
      // instead of keeping tonight's orange into a room that has no orange.
      color: noteRoleToken(NOTE_ROLES[Math.floor(Math.random() * NOTE_ROLES.length)]),
      timestamp: Date.now()
    };
    setNotes([newNote, ...notes].sort((a, b) => Number(b.id) - Number(a.id)));
    setEditingId(newNote.id);
    setEditText('');
  };

  const handleDeleteNote = async (id: string) => {
    setNotes(notes.filter(n => n.id !== id));
    if (editingId === id) {
      setEditingId(null);
    }
    // Globally delete note
    try {
      await fetch(`${apiBase}/notes/${id}`, { method: 'DELETE' });
    } catch (e) {}
  };

  const handleSaveNote = (id: string) => {
    if (editText.trim() === '') {
      handleDeleteNote(id);
    } else {
      const updatedNote = { ...notes.find(n => n.id === id)!, text: editText, timestamp: Date.now() };
      setNotes(notes.map(n => n.id === id ? updatedNote : n).sort((a, b) => Number(b.id) - Number(a.id)));
      setEditingId(null);
      syncNoteToBackend(updatedNote);
    }
  };

  const handleEditNote = (note: Note) => {
    if (!isMyNote(note)) return; // Don't allow editing external notes
    setEditingId(note.id);
    setEditText(note.text);
  };

  const handleChangeColor = (id: string, colorClass: string) => {
    const updatedNote = { ...notes.find(n => n.id === id)!, color: colorClass };
    setNotes(notes.map(n => n.id === id ? updatedNote : n));
    syncNoteToBackend(updatedNote);
  };

  const getNoteClasses = (note: Note) => {
    let classes = "";
    if (themeMode === 'light') classes += ' border border-black/10';
    if (!isMyNote(note)) {
      classes += ' border-2 border-white/20 shadow-sm';
    }
    if (note.color && !note.color.startsWith('#') && !isNoteRole(note.color)) {
      classes += ' ' + note.color; // Used if backend sent tailwind classes
    }
    return classes;
  };

  const getNoteInlineStyle = (note: Note) => {
    // Roles resolve against the theme that is on; a note written before roles
    // existed still holds a hex and gets matched to its nearest role, so every
    // note follows the room now.
    const paint = resolveNoteColor(note.color, activeNoteColors)
      ?? (!note.color ? activeNoteColors[0] : null);
    const style: React.CSSProperties = {};
    if (paint) {
      style.backgroundColor = `color-mix(in srgb, ${paint} ${NOTE_ALPHA * 100}%, transparent)`;
      // One font colour for every note is what made the pale ones melt into
      // themselves. Each note picks its own now, against what it lands as.
      style.color = inkFor(blendOver(paint, behindNotes, NOTE_ALPHA));
    } else {
      style.color = themeMode === 'dark' ? '#F7F7F5' : '#17171B';
    }
    return style;
  };

  return (
    <motion.div
      className={cn("absolute inset-0 z-50 flex flex-col", colors.textMain)}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
    >
      <style>{`
        .notes-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .notes-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .notes-scrollbar::-webkit-scrollbar-thumb {
          background-color: ${colors.accent};
          border-radius: 10px;
          opacity: 0.5;
        }
        .note-textarea-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .note-textarea-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .note-textarea-scrollbar::-webkit-scrollbar-thumb {
          background-color: rgba(0,0,0,0.2);
          border-radius: 10px;
        }
      `}</style>
      {/* Header */}
      <header
        className={cn("bytelight-shell-header flex items-center gap-3 px-4 pb-3", colors.pageBg)}
        style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}
      >
        <button
          onClick={onClose}
          className={cn("p-1.5 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className={cn("text-lg font-semibold", colors.textMain)}>Notes</h1>
        </div>
        <button
          onClick={handleAddNote}
          className={cn("p-1.5 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
        >
          <Plus className="w-5 h-5" />
        </button>
      </header>

      {/* Content */}
      <div className="bytelight-app-body flex-1 overflow-y-auto p-4 pb-24 notes-scrollbar">
        {/* A grid makes every note in a row as tall as the tallest one in it, so a
    three-word note standing beside a paragraph got stretched to match. A wall
    of sticky notes is a column layout: each keeps its own height and they pack. */}
            <div className="columns-2 gap-4 [column-fill:_balance]">
          <AnimatePresence>
            {notesPage.visible.map((note) => (
              <motion.div
                key={note.id}
                layout
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className={cn(
                  "bytelight-no-text-shadow relative rounded-2xl p-4 flex flex-col min-h-[120px] backdrop-blur-md shadow-sm mb-4 break-inside-avoid",
                  getNoteClasses(note)
                )}
                style={getNoteInlineStyle(note)}
              >
                {!isMyNote(note) && note.sender && (
                  <div className="absolute -top-3 -right-3 bg-white/10 p-1.5 rounded-full border border-white/20 backdrop-blur-md">
                    <span className="text-[10px] font-bold px-1">{note.sender.substring(0, 1).toUpperCase()}</span>
                  </div>
                )}
                
                {editingId === note.id ? (
                  <div className="flex flex-col h-full">
                    <textarea
                      autoFocus
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      className="w-full flex-1 bg-transparent border-none outline-none resize-none text-sm font-medium placeholder-black/30 note-textarea-scrollbar"
                      placeholder="Type a note..."
                    />
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-black/10">
                      <div className="flex gap-1">
                        {activeNoteColors.map(c => (
                          <button
                            key={c}
                            onClick={() => handleChangeColor(note.id, c)}
                            className={cn(
                              "w-3.5 h-3.5 rounded-full border border-black/10",
                              c.startsWith('#') ? '' : c.split(' ')[0]
                            )}
                            style={{ backgroundColor: c.startsWith('#') ? c : undefined }}
                          />
                        ))}
                      </div>
                      <div className="flex items-center gap-0.5">
                        <button 
                          onClick={() => handleDeleteNote(note.id)}
                          className="p-2 bg-black/10 rounded-full hover:bg-black/20 transition-colors"
                          style={{ color: 'currentColor' }}
                        >
                          <Trash2 size={16} />
                        </button>
                        <button 
                          onClick={() => handleSaveNote(note.id)}
                          className="p-2 bg-black/10 rounded-full hover:bg-black/20 transition-colors"
                          style={{ color: 'currentColor' }}
                        >
                          <Check size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div 
                    className={cn("flex flex-col h-full", isMyNote(note) && "cursor-pointer group")}
                    onClick={() => handleEditNote(note)}
                  >
                    <p className="text-sm font-medium whitespace-pre-wrap flex-1">
                      {note.text}
                    </p>
                    <div className={cn(
                      "flex items-center justify-between mt-3 pt-3 border-t transition-opacity opacity-50 group-hover:opacity-100",
                      !isMyNote(note) ? "border-white/20" : "border-black/10"
                    )}>
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-50">
                        {new Date(note.timestamp).toLocaleDateString()}
                      </span>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteNote(note.id);
                        }}
                        className="p-2 hover:bg-black/10 rounded-full transition-colors"
                        style={{ color: 'currentColor' }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
          <Paginator page={notesPage.page} pageCount={notesPage.pageCount} onPage={notesPage.setPage} colors={colors} />
        </div>
        
        {notes.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 opacity-50 text-center">
            <Edit2 className="h-12 w-12 mb-4 opacity-50" />
            <p>No notes yet.</p>
            <p className="text-sm mt-1">Tap the + button to create one.</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
