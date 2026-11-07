// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spotify in the house (Oct 20 2026).
//
// A search box at the top, and the songs it finds under it (Oct 20 2026); what is playing now with its cover big
// and previous, play or pause, and next under it; what played lately as a row
// of covers, each a tap to play it; their playlists as a grid. A playlist opens
// to every song with its own cover, a tap on a song starts the playlist at
// that song, and its Play button plays the whole playlist; a recent or found
// song starts its album at that song (lib/spotify.ts songPress says why). Back
// steps out one level. Those are the only presses. Read when it opens, when
// the owner taps refresh, when the phone wakes, once after every press
// (lib/spotify.ts pressAndLook), and a search when the owner asks for one; never on
// a timer.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Music, RefreshCw } from 'lucide-react';
import type { SpotifyDevicesView, SpotifyPlayerView, SpotifyPlaylist, SpotifyPlaylistTracksView, SpotifySearchView, SpotifyTrack } from '@bytelight/shared';
import { AppShell } from './AppShell';
import { PlaylistView, SearchSection, SpotifyHomeView, type PressState } from './spotify/SpotifyViews';
import { DeviceSheet, MoreNotice, NameSheet, PlayerExtras, SongSheet, type PlayerPress } from './spotify/SpotifyMore';
import {
  LIKED_ID,
  LIKED_PLAYLIST,
  loadDevices,
  loadLiked,
  loadPlayer,
  loadSaved,
  playlistsForAdding,
  sendSpotify,
  spotifyActions,
} from '../lib/spotify-more';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { wakeSpotify } from '../bytelight/spotify-wake';
import { useBackHandler } from '../lib/use-back-handler';
import { useSpotifyNow } from '../lib/use-spotify-now';
import {
  createSpotifyNow,
  loadSpotifyHome,
  loadSpotifyPlaylist,
  playingUri,
  searchSpotify,
  type SpotifyHome,
  type SpotifyRead,
  type SpotifyTrouble,
} from '../lib/spotify';

/** How long Spotify is given after a player press before the player is read again. */
const PLAYER_SETTLE_MS = 700;

type Action = readonly ['POST' | 'PATCH' | 'PUT', string, unknown];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface SpotifyAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

