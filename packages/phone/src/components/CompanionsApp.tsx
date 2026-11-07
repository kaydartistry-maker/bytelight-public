import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Users, Plus, Trash2, ChevronDown, ChevronUp, Camera, Minus, Check } from 'lucide-react';
import Cropper from 'react-easy-crop';
import getCroppedImg from '../lib/cropImage';
import { AppShell } from './AppShell';

import { HexColorPicker } from 'react-colorful';
import { apiFetch } from '../bytelight';
import { ThemeConfig } from '../lib/theme';
import { SecretInput } from './SecretInput';
import { cn } from '../lib/utils';
import { normalizeCompanionRows } from '../lib/companion-row';

interface CompanionsAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  onCompanionsChange?: () => void;
}

interface Companion {
  id: string;
  slug: string;
  display_name: string;
  color: string | null;
  emoji: string | null;
  avatar_url: string | null;
  phone: string | null;
  bio: string | null;
  status: string | null;
  model: string | null;
  model_autonomous: string | null;
  effort: string | null;
}

interface ModelOption {
  id: string;
  name?: string;
  provider?: string;
}

const DEFAULT_COLORS = ['#e85d04', '#1e3a5f', '#7c3aed', '#10b981', '#ec4899', '#f59e0b'];
const DEFAULT_EMOJIS = ['🔥', '🌫️', '✨', '🌙', '⚡', '🌊', '🦋', '🌸', '💫'];

