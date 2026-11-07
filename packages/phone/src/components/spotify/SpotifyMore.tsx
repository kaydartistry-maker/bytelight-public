// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house: the player's extras, a song's sheet, the device sheet
// and the name sheet (Oct 23 2026; so nothing sends the owner out to the Spotify app). Like SpotifyViews.tsx, nothing in here fetches; every
// press is a callback SpotifyApp.tsx sends and then reads again after.
//
// Same look as the rest of the app: solid panels in the theme's colors, no
// blur, the theme's selected fill on what is on, and every press a thumb wide.

import React, { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Heart,
  ListPlus,
  Loader2,
  MonitorSpeaker,
  Plus,
  Repeat,
  Repeat1,
  Shuffle,
  Smartphone,
  Speaker,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST,
  SPOTIFY_PLAYLIST_NAME_LONGEST,
  type SpotifyDevicesView,
  type SpotifyPlayerView,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from '@bytelight/shared';
import type { ThemeColors } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { useBackHandler } from '../../lib/use-back-handler';
import { troubleLine, type SpotifyRead, type SpotifyTrouble } from '../../lib/spotify';
import { clockOf, moveTargets, nextRepeat, positionNow } from '../../lib/spotify-more';
import { Cover, HAIRLINE, PLAY_FILL, SHEET } from './SpotifyViews';

/** What is on: the theme's selected fill. What is off: the quiet sheet. */
const onLook = (on: boolean) => (on ? PLAY_FILL : { background: SHEET });

/** A round button a thumb wide. */
function RoundButton({
  label,
  on = false,
  busy = false,
  disabled = false,
  onClick,
  colors,
  children,
}: {
  label: string;
  on?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  colors: ThemeColors;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn('flex h-11 w-11 items-center justify-center rounded-full transition-opacity disabled:opacity-50', !on && colors.textMain)}
      style={onLook(on)}
    >
      {busy ? <Loader2 size={18} className="animate-spin" /> : children}
    </button>
  );
}