/** byte-light: no @capacitor/browser here, so a link opens in a new tab (Aerie's lib/open-external fallback). */
function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function SpotifyApp({ onClose, themeConfig, themeMode }: SpotifyAppProps) {
  const colors = themeConfig[themeMode];
  // What is playing, and every press, go through the one keeper the lock
  // screen's card uses too (lib/spotify.ts createSpotifyNow): every read of
  // what is playing numbered as it starts so an older one never replaces a
  // newer one, one press at a time, and the one look after it.
  const [spotify] = useState(() => createSpotifyNow(apiFetch, { wake: wakeSpotify }));
  const now = useSpotifyNow(spotify);
  const [lists, setLists] = useState<Pick<SpotifyHome, 'recent' | 'playlists'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [openList, setOpenList] = useState<SpotifyPlaylist | null>(null);
  const [songs, setSongs] = useState<SpotifyRead<SpotifyPlaylistTracksView> | null>(null);

  const [player, setPlayer] = useState<SpotifyRead<SpotifyPlayerView> | null>(null);
  const [playerAt, setPlayerAt] = useState(() => Date.now());
  const playerReads = useRef(0);
  const readPlayer = useCallback(async () => {
    const mine = ++playerReads.current;
    const next = await loadPlayer(apiFetch);
    if (mine !== playerReads.current) return;
    setPlayer(next);
    setPlayerAt(Date.now());
  }, []);
  // Only the newest read may land: an older answer arriving last would put
  // the page back.
  const homeReads = useRef(0);
  const load = useCallback(async () => {
    const mine = ++homeReads.current;
    const look = spotify.begin();
    setLoading(true);
    const next = await loadSpotifyHome(apiFetch);
    if (mine !== homeReads.current) return;
    spotify.land(look, next.now);
    setLists({ recent: next.recent, playlists: next.playlists });
    setLoading(false);
    void readPlayer();
  }, [spotify, readPlayer]);
  const home: SpotifyHome | null = lists && now.read ? { ...lists, now: now.read } : null;

  const songReads = useRef(0);
  const loadSongs = useCallback(async (id: string) => {
    const mine = ++songReads.current;
    const next = id === LIKED_ID ? await loadLiked(apiFetch) : await loadSpotifyPlaylist(apiFetch, id);
    if (mine === songReads.current) setSongs(next);
  }, []);

  // ── The player, their hearts and their playlists (Oct 23 2026) ──

  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const checkLiked = useCallback(async (uris: Array<string | null | undefined>) => {
    const read = await loadSaved(apiFetch, uris);
    if (read.ok) setLiked((was) => ({ ...was, ...read.data.saved }));
  }, []);
  // One press of these at a time, named by where it came from, and its sentence.
  const [busy, setBusy] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<SpotifyTrouble | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const done = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(done);
  }, [toast]);
  const act = useCallback(async (where: string, [method, url, body]: Action) => {
    setBusy(where);
    setTrouble(null);
    const result = await sendSpotify(apiFetch, method, url, body);
    setBusy(null);
    if (result.ok === false) setTrouble(result.trouble);
    return result;
  }, []);
  const settleThenRead = useCallback(() => {
    window.setTimeout(() => { void readPlayer(); void spotify.look(); }, PLAYER_SETTLE_MS);
  }, [readPlayer, spotify]);

  const nowTrack = now.read?.ok ? now.read.data.track : null;
  const nowUri = nowTrack?.uri ?? null;
  useEffect(() => {
    if (nowUri) void checkLiked([nowUri]);
  }, [nowUri, checkLiked]);

  const playerPress = async (press: PlayerPress, where: string) => {
    const action: Action = press.kind === 'shuffle' ? spotifyActions.shuffle(press.on)
      : press.kind === 'repeat' ? spotifyActions.repeat(press.mode)
      : press.kind === 'volume' ? spotifyActions.volume(press.percent)
      : press.kind === 'seek' ? spotifyActions.seek(press.positionMs)
      : spotifyActions.like(press.uri, press.liked);
    const result = await act(where, action);
    if (press.kind === 'like') {
      if (result.ok) setLiked((was) => ({ ...was, [press.uri]: press.liked }));
      return;
    }
    settleThenRead();
  };

  // A song's sheet: the heart, adding it, and in their own open playlist, moving it and taking it out.
  const [sheetSong, setSheetSong] = useState<{ track: SpotifyTrack; index: number | null } | null>(null);
  const openSong = (track: SpotifyTrack, index: number | null) => {
    setTrouble(null);
    setSheetSong({ track, index });
    void checkLiked([track.uri]);
  };
  const closeSong = () => { setSheetSong(null); setTrouble(null); };

  const [deviceRead, setDeviceRead] = useState<SpotifyRead<SpotifyDevicesView> | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const openDevices = async () => {
    setTrouble(null);
    setDevicesOpen(true);
    setDeviceRead(null);
    setDeviceRead(await loadDevices(apiFetch));
  };
  const pickDevice = async (deviceId: string) => {
    const result = await act(`device:${deviceId}`, spotifyActions.transfer(deviceId));
    if (result.ok) {
      setDevicesOpen(false);
      settleThenRead();
    }
  };

  const [naming, setNaming] = useState<{ mode: 'new'; withSong: string | null } | { mode: 'rename' } | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // A search, when the owner asks for one. Only the newest may land, and clearing
  // it drops any still on its way.
  const [words, setWords] = useState('');
  const [found, setFound] = useState<SpotifyRead<SpotifySearchView> | null>(null);
  const [searching, setSearching] = useState(false);
  const searchReads = useRef(0);
  const runSearch = async () => {
    if (!words.trim()) return;
    const mine = ++searchReads.current;
    // New songs take the old rows' places, so no press's sentence stays by them.
    spotify.leave();
    setSearching(true);
    const next = await searchSpotify(apiFetch, words);
    if (mine !== searchReads.current) return;
    setFound(next);
    setSearching(false);
  };
  const clearSearch = () => {
    searchReads.current += 1;
    spotify.leave();
    setWords('');
    setFound(null);
    setSearching(false);
  };

  // A phone that slept may be playing something else now. Once per wake, not a poll.
  useEffect(() => {
    const woke = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', woke);
    return () => document.removeEventListener('visibilitychange', woke);
  }, [load]);

  // Which page the owner is on, so a press's sentence never turns up on a page the owner
  // has since left.
  const leavePage = () => spotify.leave();

  // A playlist opens at its top, and the front page comes back where the owner left it.
  const rootRef = useRef<HTMLDivElement>(null);
  const homeScroll = useRef(0);
  const scroller = () => rootRef.current?.closest<HTMLElement>('.bytelight-app-body') ?? null;
  const openPlaylist = (list: SpotifyPlaylist) => {
    homeScroll.current = scroller()?.scrollTop ?? 0;
    leavePage();
    setSongs(null);
    setOpenList(list);
    void loadSongs(list.id);
  };
  const closePlaylist = () => {
    songReads.current += 1;
    leavePage();
    setOpenList(null);
    setSongs(null);
  };
  useLayoutEffect(() => {
    const body = scroller();
    if (body) body.scrollTop = openList ? 0 : homeScroll.current;
  }, [openList]);

  // The system back steps out the way the header arrow does: the playlist
  // first, and only the front page closes the app.
  useBackHandler(openList !== null, closePlaylist);
  // On the front page, a search showing is cleared first.
  useBackHandler(openList === null && (found !== null || searching), clearSearch);
  const handleBack = () => {
    if (openList) {
      closePlaylist();
      return;
    }
    onClose();
  };

  // A press: one at a time, every press button waits while it is out, and
  // what is playing is read once after it and shown. A sentence goes by the
  // button the owner pressed only when that read does not show what the owner asked for
  // (lib/spotify.ts createSpotifyNow and pressAndLook say why).
  const presses: PressState = {
    pressing: now.pressing,
    notice: now.notice,
    onPress: (what, where) => void spotify.press(what, where).then(() => readPlayer()),
  };

  const own = openList !== null && openList.mine === true;
  const myLists = lists?.playlists.ok ? playlistsForAdding(lists.playlists.data.playlists) : null;
  const sheetPlace = sheetSong && own && openList && sheetSong.index !== null && songs?.ok
    ? { playlistName: openList.name, index: sheetSong.index, length: songs.data.tracks.length }
    : null;

  const addTo = async (list: SpotifyPlaylist) => {
    if (!sheetSong?.track.uri) return;
    const result = await act(`add:${list.id}`, spotifyActions.add(list.id, [sheetSong.track.uri]));
    if (result.ok) {
      closeSong();
      setToast(`Added to ${list.name}`);
      void load();
      if (openList?.id === list.id) void loadSongs(list.id);
    }
  };
  const moveSong = async (to: number) => {
    if (!openList || !sheetSong || sheetSong.index === null) return;
    const result = await act(to < sheetSong.index ? 'move-up' : 'move-down', spotifyActions.move(openList.id, sheetSong.index, to));
    if (result.ok) {
      setSheetSong({ ...sheetSong, index: to });
      void loadSongs(openList.id);
    }
  };
  const removeSong = async () => {
    if (!openList || !sheetSong?.track.uri) return;
    const result = await act('remove', spotifyActions.remove(openList.id, [sheetSong.track.uri]));
    if (result.ok) {
      closeSong();
      setToast(`Taken out of ${openList.name}`);
      void loadSongs(openList.id);
      void load();
    }
  };
  const likeSong = async (wanted: boolean) => {
    const uri = sheetSong?.track.uri;
    if (!uri) return;
    const result = await act('like', spotifyActions.like(uri, wanted));
    if (result.ok) setLiked((was) => ({ ...was, [uri]: wanted }));
  };
  const saveName = async (name: string, description: string) => {
    if (!naming) return;
    if (naming.mode === 'rename') {
      if (!openList) return;
      const result = await act('name', spotifyActions.rename(openList.id, name, description));
      if (result.ok) {
        setOpenList({ ...openList, name });
        setNaming(null);
        void load();
      }
      return;
    }
    const made = await act('name', spotifyActions.newPlaylist(name, description));
    if (made.ok === false) return;
    const playlist = made.data.playlist as SpotifyPlaylist | undefined;
    if (naming.withSong && playlist?.id) await act('name', spotifyActions.add(playlist.id, [naming.withSong]));
    setNaming(null);
    closeSong();
    setToast(`Made ${name}`);
    void load();
    if (playlist?.id) openPlaylist({ ...playlist, name, tracks: naming.withSong ? 1 : 0 });
  };
  const setPicture = async (file: File) => {
    if (!openList) return;
    let image: string;
    try {
      image = await readAsDataUrl(file);
    } catch {
      setTrouble({ kind: 'problem', message: 'That picture could not be read on the phone.' });
      return;
    }
    const result = await act('picture', spotifyActions.cover(openList.id, image));
    if (result.ok) {
      setToast('Picture set. Spotify can take a minute to show it.');
      void load();
    }
  };

  const refresh = () => {
    spotify.quiet();
    void load();
    if (openList) void loadSongs(openList.id);
  };
  const refreshing = loading || (openList !== null && songs === null);

  return (
    <AppShell
      title="Spotify"
      icon={Music}
      onClose={handleBack}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={refresh}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
          aria-label="Refresh Spotify"
        >
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      <div ref={rootRef} className="mx-auto w-full max-w-md">
        {openList ? (
          <PlaylistView
            playlist={openList}
            read={songs}
            nowUri={playingUri(now.read)}
            press={presses}
            colors={colors}
            onOpenLink={(url) => void openExternal(url)}
            onMore={(track, i) => openSong(track, i)}
            onRename={own ? () => { setTrouble(null); setNaming({ mode: 'rename' }); } : null}
            onPicture={own ? (file) => void setPicture(file) : null}
            editing={busy === 'picture' ? 'picture' : null}
            notice={!sheetSong && !naming && !devicesOpen ? <MoreNotice trouble={trouble} colors={colors} onOpenLink={(url) => void openExternal(url)} /> : null}
          />
        ) : (
          <SpotifyHomeView
            home={home}
            press={presses}
            colors={colors}
            onOpenPlaylist={openPlaylist}
            onOpenLink={(url) => void openExternal(url)}
            onOpenLiked={() => openPlaylist(LIKED_PLAYLIST)}
            onNewPlaylist={() => { setTrouble(null); setNaming({ mode: 'new', withSong: null }); }}
            nowExtra={
              <>
                <PlayerExtras
                  player={player}
                  readAt={playerAt}
                  trackUri={nowUri}
                  liked={nowUri ? liked[nowUri] ?? null : null}
                  busy={busy}
                  colors={colors}
                  onPress={(press, where) => void playerPress(press, where)}
                  onDevices={() => void openDevices()}
                  onSongMore={nowTrack?.uri ? () => openSong(nowTrack, null) : null}
                />
                {!sheetSong && !naming && !devicesOpen && <MoreNotice trouble={trouble} colors={colors} onOpenLink={(url) => void openExternal(url)} />}
              </>
            }
            search={
              <SearchSection
                words={words}
                onWords={setWords}
                onSearch={() => void runSearch()}
                onClear={clearSearch}
                read={found}
                searching={searching}
                press={presses}
                nowUri={playingUri(now.read)}
                colors={colors}
                onOpenLink={(url) => void openExternal(url)}
                onMore={(track) => openSong(track, null)}
              />
            }
          />
        )}
        {toast && (
          <div role="status" className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4">
            <div className={cn('rounded-full border px-4 py-2 text-xs font-semibold shadow-lg', colors.panelBg, colors.panelBorder, colors.textMain)}>{toast}</div>
          </div>
        )}
        {sheetSong && (
          <SongSheet
            track={sheetSong.track}
            liked={sheetSong.track.uri ? liked[sheetSong.track.uri] ?? null : null}
            place={sheetPlace}
            playlists={myLists}
            busy={busy}
            trouble={trouble}
            colors={colors}
            onLike={(wanted) => void likeSong(wanted)}
            onAdd={(list) => void addTo(list)}
            onNewWithSong={() => { setTrouble(null); setNaming({ mode: 'new', withSong: sheetSong.track.uri }); }}
            onMove={(to) => void moveSong(to)}
            onRemove={() => void removeSong()}
            onClose={closeSong}
            onOpenLink={(url) => void openExternal(url)}
          />
        )}
        {devicesOpen && (
          <DeviceSheet
            read={deviceRead}
            busy={busy}
            trouble={trouble}
            colors={colors}
            onPick={(id) => void pickDevice(id)}
            onClose={() => { setDevicesOpen(false); setTrouble(null); }}
            onOpenLink={(url) => void openExternal(url)}
          />
        )}
        {naming && (
          <NameSheet
            title={naming.mode === 'rename' ? 'Rename playlist' : 'New playlist'}
            initialName={naming.mode === 'rename' ? openList?.name ?? '' : ''}
            busy={busy === 'name'}
            trouble={trouble}
            colors={colors}
            onSave={(name, description) => void saveName(name, description)}
            onClose={() => { setNaming(null); setTrouble(null); }}
            onOpenLink={(url) => void openExternal(url)}
          />
        )}
      </div>
    </AppShell>
  );
}