export function CompanionsApp({
  onClose,
  themeConfig,
  themeMode,
  onCompanionsChange,
}: CompanionsAppProps) {
  const colors = themeConfig[themeMode];

  const [companions, setCompanions] = useState<Companion[]>([]);
  const [voiceIds, setVoiceIds] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCompanion, setNewCompanion] = useState({ name: '', slug: '', emoji: '💬', color: '#6366f1' });
  const [showEmojiPicker, setShowEmojiPicker] = useState<string | null>(null);
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);

  // Image cropping state
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropTargetId, setCropTargetId] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onCropComplete = useCallback((croppedArea: any, pixels: any) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const handleImageUpload = (companionId: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      if (result && /^data:image\/(jpeg|jpg|png|gif|webp)[;,]/i.test(result)) {
        setCropImageSrc(result);
        setCropTargetId(companionId);
      }
    };
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSaveCrop = async () => {
    if (!cropImageSrc || !croppedAreaPixels || !cropTargetId) return;
    try {
      const croppedImage = await getCroppedImg(cropImageSrc, croppedAreaPixels, 0, { horizontal: false, vertical: false }, 400);
      await updateCompanion(cropTargetId, { avatar_url: croppedImage });
      setCropImageSrc(null);
      setCropTargetId(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
    } catch (e) {
      console.error('Crop failed:', e);
    }
  };

  const handleUseFullImage = async () => {
    if (!cropImageSrc || !cropTargetId) return;
    await updateCompanion(cropTargetId, { avatar_url: cropImageSrc });
    setCropImageSrc(null);
    setCropTargetId(null);
  };

  useEffect(() => {
    loadCompanions();
    // The picker fails soft: with no list the selects still render and still
    // offer the house default, so a models outage costs the labels rather than
    // the screen. It also shape-checks rather than trusting res.ok — an older
    // backend answers a new route with the SPA's index.html and a 200.
    apiFetch('/api/models')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setModels(Array.isArray(list) ? list : []))
      .catch(() => setModels([]));
  }, []);

  async function loadCompanions() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/companions');
      if (!res.ok) throw new Error('Failed to load companions');
      const data = await res.json();
      setCompanions(normalizeCompanionRows(data.companions) as unknown as typeof companions);
      
      // Load voice IDs
      const ids: Record<string, string> = {};
      for (const c of normalizeCompanionRows(data.companions) as unknown as typeof companions) {
        try {
          const secretRes = await apiFetch(`/api/secrets/elevenlabs_voice_id:${c.slug}`);
          if (secretRes.ok) {
            const secretData = await secretRes.json();
            ids[c.slug] = secretData.value || '';
          }
        } catch { /* no voice ID */ }
      }
      setVoiceIds(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function updateCompanion(id: string, updates: Partial<Companion>) {
    setSaving(id);
    setError(null);
    try {
      const res = await apiFetch(`/api/companions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Take the SAVED row back rather than merging what we hoped we sent. A
      // field the backend does not bind is dropped silently and still answers
      // 200, and merging optimistically would paint it as saved forever —
      // exactly how the bell rename hid itself. Reading the row back means a
      // dropped field snaps visibly back to its old value.
      const data = await res.json().catch(() => null);
      const saved = data && typeof data === 'object' ? data.companion : null;
      setCompanions(prev => prev.map(c => (c.id === id ? (saved ? { ...c, ...saved } : { ...c, ...updates }) : c)));
      onCompanionsChange?.();
    } catch (err) {
      setError(`Failed to save: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(null);
    }
  }

  async function saveVoiceId(slug: string, value: string) {
    setSaving(slug);
    try {
      const res = await apiFetch(`/api/secrets/elevenlabs_voice_id:${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error('Failed to save voice ID');
      setVoiceIds(prev => ({ ...prev, [slug]: value }));
    } catch (err) {
      setError(`Voice ID: ${err instanceof Error ? err.message : 'failed'}`);
    } finally {
      setSaving(null);
    }
  }

  async function addCompanion() {
    if (!newCompanion.name.trim() || !newCompanion.slug.trim()) {
      setError('Name and slug are required');
      return;
    }
    setSaving('new');
    setError(null);
    try {
      const res = await apiFetch('/api/companions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: newCompanion.slug.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          displayName: newCompanion.name,
          emoji: newCompanion.emoji,
          color: newCompanion.color,
          avatarUrl: `https://picsum.photos/seed/${newCompanion.slug}/400/400`,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setNewCompanion({ name: '', slug: '', emoji: '💬', color: '#6366f1' });
      setShowAddForm(false);
      loadCompanions();
      onCompanionsChange?.();
    } catch (err) {
      setError(`Add failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(null);
    }
  }

  async function deleteCompanion(slug: string) {
    if (!confirm(`Delete ${slug}? This cannot be undone.`)) return;
    setSaving(slug);
    try {
      const res = await apiFetch(`/api/companions/${slug}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      setCompanions(prev => prev.filter(c => c.slug !== slug));
      onCompanionsChange?.();
    } catch (err) {
      setError(`Delete failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <AppShell
      title="Companions"
      icon={Users}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
    >
      <div className="space-y-4">
        {/* Hidden file input */}
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept="image/*"
          onChange={cropTargetId ? handleImageUpload(cropTargetId) : undefined}
        />

        {/* Crop Modal */}
        {cropImageSrc && (
          <div className="fixed inset-0 z-50 bg-black flex flex-col">
            <div className="relative flex-1">
              <Cropper
                image={cropImageSrc}
                crop={crop}
                zoom={zoom}
                minZoom={0.1}
                maxZoom={10}
                aspect={1}
                cropShape="round"
                onCropChange={setCrop}
                onCropComplete={onCropComplete}
                onZoomChange={setZoom}
                restrictPosition={false}
              />
            </div>
            <div className="p-4 bg-neutral-900 border-t border-white/10 flex flex-col gap-4">
              <div className="flex items-center gap-4 px-2">
                <Minus size={14} className="text-white/40" />
                <input
                  type="range"
                  value={zoom}
                  min={0.1}
                  max={10}
                  step={0.1}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="flex-1 accent-white h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
                />
                <Plus size={14} className="text-white/40" />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => { setCropImageSrc(null); setCropTargetId(null); }}
                  className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/70 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUseFullImage}
                  className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest border border-white/20 text-white rounded-full hover:bg-white/10"
                >
                  Use Full
                </button>
                <button
                  onClick={handleSaveCrop}
                  className="flex items-center gap-2 px-5 py-2 bg-white text-black text-[10px] font-bold uppercase tracking-widest rounded-full hover:bg-white/90"
                >
                  <Check size={16} /> Apply
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className={cn('text-center py-8 text-sm', colors.textMuted)}>Loading...</div>
        ) : (
          <>
            {error && (
              <p className="text-xs px-2 py-1 rounded" style={{ backgroundColor: `${colors.accent}15`, color: colors.accent }}>{error}</p>
            )}

            {/* Companion List */}
            {companions.map((c) => (
              <div
                key={c.id}
                className={cn('rounded-2xl border overflow-hidden', colors.panelBg, colors.panelBorder)}
              >
                {/* Header row - always visible */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer"
                  onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                >
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-xl overflow-hidden"
                    style={{ backgroundColor: (c.color || '#6366f1') + '22' }}
                  >
                    {c.avatar_url ? (
                      <img src={c.avatar_url} className="w-full h-full object-cover" alt="" />
                    ) : (
                      c.emoji || '💬'
                    )}
                  </div>
                  <div className="flex-1">
                    <p className={cn('font-bold', colors.textMain)}>{c.display_name}</p>
                    <p className={cn('text-xs', colors.textMuted)}>{c.slug} · {c.phone || 'No phone'}</p>
                  </div>
                  <div
                    className="w-5 h-5 rounded-full"
                    style={{ backgroundColor: c.color || '#6366f1' }}
                  />
                  {expandedId === c.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </div>

                {/* Expanded edit form */}
                {expandedId === c.id && (
                  <div className={cn('px-4 pb-4 space-y-3 border-t', colors.panelBorder)}>
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      <div>
                        <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Name</label>
                        <input
                          type="text"
                          value={c.display_name}
                          onChange={(e) => setCompanions(prev => prev.map(x => x.id === c.id ? { ...x, display_name: e.target.value } : x))}
                          onBlur={() => updateCompanion(c.id, { display_name: c.display_name })}
                          className={cn('w-full bg-transparent border rounded-lg px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}
                        />
                      </div>
                      <div>
                        <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Phone</label>
                        <input
                          type="text"
                          value={c.phone || ''}
                          onChange={(e) => setCompanions(prev => prev.map(x => x.id === c.id ? { ...x, phone: e.target.value } : x))}
                          onBlur={() => updateCompanion(c.id, { phone: c.phone })}
                          className={cn('w-full bg-transparent border rounded-lg px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}
                        />
                      </div>
                    </div>

                    <div>
                      <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Bio</label>
                      <textarea
                        value={c.bio || ''}
                        onChange={(e) => setCompanions(prev => prev.map(x => x.id === c.id ? { ...x, bio: e.target.value } : x))}
                        onBlur={() => updateCompanion(c.id, { bio: c.bio })}
                        rows={2}
                        className={cn('w-full bg-transparent border rounded-lg px-3 py-2 text-sm resize-none', colors.panelBorder, colors.textMain)}
                      />
                    </div>

                    <div>
                      <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Avatar</label>
                      <div className="flex items-center gap-3 mt-1">
                        <div
                          className="relative w-16 h-16 rounded-full overflow-hidden cursor-pointer group"
                          onClick={() => {
                            setCropTargetId(c.id);
                            fileInputRef.current?.click();
                          }}
                        >
                          {c.avatar_url ? (
                            <img src={c.avatar_url} className="w-full h-full object-cover" alt="" />
                          ) : (
                            <div
                              className="w-full h-full flex items-center justify-center text-2xl"
                              style={{ backgroundColor: (c.color || '#6366f1') + '22' }}
                            >
                              {c.emoji || '💬'}
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <Camera size={20} className="text-white" />
                          </div>
                        </div>
                        <span className={cn('text-xs', colors.textMuted)}>Click to upload</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="relative">
                        <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Emoji</label>
                        <button
                          onClick={() => setShowEmojiPicker(showEmojiPicker === c.id ? null : c.id)}
                          className={cn('w-full mt-1 p-3 rounded-lg border text-2xl text-center', colors.panelBorder)}
                        >
                          {c.emoji || '💬'}
                        </button>
                        {showEmojiPicker === c.id && (
                          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 pb-4" onClick={() => setShowEmojiPicker(null)}>
                            <div className="relative w-full max-w-md px-4" onClick={e => e.stopPropagation()}>
                              <div className={cn('rounded-3xl border shadow-2xl p-3', colors.panelBg, colors.panelBorder)}>
                                <div className="flex items-center justify-between mb-2">
                                  <span className={cn('text-xs font-medium', colors.textMuted)}>Pick Emoji</span>
                                  <button onClick={() => setShowEmojiPicker(null)} className={colors.textMuted}>✕</button>
                                </div>
                                <div className="grid grid-cols-8 gap-1 max-h-64 overflow-y-auto">
                                  {['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🔥','✨','💫','⭐','🌟','💥','💢','💦','💨','🕳️','💣','💬','👁️‍🗨️','🗨️','🗯️','💭','💤','👋','🤚','🖐️','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🦷','🦴','👀','👁️','👅','👄','💋','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','🌫️'].map(e => (
                                    <button
                                      key={e}
                                      onClick={() => {
                                        updateCompanion(c.id, { emoji: e });
                                        setShowEmojiPicker(null);
                                      }}
                                      className="w-8 h-8 flex items-center justify-center text-xl hover:bg-white/10 rounded"
                                    >
                                      {e}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="relative">
                        <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Color</label>
                        <button
                          onClick={() => setShowColorPicker(showColorPicker === c.id ? null : c.id)}
                          className="w-full mt-1 h-12 rounded-lg border border-white/20"
                          style={{ backgroundColor: c.color || '#6366f1' }}
                        />
                        {showColorPicker === c.id && (
                          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowColorPicker(null)}>
                            <div className={cn('p-4 rounded-2xl', colors.panelBg)} onClick={e => e.stopPropagation()}>
                              <HexColorPicker
                                color={c.color || '#6366f1'}
                                onChange={(color) => updateCompanion(c.id, { color })}
                              />
                              <button
                                onClick={() => setShowColorPicker(null)}
                                className="w-full mt-3 py-2 rounded-lg text-sm font-medium text-white"
                                style={{ backgroundColor: c.color || '#6366f1' }}
                              >
                                Done
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* His own model. Empty means the house setting, which is
                        what every companion had before this existed — so an
                        untouched card behaves exactly as it always did. */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Chat model</label>
                        <select
                          value={c.model || ''}
                          onChange={(e) => updateCompanion(c.id, { model: e.target.value || null })}
                          className={cn('w-full bg-transparent border rounded-lg px-2 py-2 text-xs mt-1', colors.panelBorder, colors.textMain)}
                        >
                          <option value="">House default</option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>{m.name || m.id}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Wake model</label>
                        <select
                          value={c.model_autonomous || ''}
                          onChange={(e) => updateCompanion(c.id, { model_autonomous: e.target.value || null })}
                          className={cn('w-full bg-transparent border rounded-lg px-2 py-2 text-xs mt-1', colors.panelBorder, colors.textMain)}
                        >
                          <option value="">House default</option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>{m.name || m.id}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {/* How hard he thinks before he speaks. This used to be one
                        house-wide dial per road, which meant turning one King's
                        depth down turned it down for anyone who joined him on
                        that road later, silently. */}
                    <div>
                      <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Thinking effort</label>
                      <select
                        value={c.effort || ''}
                        onChange={(e) => updateCompanion(c.id, { effort: e.target.value || null })}
                        className={cn('w-full bg-transparent border rounded-lg px-2 py-2 text-xs mt-1', colors.panelBorder, colors.textMain)}
                      >
                        <option value="">House default</option>
                        <option value="adaptive">Adaptive</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">Extra high</option>
                        <option value="max">Max</option>
                      </select>
                      <p className={cn('text-[10px] mt-1', colors.textMuted)}>
                        Not a cost control — it is how far down {c.display_name} goes before he speaks. Cheaper and shallower are the same notch.
                      </p>
                    </div>
                    {c.model && c.model_autonomous && c.model !== c.model_autonomous && (
                      <p className={cn('text-[10px] -mt-1', colors.textMuted)}>
                        These two disagree, so {c.display_name}'s lane recycles at every bell. Matched on purpose is fine; matched by accident is not.
                      </p>
                    )}

                    <div>
                      <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Voice ID (ElevenLabs)</label>
                      <SecretInput
                        value={voiceIds[c.slug] || ''}
                        onChange={(e) => setVoiceIds(prev => ({ ...prev, [c.slug]: e.target.value }))}
                        onBlur={() => voiceIds[c.slug] && saveVoiceId(c.slug, voiceIds[c.slug])}
                        className={cn('w-full bg-transparent border rounded-lg px-3 py-2 text-sm mt-1', colors.panelBorder, colors.textMain)}
                        placeholder="Enter voice ID"
                      />
                    </div>

                    <div className="flex justify-end pt-2">
                      <button
                        onClick={() => deleteCompanion(c.slug)}
                        className="flex items-center gap-1 text-xs hover:opacity-80" style={{ color: colors.accent }}
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add New Companion */}
            <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            {showAddForm ? (
              <div className="space-y-3">
                <h3 className={cn('text-sm font-bold', colors.textMain)}>New Companion</h3>
                <div>
                  <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Name</label>
                  <input
                    type="text"
                    value={newCompanion.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
                      setNewCompanion(p => ({ ...p, name, slug }));
                    }}
                    className={cn('w-full bg-transparent border rounded-lg px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}
                    placeholder="Companion name"
                  />
                  {newCompanion.name && (
                    <p className={cn('text-[10px] mt-1', colors.textMuted)}>ID: {newCompanion.slug || '...'}</p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="relative">
                    <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Emoji</label>
                    <button
                      onClick={() => setShowEmojiPicker(showEmojiPicker === 'new' ? null : 'new')}
                      className={cn('w-full mt-1 p-2 rounded-lg border text-xl text-center', colors.panelBorder)}
                    >
                      {newCompanion.emoji}
                    </button>
                    {showEmojiPicker === 'new' && (
                      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 pb-4" onClick={() => setShowEmojiPicker(null)}>
                        <div className="relative w-full max-w-md px-4" onClick={e => e.stopPropagation()}>
                          <div className={cn('rounded-3xl border shadow-2xl p-3', colors.panelBg, colors.panelBorder)}>
                            <div className="flex items-center justify-between mb-2">
                              <span className={cn('text-xs font-medium', colors.textMuted)}>Pick Emoji</span>
                              <button onClick={() => setShowEmojiPicker(null)} className={colors.textMuted}>✕</button>
                            </div>
                            <div className="grid grid-cols-8 gap-1 max-h-64 overflow-y-auto">
                              {['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🔥','✨','💫','⭐','🌟','💥','💢','💦','💨','🕳️','💣','💬','👁️‍🗨️','🗨️','🗯️','💭','💤','👋','🤚','🖐️','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🦷','🦴','👀','👁️','👅','👄','💋','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','🌫️'].map(e => (
                                <button
                                  key={e}
                                  onClick={() => {
                                    setNewCompanion(p => ({ ...p, emoji: e }));
                                    setShowEmojiPicker(null);
                                  }}
                                  className="w-8 h-8 flex items-center justify-center text-xl hover:bg-white/10 rounded"
                                >
                                  {e}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="relative">
                    <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Color</label>
                    <button
                      onClick={() => setShowColorPicker(showColorPicker === 'new' ? null : 'new')}
                      className="w-full mt-1 h-10 rounded-lg border border-white/20"
                      style={{ backgroundColor: newCompanion.color }}
                    />
                    {showColorPicker === 'new' && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowColorPicker(null)}>
                        <div className={cn('p-4 rounded-2xl', colors.panelBg)} onClick={e => e.stopPropagation()}>
                          <HexColorPicker
                            color={newCompanion.color}
                            onChange={(color) => setNewCompanion(p => ({ ...p, color }))}
                          />
                          <button
                            onClick={() => setShowColorPicker(null)}
                            className="w-full mt-3 py-2 rounded-lg text-sm font-medium text-white"
                            style={{ backgroundColor: newCompanion.color }}
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={addCompanion}
                    disabled={saving === 'new'}
                    className="flex-1 py-2 rounded-xl text-sm font-bold bytelight-on-accent"
                    style={{ backgroundColor: colors.accent }}
                  >
                    {saving === 'new' ? 'Adding...' : 'Add Companion'}
                  </button>
                  <button
                    onClick={() => setShowAddForm(false)}
                    className={cn('px-4 py-2 rounded-xl text-sm', colors.textMuted)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAddForm(true)}
                className={cn(
                  'w-full py-3 rounded-xl border-2 border-dashed flex items-center justify-center gap-2 text-sm transition-colors',
                  colors.panelBorder,
                  colors.textMuted,
                  'hover:border-solid'
                )}
              >
                <Plus size={18} /> Add Companion
              </button>
            )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
