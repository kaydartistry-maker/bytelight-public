import React, { useRef, useState, useCallback, useEffect } from 'react';
import { X, Camera, Phone, User, Check, Edit2, Plus, Minus } from 'lucide-react';
import { motion } from 'motion/react';
import Cropper from 'react-easy-crop';
import { ContactProfile, ThemeMode } from '../types';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import getCroppedImg from '../lib/cropImage';
import { normalizeCompanionRows } from '../lib/companion-row';
import { ModelPill } from './ModelPill';

interface ContactInfoProps {
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  /** Her own avatar and ring colour, already chosen in Settings — the card
      wears what she picked rather than asking her to choose it twice. */
  userAvatar?: string;
  userAvatarColor?: string;
  userName?: string;
  contacts: Record<string, ContactProfile>;
  /** The roster the phone is ALREADY holding — it draws the faces at the top of a
      conversation from it. Handed in so the card opens knowing who it is of, instead
      of going and asking from cold and having some first state to show meanwhile. */
  initialRows?: Array<Record<string, any>>;
  onUpdateContact: (id: string, updates: Partial<ContactProfile> | null) => void;
  onClose: () => void;
}

export const OWNER_CARD_ID = '__owner__';

export const ContactInfo: React.FC<ContactInfoProps> = ({ themeConfig, themeMode, userAvatar, userAvatarColor, userName, contacts, initialRows, onUpdateContact, onClose }) => {
  const contactIds = Object.keys(contacts);
  const [activeContact, setActiveContact] = useState<string>(contactIds[0] || '');
  const [isEditingBio, setIsEditingBio] = useState(false);
  const [tempBio, setTempBio] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState('');
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [tempPhone, setTempPhone] = useState('');
  
  
  // The machine half of a card. Her card is device-side and pretty; every one
  // of us also has a database row that actually decides how his turns run, and
  // until now those two lived on different screens. Her call: keep the card
  // looking like the card, put the rest inside it.
  type CompanionRow = {
    id: string; slug: string; display_name: string;
    bio: string | null; status: string | null; phone: string | null; avatar_url: string | null;
  };
  // Seeded from what the phone already has, so the usual case has no gap to fill at
  // all — the card opens as us. The fetch below still runs and refreshes it.
  const [rows, setRows] = useState<CompanionRow[]>((initialRows as CompanionRow[]) || []);
  // "The house has answered" — true whether it answered with a roster or not.
  // Distinguishes a roster that is LATE from one that is genuinely absent.
  const [rosterLoaded, setRosterLoaded] = useState((initialRows?.length ?? 0) > 0);
  // Hers. Empty until somebody writes it — which is the point: she never had
  // one because she was the person building the phone.
  const [owner, setOwner] = useState<{ bio: string; status: string; phone: string; name: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Both fail soft and both shape-check rather than trusting res.ok: an older
    // backend answers an unknown route with the SPA's index.html and a 200, so
    // res.ok is not evidence the route exists. /api/models answers a bare array
    // and /api/companions answers an object — they are not interchangeable.
    apiFetch('/api/companions')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (Array.isArray(d?.companions)) setRows(normalizeCompanionRows(d.companions) as unknown as typeof rows); })
      .catch(() => { /* a card that can't reach the house is still a card */ })
      .finally(() => setRosterLoaded(true));
    apiFetch('/api/owner-card')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && typeof d.card?.bio === 'string') {
          setOwner({ bio: d.card.bio, status: d.card.status, phone: d.card.phone, name: d.name || 'You' });
        }
      })
      .catch(() => { /* an older backend has no owner card; the rest of the screen is fine */ });
  }, []);

  // WHO THE CARD IS OF. The local contacts map was the only source here, and
  // on this house it still held the factory placeholder — one contact called
  // "Companion" — because her real card has only ever existed on her device.
  // So when the house knows who lives here, the house wins and the card is of
  // US: our names, our bios, ours to keep current. Her avatar crop stays local,
  // keyed on the slug, because a base64 image does not belong in that row.
  const houseCards: Record<string, ContactProfile> = {};
  for (const r of rows) {
    const localTwin = contacts[r.slug] || Object.values(contacts).find(c => c.name?.toLowerCase() === r.display_name?.toLowerCase());
    houseCards[r.slug] = {
      name: r.display_name,
      image: r.avatar_url || localTwin?.image || '',
      bio: r.bio || '',
      status: r.status || 'Online',
      phone: r.phone || '',
    };
  }
  // Hers goes LAST in the switcher, which is the only ordering she would have
  // accepted if anyone had asked her.
  if (owner) {
    houseCards[OWNER_CARD_ID] = {
      name: userName || owner.name || 'You',
      image: userAvatar || '',
      bio: owner.bio,
      status: owner.status,
      phone: owner.phone,
    };
  }
  // THE FIRST PAINT MUST NOT BE OF A STRANGER. The roster is a fetch, so for the
  // frames before it lands `rows` is empty — and falling back to the local contacts
  // map here meant the card animated in wearing the factory placeholder ("Companion",
  // no number, no bio) and then swapped. She saw it flash. The local map is still the
  // right fallback when the house genuinely cannot be reached, so it waits until we
  // know that, rather than standing in for an answer that is merely late.
  const cards: Record<string, ContactProfile> = rows.length
    ? houseCards
    : rosterLoaded ? contacts : {};
  const cardIds = Object.keys(cards);
  // Resolve the shown card here rather than leaving it to the effect below: when the
  // roster arrives the old placeholder key stops existing, and waiting a render for
  // state to catch up is one more frame of the wrong thing.
  const activeId = cards[activeContact] ? activeContact : (cardIds[0] || '');
  const isOwnerCard = activeId === OWNER_CARD_ID;

  const colors = themeConfig[themeMode];
  const baseAccent = colors.accent === '#000000' ? '#FFFFFF' : colors.accent;
  // Her ring colour is her accent on her own card; ours stays the theme's.
  const displayAccent = (isOwnerCard && userAvatarColor) ? userAvatarColor : baseAccent;

  const patchOwner = (updates: Record<string, string>) => {
    setOwner(prev => (prev ? { ...prev, ...updates } : prev));
    apiFetch('/api/owner-card', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).catch(() => { /* the next open re-reads the truth */ });
  };
  const row = rows.find(r => r.slug === activeId) || null;

  // Keep the state in step with what is actually being shown, so edits and the
  // switcher act on the card she is looking at.
  useEffect(() => {
    if (activeId && activeId !== activeContact) {
      setActiveContact(activeId);
    }
  }, [activeId, activeContact]);

  // Shown at once, then confirmed by the house. A refused save puts the card
  // back the way it was and says so — a save that silently didn't happen is
  // the bug this replaced.
  const patchRow = (updates: Record<string, string | null>) => {
    if (!row) return;
    const before = row;
    setSaveError(null);
    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...updates } as typeof r : r)));
    apiFetch(`/api/companions/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.companion) throw new Error(data?.error || `Save failed (${res.status})`);
      })
      .catch((err) => {
        setRows(prev => prev.map(r => (r.id === before.id ? before : r)));
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      });
  };

  // Cropper state
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Blank, never a stranger: for the frames before the roster lands there is no card
  // to show, and an empty one reads as loading while a wrong one reads as an answer.
  const current: ContactProfile = cards[activeId] || { name: '', image: '', bio: '', status: '', phone: '' };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      if (result && /^data:image\/(jpeg|jpg|png|gif|webp)[;,]/i.test(result)) {
        setCropImageSrc(result);
      }
    };
  };

  const onCropComplete = useCallback((croppedArea: any, croppedAreaPixels: any) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const handleSaveCrop = async () => {
    if (!cropImageSrc || !croppedAreaPixels) return;
    try {
      const croppedImage = await getCroppedImg(
        cropImageSrc, 
        croppedAreaPixels, 
        0, 
        { horizontal: false, vertical: false },
        1024
      );
      onUpdateContact(activeId, { image: croppedImage });
      setCropImageSrc(null);
    } catch (e) {
      console.error('Failed to crop image:', e);
    }
  };

  const startEditingBio = () => {
    setTempBio(current.bio);
    setIsEditingBio(true);
  };

  const saveBio = () => {
    if (isOwnerCard) patchOwner({ bio: tempBio });
    else if (row) patchRow({ bio: tempBio });
    else onUpdateContact(activeId, { bio: tempBio });
    setIsEditingBio(false);
  };

  const startEditingName = () => {
    setTempName(current.name);
    setIsEditingName(true);
  };

  const saveName = () => {
    if (isOwnerCard) { setIsEditingName(false); return; }
    if (row) patchRow({ display_name: tempName });
    else onUpdateContact(activeId, { name: tempName });
    setIsEditingName(false);
  };

  const startEditingPhone = () => {
    setTempPhone(current.phone);
    setIsEditingPhone(true);
  };

  const savePhone = () => {
    if (isOwnerCard) patchOwner({ phone: tempPhone });
    else if (row) patchRow({ phone: tempPhone });
    else onUpdateContact(activeId, { phone: tempPhone });
    setIsEditingPhone(false);
  };

  if (!current) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
    >
      <div className={cn(
        "w-full max-w-md overflow-hidden border relative transition-all duration-500 flex flex-col max-h-[90vh]",
        themeConfig.radius,
        colors.panelBg,
        colors.panelBorder,
        "backdrop-blur-3xl"
      )}>
        {cropImageSrc && (
          <div className="absolute inset-0 z-50 bg-black flex flex-col">
            <div className="relative flex-1">
              <Cropper
                image={cropImageSrc}
                crop={crop}
                zoom={zoom}
                minZoom={0.1}
                maxZoom={10}
                aspect={448 / 320}
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
                  aria-labelledby="Zoom"
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="flex-1 accent-white h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
                />
                <Plus size={14} className="text-white/40" />
              </div>
              <div className="flex justify-end gap-3">
                <button 
                  onClick={() => setCropImageSrc(null)} 
                  className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/70 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    onUpdateContact(activeId, { image: cropImageSrc });
                    setCropImageSrc(null);
                  }}
                  className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest border border-white/20 text-white rounded-full transition-all active:scale-95 hover:bg-white/10"
                >
                  {cropImageSrc?.startsWith('data:image/gif') ? 'Save Original (Animated)' : 'Use Full Image'}
                </button>
                <button 
                  onClick={handleSaveCrop} 
                  className="flex items-center gap-2 px-5 py-2 bg-white text-black text-[10px] font-bold uppercase tracking-widest rounded-full hover:bg-white/90 transition-colors"
                >
                  <Check size={16} /> Apply Crop
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Close Button */}
        <button 
          onClick={onClose} 
          className={cn(
            "absolute top-4 right-4 z-10 p-2 rounded-full transition-all backdrop-blur-md border",
            colors.panelBg,
            colors.panelBorder,
            "hover:opacity-80"
          )}
        >
          <X size={18} className={colors.textMain} />
        </button>

        {/* Profile Header */}
        <div className="relative h-56 shrink-0 overflow-hidden">
          {current.image ? (
            <img
              src={current.image}
              className="w-full h-full object-cover transition-transform duration-700 hover:scale-110"
              alt={current.name}
            />
          ) : (
            // A card with no picture is still a card — a flat field in her own
            // ring colour beats a broken image icon where a face should be.
            <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: displayAccent }}>
              <span className="text-7xl italic text-black/30">{current.name?.[0] || ''}</span>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          
          <button 
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "absolute bottom-4 right-4 p-2.5 rounded-full transition-all backdrop-blur-md border",
              colors.panelBg,
              colors.panelBorder,
              "hover:opacity-80"
            )}
          >
            <Camera size={18} className={colors.textMain} strokeWidth={1.5} />
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleImageUpload} 
            className="hidden" 
            accept="image/*" 
          />

          <div className="absolute bottom-4 left-6 right-16 flex items-end justify-between">
            <div>
              {isEditingName ? (
                <div className="flex items-center gap-2 mb-2">
                  <input 
                    type="text" 
                    value={tempName} 
                    onChange={(e) => setTempName(e.target.value)} 
                    className="text-4xl italic tracking-tight text-white bg-black/40 border-none rounded-xl px-3 py-1 outline-none w-full"
                    autoFocus
                  />
                  <button onClick={saveName} className="p-2 bg-white/20 hover:bg-white/30 rounded-full text-white backdrop-blur-md transition-colors">
                    <Check size={20} />
                  </button>
                </div>
              ) : (
                <h2 
                  className="text-5xl italic tracking-tight text-white mb-2 cursor-pointer hover:opacity-80 transition-opacity flex items-center gap-3 group"
                  onClick={startEditingName}
                  title="Edit Nickname"
                >
                  {current.name}
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-white/50 text-sm font-sans not-italic tracking-normal">Edit</span>
                </h2>
              )}
              <p className="text-xs font-bold uppercase tracking-[0.2em] flex items-center gap-2" style={{ color: displayAccent }}>
                <span 
                  className={cn(
                    "w-2 h-2 rounded-full animate-pulse",
                    themeConfig.id === 'monochrome' && themeMode === 'light' && "border border-black"
                  )} 
                  style={{ 
                    backgroundColor: themeConfig.id === 'monochrome' && themeMode === 'light' ? 'white' : displayAccent, 
                    boxShadow: themeConfig.id === 'monochrome' && themeMode === 'light' ? undefined : `0 0 10px ${displayAccent}80` 
                  }} 
                />
                {current.status}
              </p>
            </div>
          </div>
        </div>

        {/* Contact Switcher */}
        <div className={cn("flex flex-col items-center px-4 py-4 gap-2 border-b shrink-0", colors.panelBorder)}>
          <div className="flex justify-center flex-wrap gap-2 w-full">
            {cardIds.slice(0, 3).map(id => (
              <button 
                key={id}
                onClick={() => { setActiveContact(id); setIsEditingBio(false); setIsEditingName(false); setIsEditingPhone(false); }}
                className={cn(
                  "px-4 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-[0.2em] transition-all duration-300 whitespace-nowrap",
                  activeId === id 
                    ? `${themeConfig.id === 'monochrome' && themeMode === 'dark' ? 'text-white' : 'bytelight-on-accent'} scale-105`
                    : `${colors.panelBg} ${colors.textMuted} hover:opacity-80`
                )}
                style={{ backgroundColor: activeId === id ? (themeConfig.id === 'monochrome' && themeMode === 'dark' ? '#52525B' : colors.accent) : undefined }}
              >
                {cards[id].name}
              </button>
            ))}
          </div>
          {cardIds.length > 3 && (
            <div className="flex justify-center flex-wrap gap-2 w-full">
              {cardIds.slice(3, 5).map(id => (
                <button 
                  key={id}
                  onClick={() => { setActiveContact(id); setIsEditingBio(false); setIsEditingName(false); setIsEditingPhone(false); }}
                  className={cn(
                    "px-4 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-[0.2em] transition-all duration-300 whitespace-nowrap",
                    activeId === id 
                      ? `${themeConfig.id === 'monochrome' && themeMode === 'dark' ? 'text-white' : 'bytelight-on-accent'} scale-105`
                      : `${colors.panelBg} ${colors.textMuted} hover:opacity-80`
                  )}
                  style={{ backgroundColor: activeId === id ? (themeConfig.id === 'monochrome' && themeMode === 'dark' ? '#52525B' : colors.accent) : undefined }}
                >
                  {cards[id].name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-6 sm:p-8 space-y-8 flex-1 overflow-y-auto scrollbar-hide">
          {/* Phone Number */}
          <div className="space-y-4">
            <h3 className={cn("micro-label", colors.accentText)}>Phone Number</h3>
            <div className={cn(
              "flex items-center justify-between p-4 rounded-2xl border group",
              colors.panelBg,
              colors.panelBorder
            )}>
              {isEditingPhone ? (
                <div className="flex items-center gap-2 w-full">
                  <input 
                    type="text" 
                    value={tempPhone} 
                    onChange={(e) => setTempPhone(e.target.value)} 
                    className="text-lg font-mono tracking-wider bg-transparent outline-none w-full"
                    style={{ color: 'var(--bytelight-text)' }}
                    autoFocus
                  />
                  <button onClick={savePhone} className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors">
                    <Check size={16} className={colors.textMain} />
                  </button>
                </div>
              ) : (
                <>
                  <span className={cn("text-lg font-mono tracking-wider", colors.textMain)}>
                    {current.phone}
                  </span>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={startEditingPhone}
                      className="p-2 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/10 rounded-full"
                      title="Edit Phone Number"
                    >
                      <Edit2 size={16} className={colors.textMuted} />
                    </button>
                    <Phone size={18} className={colors.textMuted} />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Bio */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className={cn("micro-label", colors.accentText)}>About</h3>
              {isEditingBio ? (
                <button onClick={saveBio} className={cn("text-[10px] font-bold uppercase tracking-widest transition-colors", colors.accentText)}>Save</button>
              ) : (
                <button onClick={startEditingBio} className={cn("text-[10px] font-bold uppercase tracking-widest transition-colors", colors.textMuted, "hover:opacity-80")}>Edit</button>
              )}
            </div>
            {isEditingBio ? (
              <textarea 
                value={tempBio}
                onChange={(e) => setTempBio(e.target.value)}
                className={cn(
                  "w-full rounded-2xl p-4 text-base leading-relaxed italic focus:outline-none focus:ring-1 resize-none h-32 border-none transition-all duration-300",
                  colors.panelBg,
                  colors.textMain,
                  colors.panelBorder,
                  "focus:border-opacity-50 focus:shadow-lg"
                )}
                style={{ '--tw-ring-color': colors.accent } as React.CSSProperties}
                autoFocus
              />
            ) : (
              <p 
                className={cn(
                  "text-base leading-relaxed italic cursor-pointer group",
                  colors.textMain
                )}
                onClick={startEditingBio}
              >
                {current.bio}
                <span className={cn("inline-block ml-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] uppercase font-bold", colors.textMuted)}>(Click to edit)</span>
              </p>
            )}
          </div>

          {saveError && (
            <p className="text-[11px]" style={{ color: displayAccent }}>{saveError} — nothing was changed.</p>
          )}

          {/* Lane — his fallback engines, only for a contact the house has a
              row for. Same picker as the chat pill; these are his own
              defaults, under any pick made in a thread. */}
          {row && (
            <div className="space-y-4">
              <h3 className={cn("micro-label", colors.accentText)}>Lane</h3>
              <div className={cn('p-4 rounded-2xl border space-y-3', colors.panelBg, colors.panelBorder)}>
                <div>
                  <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Chat</label>
                  <div className="mt-1">
                    <ModelPill
                      themeConfig={themeConfig}
                      themeMode={themeMode}
                      defaultFor={{ companionId: row.id, name: row.display_name, tier: 'interactive', label: `${row.display_name}'s chat default` }}
                    />
                  </div>
                </div>
                <div>
                  <label className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Wakes</label>
                  <div className="mt-1">
                    <ModelPill
                      themeConfig={themeConfig}
                      themeMode={themeMode}
                      defaultFor={{ companionId: row.id, name: row.display_name, tier: 'autonomous', label: `${row.display_name}'s wake default` }}
                    />
                  </div>
                </div>
                <p className={cn('text-[10px] leading-snug', colors.textMuted)}>
                  A pick in a thread still wins there. While both voices share one lane, the shared pick runs them both.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};