/** A trouble from one of these presses, in their words, with the sign-in page a tap away. */
export function MoreNotice({ trouble, colors, onOpenLink }: { trouble: SpotifyTrouble | null; colors: ThemeColors; onOpenLink: (url: string) => void }) {
  if (!trouble) return null;
  return (
    <div role="status" className="pt-3 text-center">
      <p className={cn('text-xs leading-relaxed [overflow-wrap:anywhere]', colors.textMuted)}>{troubleLine(trouble)}</p>
      {trouble.kind === 'signin' && trouble.authUrl && (
        <button
          type="button"
          onClick={() => onOpenLink(trouble.authUrl!)}
          className={cn('mt-2 rounded-full border px-4 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
        >
          Open the sign-in page
        </button>
      )}
    </div>
  );
}

export type PlayerPress =
  | { kind: 'shuffle'; on: boolean }
  | { kind: 'repeat'; mode: SpotifyPlayerView['repeat'] }
  | { kind: 'volume'; percent: number }
  | { kind: 'seek'; positionMs: number }
  | { kind: 'like'; uri: string; liked: boolean };

/**
 * Under the big cover: shuffle, repeat, the heart, the device, and the song's
 * place and volume as sliders. The place moves with the clock between reads
 * (lib/spotify-more.ts positionNow); nothing here asks Spotify on a timer.
 */
export function PlayerExtras({
  player,
  readAt,
  trackUri,
  liked,
  busy,
  colors,
  onPress,
  onDevices,
  onSongMore,
}: {
  player: SpotifyRead<SpotifyPlayerView> | null;
  /** When the player was read (Date.now()), so the place can move on from it. */
  readAt: number;
  /** The song playing, when it is one the owner can heart and add. */
  trackUri: string | null;
  /** Whether that song is hearted; null while unknown. */
  liked: boolean | null;
  /** Which of these presses is out, or null. */
  busy: string | null;
  colors: ThemeColors;
  onPress: (press: PlayerPress, where: string) => void;
  onDevices: () => void;
  onSongMore: (() => void) | null;
}) {
  const view = player?.ok ? player.data : null;
  const [now, setNow] = useState(() => Date.now());
  // A local clock for the bar only, while a song plays and the page shows.
  useEffect(() => {
    if (!view?.playing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [view?.playing]);
  const [dragPlace, setDragPlace] = useState<number | null>(null);
  const [dragVolume, setDragVolume] = useState<number | null>(null);
  useEffect(() => { setDragPlace(null); setDragVolume(null); }, [player]);

  const active = view?.active === true;
  const place = dragPlace ?? (view ? positionNow(view, readAt, now) : null);
  const length = view?.durationMs ?? null;
  const volume = dragVolume ?? view?.volume ?? null;
  const VolumeIcon = volume === 0 ? VolumeX : volume !== null && volume < 50 ? Volume1 : Volume2;
  const RepeatIcon = view?.repeat === 'track' ? Repeat1 : Repeat;
  const anyBusy = busy !== null;

  return (
    <div className="mt-5 w-full">
      <div className="flex items-center justify-center gap-3">
        <RoundButton
          label={view?.shuffle ? 'Shuffle is on' : 'Shuffle is off'}
          on={!!view?.shuffle}
          busy={busy === 'shuffle'}
          disabled={!active || anyBusy}
          onClick={() => onPress({ kind: 'shuffle', on: !view?.shuffle }, 'shuffle')}
          colors={colors}
        >
          <Shuffle size={18} />
        </RoundButton>
        <RoundButton
          label={view?.repeat === 'track' ? 'Repeating this song' : view?.repeat === 'context' ? 'Repeating the playlist' : 'Repeat is off'}
          on={!!view && view.repeat !== 'off'}
          busy={busy === 'repeat'}
          disabled={!active || anyBusy}
          onClick={() => view && onPress({ kind: 'repeat', mode: nextRepeat(view.repeat) }, 'repeat')}
          colors={colors}
        >
          <RepeatIcon size={18} />
        </RoundButton>
        <RoundButton
          label={liked ? 'Liked. Tap to take the heart off' : 'Heart this song'}
          on={liked === true}
          busy={busy === 'like'}
          disabled={!trackUri || liked === null || anyBusy}
          onClick={() => trackUri && onPress({ kind: 'like', uri: trackUri, liked: !liked }, 'like')}
          colors={colors}
        >
          <Heart size={18} fill={liked ? 'currentColor' : 'none'} />
        </RoundButton>
        <RoundButton label="Add to a playlist, and more" disabled={!onSongMore || anyBusy} onClick={() => onSongMore?.()} colors={colors}>
          <ListPlus size={18} />
        </RoundButton>
        <RoundButton label="Choose where it plays" disabled={anyBusy} onClick={onDevices} colors={colors}>
          <MonitorSpeaker size={18} />
        </RoundButton>
      </div>

      {active && length !== null && place !== null && (
        <div className="mt-4">
          <input
            type="range"
            aria-label="Where in the song"
            min={0}
            max={length}
            step={1000}
            value={Math.min(place, length)}
            disabled={anyBusy}
            onChange={(event) => setDragPlace(Number(event.target.value))}
            onPointerUp={() => dragPlace !== null && onPress({ kind: 'seek', positionMs: dragPlace }, 'seek')}
            onKeyUp={() => dragPlace !== null && onPress({ kind: 'seek', positionMs: dragPlace }, 'seek')}
            className="w-full" style={{ accentColor: "var(--bytelight-accent)" }}
          />
          <div className={cn('mt-0.5 flex justify-between text-[11px] tabular-nums', colors.textMuted)}>
            <span>{clockOf(place)}</span>
            <span>{busy === 'seek' ? <Loader2 size={11} className="inline animate-spin" /> : clockOf(length)}</span>
          </div>
        </div>
      )}

      {active && volume !== null && (
        <div className={cn('mt-3 flex items-center gap-3', colors.textMuted)}>
          {busy === 'volume' ? <Loader2 size={18} className="shrink-0 animate-spin" /> : <VolumeIcon size={18} className="shrink-0" />}
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={100}
            step={1}
            value={volume}
            disabled={anyBusy}
            onChange={(event) => setDragVolume(Number(event.target.value))}
            onPointerUp={() => dragVolume !== null && onPress({ kind: 'volume', percent: dragVolume }, 'volume')}
            onKeyUp={() => dragVolume !== null && onPress({ kind: 'volume', percent: dragVolume }, 'volume')}
            className="w-full" style={{ accentColor: "var(--bytelight-accent)" }}
          />
          <span className="w-8 shrink-0 text-right text-[11px] tabular-nums">{volume}</span>
        </div>
      )}

      {view && !view.active && (
        <p className={cn('mt-3 text-center text-[11px]', colors.textMuted)}>Shuffle, repeat and volume wake up once something is playing.</p>
      )}
      {active && view?.device && (
        <p className={cn('mt-2 text-center text-[11px]', colors.textMuted)}>Playing on {view.device.name}</p>
      )}
    </div>
  );
}

/** A sheet up from the bottom of the screen; back and the dim area close it. */
export function Sheet({ title, colors, onClose, children }: { title: string; colors: ThemeColors; onClose: () => void; children: ReactNode }) {
  useBackHandler(true, onClose);
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div
        className={cn('relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-2xl border px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3', colors.panelBg, colors.panelBorder)}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className={cn('min-w-0 truncate text-sm font-semibold', colors.textMain)}>{title}</h3>
          <button type="button" aria-label="Close" onClick={onClose} className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', colors.textMuted)}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** One row in a sheet: an icon, words, and a thumb-wide press. */
function SheetRow({
  icon,
  label,
  hint,
  busy = false,
  disabled = false,
  onClick,
  colors,
  divided = true,
}: {
  icon: ReactNode;
  label: string;
  hint?: string | null;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  colors: ThemeColors;
  divided?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className="flex min-h-[3rem] w-full items-center gap-3 py-2 text-left transition-opacity disabled:opacity-50"
      style={divided ? { borderTop: `1px solid ${HAIRLINE}` } : undefined}
    >
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', colors.textMain)} style={{ background: SHEET }}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[13px] font-semibold', colors.textMain)}>{label}</span>
        {hint && <span className={cn('block truncate text-[11px]', colors.textMuted)}>{hint}</span>}
      </span>
    </button>
  );
}

/**
 * A song's sheet: the heart, adding it to one of their own playlists (or a new
 * one), and inside one of their own playlists, moving it and taking it out.
 */
export function SongSheet({
  track,
  liked,
  place,
  playlists,
  busy,
  trouble,
  colors,
  onLike,
  onAdd,
  onNewWithSong,
  onMove,
  onRemove,
  onClose,
  onOpenLink,
}: {
  track: SpotifyTrack;
  liked: boolean | null;
  /** Where it sits in the open playlist when that playlist is theirs, else null. */
  place: { playlistName: string; index: number; length: number } | null;
  /** Their own playlists, for adding; null while they load. */
  playlists: SpotifyPlaylist[] | null;
  busy: string | null;
  trouble: SpotifyTrouble | null;
  colors: ThemeColors;
  onLike: (liked: boolean) => void;
  onAdd: (playlist: SpotifyPlaylist) => void;
  onNewWithSong: () => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const anyBusy = busy !== null;
  const targets = place ? moveTargets(place.index, place.length) : null;
  return (
    <Sheet title={adding ? 'Add to a playlist' : track.name} colors={colors} onClose={adding ? () => setAdding(false) : onClose}>
      {!adding ? (
        <>
          <div className="mb-2 flex items-center gap-3">
            <Cover src={track.cover} className="h-14 w-14 shrink-0 rounded-md" />
            <div className="min-w-0">
              <div className={cn('truncate text-[13px] font-semibold', colors.textMain)}>{track.name}</div>
              {track.artist && <div className={cn('truncate text-[11px]', colors.textMuted)}>{track.artist}</div>}
            </div>
          </div>
          <SheetRow
            icon={<Heart size={16} fill={liked ? 'currentColor' : 'none'} />}
            label={liked ? 'Take the heart off' : 'Heart it'}
            hint={liked === null ? 'Checking…' : liked ? 'It is in your Liked Songs' : null}
            busy={busy === 'like'}
            disabled={liked === null || anyBusy}
            onClick={() => onLike(!liked)}
            colors={colors}
          />
          <SheetRow icon={<ListPlus size={16} />} label="Add to a playlist" disabled={anyBusy} onClick={() => setAdding(true)} colors={colors} />
          {place && targets && (
            <>
              <SheetRow icon={<ArrowUp size={16} />} label="Move up" hint={`In ${place.playlistName}`} busy={busy === 'move-up'} disabled={targets.up === null || anyBusy} onClick={() => targets.up !== null && onMove(targets.up)} colors={colors} />
              <SheetRow icon={<ArrowDown size={16} />} label="Move down" busy={busy === 'move-down'} disabled={targets.down === null || anyBusy} onClick={() => targets.down !== null && onMove(targets.down)} colors={colors} />
              <SheetRow icon={<Trash2 size={16} />} label={`Take it out of ${place.playlistName}`} busy={busy === 'remove'} disabled={anyBusy} onClick={onRemove} colors={colors} />
            </>
          )}
        </>
      ) : (
        <>
          <SheetRow icon={<Plus size={16} />} label="New playlist with this song" divided={false} disabled={anyBusy} onClick={onNewWithSong} colors={colors} />
          {playlists === null ? (
            <p className={cn('py-3 text-center text-xs', colors.textMuted)}>Loading your playlists…</p>
          ) : playlists.length === 0 ? (
            <p className={cn('py-3 text-center text-xs', colors.textMuted)}>None of your playlists can take songs yet. Make a new one above.</p>
          ) : (
            playlists.map((list) => (
              <SheetRow
                key={list.id}
                icon={busy === `add:${list.id}` ? <Loader2 size={16} className="animate-spin" /> : <Cover src={list.cover} className="h-9 w-9 rounded-full" />}
                label={list.name}
                hint={busy === `added:${list.id}` ? 'Added' : null}
                disabled={anyBusy}
                onClick={() => onAdd(list)}
                colors={colors}
              />
            ))
          )}
        </>
      )}
      <MoreNotice trouble={trouble} colors={colors} onOpenLink={onOpenLink} />
    </Sheet>
  );
}

function deviceIcon(type: string) {
  return /phone/i.test(type) ? <Smartphone size={16} /> : /speaker|tv|cast|avr|stb|audio/i.test(type) ? <Speaker size={16} /> : <MonitorSpeaker size={16} />;
}

/** The owner devices Spotify can play on now; a tap moves the music there. */
export function DeviceSheet({
  read,
  busy,
  trouble,
  colors,
  onPick,
  onClose,
  onOpenLink,
}: {
  read: SpotifyRead<SpotifyDevicesView> | null;
  busy: string | null;
  trouble: SpotifyTrouble | null;
  colors: ThemeColors;
  onPick: (deviceId: string) => void;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  return (
    <Sheet title="Where it plays" colors={colors} onClose={onClose}>
      {read === null ? (
        <p className={cn('py-3 text-center text-xs', colors.textMuted)}>Looking…</p>
      ) : read.ok === false ? (
        <MoreNotice trouble={read.trouble} colors={colors} onOpenLink={onOpenLink} />
      ) : read.data.devices.length === 0 ? (
        <p className={cn('py-3 text-center text-xs leading-relaxed', colors.textMuted)}>
          Spotify doesn't see any of your devices right now. It lists a device once the Spotify app is open on it.
        </p>
      ) : (
        read.data.devices.map((device, i) => (
          <SheetRow
            key={device.id}
            icon={device.active ? <Check size={16} /> : deviceIcon(device.type)}
            label={device.name}
            hint={device.active ? 'Playing here' : device.type}
            busy={busy === `device:${device.id}`}
            disabled={busy !== null || device.active}
            onClick={() => onPick(device.id)}
            colors={colors}
            divided={i > 0}
          />
        ))
      )}
      {read?.ok && <MoreNotice trouble={trouble} colors={colors} onOpenLink={onOpenLink} />}
    </Sheet>
  );
}

/** A playlist's name and description: for a new one, or renaming one of theirs. */
export function NameSheet({
  title,
  initialName = '',
  initialDescription = '',
  busy,
  trouble,
  colors,
  onSave,
  onClose,
  onOpenLink,
}: {
  title: string;
  initialName?: string;
  initialDescription?: string;
  busy: boolean;
  trouble: SpotifyTrouble | null;
  colors: ThemeColors;
  onSave: (name: string, description: string) => void;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const field = cn('w-full rounded-xl border px-3 py-2.5 text-sm outline-none', colors.panelBorder, colors.textMain);
  return (
    <Sheet title={title} colors={colors} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave(name.trim(), description.trim());
        }}
        className="flex flex-col gap-3"
      >
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={SPOTIFY_PLAYLIST_NAME_LONGEST}
          placeholder="Name"
          aria-label="Playlist name"
          className={field}
          style={{ background: SHEET }}
        />
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={SPOTIFY_PLAYLIST_DESCRIPTION_LONGEST}
          placeholder="Description (if you like)"
          aria-label="Playlist description"
          rows={2}
          className={cn(field, 'resize-none')}
          style={{ background: SHEET }}
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="flex h-11 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-opacity disabled:opacity-50"
          style={PLAY_FILL}
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          Save
        </button>
      </form>
      <MoreNotice trouble={trouble} colors={colors} onOpenLink={onOpenLink} />
    </Sheet>
  );
}

// React is in scope for test renders that compile JSX the classic way.
void React;
