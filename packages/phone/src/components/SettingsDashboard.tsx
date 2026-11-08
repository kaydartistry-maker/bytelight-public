import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  X,
  Moon,
  Sun,
  Palette,
  Image as ImageIcon,
  Upload,
  Check,
  Smartphone,
  Bell,
  Plus,
  Minus,
  Settings as SettingsIcon,
  Loader2,
  ExternalLink,
  LogOut,
  UserRound,
  Trash2,
} from "lucide-react";
import { AppShell } from "./AppShell";
import Cropper from "react-easy-crop";
import { PushNotifications } from "@capacitor/push-notifications";
import { Capacitor } from "@capacitor/core";
import { AppTheme, ThemeId, ThemeMode, AppSettings } from "../types";
import { THEMES, themeRadiusPx, withAccentOverride, ACCENT_PALETTES, TYPOGRAPHY_PRESETS, fontStack } from "../lib/theme";
import { APPS, migrateAppIds } from "../lib/apps";
import { noteColorsForAccent } from '../lib/note-colors';
import { LockPreview } from "./LockClock";
import { HOME_WIDGETS, homeWidgetsOf, toggleWidget } from "../lib/home-widgets";
import { lockCardsOf, type LockCardChoice } from "../lib/lock-cards";
import { lockSpotifyOf } from "../lib/lock-spotify";
import { lockClockAtOf, lockFaceOf, lockHiddenOf, lockPositionOf, lockShortcutsOf, lockShowOf, lockSizeOf, lockWeatherAtOf, withClockAt, withHidden, type LockFace, type LockPiece, type LockShow, type LockSize } from "../lib/lock-clock";
import { cn } from "../lib/utils";
import getCroppedImg from "../lib/cropImage";
import { WebUiPassword } from "./WebUiPassword";
import { ProfilesPanel } from "./ProfilesPanel";
import { SetupSync } from "./SetupSync";
import { AppUpdate } from "./AppUpdate";
import { SEND_ICONS, DEFAULT_SEND_ICON_ID } from "../lib/sendIcons";
import { Toggle } from "./Toggle";
import { apiFetch } from "../bytelight";
import { subscribeWebPush, unsubscribeWebPush, sendTestPush, webPushSupported } from "../bytelight/push";

// Determine if a hex color is near-white (needs black foreground for contrast)
// Only returns true for very light colors like mono's #FAFAFA — most accent colors get white text
function isNearWhite(hex: string): boolean {
  // Handle CSS variables or non-hex strings — can't compute, use white text
  if (!hex || !hex.startsWith('#') || hex.length < 7) return false;
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // Handle parse failures
  if (isNaN(r) || isNaN(g) || isNaN(b)) return false;
  // Only trigger for very light colors (luminance > 0.85)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.85;
}

interface SettingsDashboardProps {
  theme: AppTheme;
  appSettings: Omit<AppSettings, "theme" | "contacts">;
  onThemeChange: (theme: Partial<AppTheme>) => void;
  onSettingsChange: (
    settings: Partial<Omit<AppSettings, "theme" | "contacts">>,
  ) => void;
  onClose: () => void;
}

export const SettingsDashboard: React.FC<SettingsDashboardProps> = ({
  theme,
  appSettings,
  onThemeChange,
  onSettingsChange,
  onClose,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const activeTheme = withAccentOverride(THEMES[theme.id] || THEMES["monochrome"], theme.accentOverride, theme.accentPalette);
  const colors = activeTheme[theme.mode];

  // These five used to be five pale hex values written into this file, saved on
  // her theme, and handed to the Notes app as the only source -- so the notes
  // were pale whatever theme was on, and one app-wide font colour melted the
  // writing into them. They come out of the theme's own accent now, and this
  // setting is an OVERRIDE rather than the source. Clearing it goes back to
  // whatever the theme says.
  const themeNoteColors = React.useMemo(() => {
    // On the Custom theme the accent is a CSS variable rather than a value, so
    // it has to come from her own picks instead -- otherwise Custom silently
    // falls back to the pale five and looks like nothing happened.
    const raw = theme.id === 'custom'
      ? theme.customColors?.[theme.mode]?.accent
      : colors.accent;
    const accent = typeof raw === 'string' ? raw.trim() : '';
    const generated = accent.startsWith('#') ? noteColorsForAccent(accent, theme.mode) : [];
    return generated.length ? generated : ['#fef08a', '#bfdbfe', '#bbf7d0', '#fbcfe8', '#e9d5ff'];
  }, [colors.accent, theme.mode, theme.id, theme.customColors]);
  const shownNoteColors = theme.stickyNoteColors && theme.stickyNoteColors.length
    ? theme.stickyNoteColors
    : themeNoteColors;
  // Resolve the actual hex accent color (custom uses CSS vars, need actual value)
  const resolvedAccent = theme.id === "custom"
    ? (theme.customColors?.[theme.mode]?.accent || "#888888")
    : colors.accent;
  const [activeTab, setActiveTab] = useState<"appearance" | "profiles" | "data">("appearance");

  // Cropper state
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropTarget, setCropTarget] = useState<
    "single" | "lockscreen" | "avatar" | number
  >("single");
  // Which lock screen corner the shortcut picker is setting: 0 left, 1 right.
  const [lockCorner, setLockCorner] = useState<0 | 1>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  const [pushError, setPushError] = useState<string | null>(null);
  const [pushTestState, setPushTestState] = useState<"idle" | "sending" | "sent">("idle");
  const sendPushTest = async () => {
    setPushTestState("sending");
    setPushError(null);
    try {
      await sendTestPush();
      setPushTestState("sent");
      setTimeout(() => setPushTestState("idle"), 3000);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err));
      setPushTestState("idle");
    }
  };

  const handlePushToggle = async () => {
    const isEnabling = !appSettings.pushNotificationsEnabled;

    if (isEnabling) {
      if (Capacitor.isNativePlatform()) {
        try {
          let permStatus = await PushNotifications.checkPermissions();

          if (permStatus.receive !== "granted") {
            permStatus = await PushNotifications.requestPermissions();
          }

          if (permStatus.receive === "granted") {
            // LISTENERS FIRST, THEN register(). On a device that already holds a
            // cached token the "registration" event fires immediately — before
            // anything is listening if register() goes first — and the token is
            // never sent, so enabling push silently does nothing and there is no
            // error anywhere to find.
            await PushNotifications.addListener("registration", async (token) => {
              console.log("[Bytelight] FCM token generated");

              // The house holds the Firebase credentials and does the sending,
              // so the token is registered here rather than with the old
              // Cloudflare worker the Constellation Phone used.
              try {
                const res = await fetch("/api/push/subscribe", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({
                    deviceToken: token.value,
                    deviceLabel: Capacitor.getPlatform(),
                  }),
                });
                // The house stores the token beside the browser's web-push
                // subscriptions and sends to both; say so if it refused.
                if (!res.ok) {
                  setPushError("The house couldn't register this phone for push. Check the Firebase service account in Secrets.");
                }
              } catch (e) {
                console.error("[Bytelight] Failed to register push token:", e);
              }
            });

            await PushNotifications.addListener("registrationError", (error) => {
              console.error("Push Registration Error: " + error.error);
            });

            // Both listeners are attached; now ask for the token.
            await PushNotifications.register();
          } else {
            console.warn(
              "Push Notification permissions denied by user.",
            );
            return; // They denied, don't enable it internally
          }
        } catch (err: any) {
          if (err?.message?.includes('FirebaseApp is not initialized')) {
            console.error('Push Setup Failed: Missing google-services.json file for Android. Please check the Developer console documentation on initializing FirebaseApp for Capacitor Push Notifications.');
          } else {
            console.error("Push Setup Failed: " + (err?.message || String(err)));
          }
          return;
        }
      } else {
        // Web push on main's /api/push through the phone's own worker
        // (public/sw.js, scope /). That worker only shows notifications
        // and never messages the page — an earlier one was pulled
        // because the app misread its events as live activity.
        try {
          setPushError(null);
          await subscribeWebPush();
        } catch (err) {
          setPushError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
    } else if (!Capacitor.isNativePlatform()) {
      // Drop this browser's subscription on main too, not just the flag.
      try { await unsubscribeWebPush(); } catch { /* the flag still flips */ }
    }

    onSettingsChange({ pushNotificationsEnabled: isEnabling });
  };

  // Center-crop to a square and downscale so the avatar stays a few KB in
  // the synced settings blob instead of a full camera-roll image.
  const downscaleAvatar = (dataUrl: string, size = 192): Promise<string> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const s = Math.min(img.width, img.height);
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });

  const handleImageUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    target: "single" | "lockscreen" | "avatar" | number,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCropTarget(target);
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      if (result && result.startsWith("data:image/")) {
        setCropImageSrc(result);
      }
    };
    // Reset input
    e.target.value = "";
  };

  const onCropComplete = useCallback(
    (croppedArea: any, croppedAreaPixels: any) => {
      setCroppedAreaPixels(croppedAreaPixels);
    },
    [],
  );

  const handleSaveCrop = async () => {
    if (!cropImageSrc || !croppedAreaPixels || isSaving) return;
    setIsSaving(true);
    try {
      const croppedImage = await getCroppedImg(
        cropImageSrc,
        croppedAreaPixels,
        0,
        { horizontal: false, vertical: false },
        2048,
      );
      saveImageResult(croppedImage);
      setCropImageSrc(null);
    } catch (e) {
      console.error("Failed to crop image:", e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUseOriginal = () => {
    if (!cropImageSrc || isSaving) return;
    saveImageResult(cropImageSrc);
    setCropImageSrc(null);
  };

  const saveImageResult = (imageUrl: string) => {
    if (cropTarget === "avatar") {
      // Downscale after the crop so the synced settings blob stays light.
      downscaleAvatar(imageUrl)
        .then((a) => onSettingsChange({ userAvatar: a }))
        .catch(() => onSettingsChange({ userAvatar: imageUrl }));
    } else if (cropTarget === "single") {
      onThemeChange({ wallpaper: imageUrl });
    } else if (cropTarget === "lockscreen") {
      onThemeChange({ lockScreenWallpaper: imageUrl });
    } else {
      const currentWallpapers = [...(theme.wallpapers || [])];
      currentWallpapers[cropTarget as number] = imageUrl;
      onThemeChange({ wallpapers: currentWallpapers.filter(Boolean) });
    }
  };

  const removeSlideshowImage = (index: number) => {
    const currentWallpapers = [...(theme.wallpapers || [])];
    currentWallpapers.splice(index, 1);
    onThemeChange({ wallpapers: currentWallpapers });
  };

  const handleColorSelect = (themeId: ThemeId) => {
    if (themeId === "custom" && !theme.customColors) {
      onThemeChange({
        id: themeId,
        customColors: {
          light: {
            pageBg: "#F4F4F5",
            panelBg: "#FFFFFF",
            panelBorder: "#E4E4E7",
            textMain: "#18181B",
            textMuted: "#71717A",
            userBubbleBg: "#A1A1AA99",
            userBubbleText: "#000000",
            compBubbleBg: "#E4E4E799",
            compBubbleText: "#000000",
            accent: "#18181B",
            accentText: "#18181B",
          },
          dark: {
            pageBg: "#09090B",
            panelBg: "#18181B",
            panelBorder: "#27272A",
            textMain: "#FAFAFA",
            textMuted: "#A1A1AA",
            userBubbleBg: "#52525B99",
            userBubbleText: "#FFFFFF",
            compBubbleBg: "#27272A99",
            compBubbleText: "#FFFFFF",
            accent: "#FAFAFA",
            accentText: "#FAFAFA",
          },
        },
      });
    } else {
      onThemeChange({ id: themeId });
    }
  };

  const isColorSelected = (themeId: ThemeId) => {
    return theme.id === themeId;
  };

  return (
    <AppShell
      title="Settings"
      icon={SettingsIcon}
      onClose={onClose}
      themeConfig={activeTheme}
      themeMode={theme.mode}
    >
      <div>
        {cropImageSrc && (
          <div
            className="fixed left-0 right-0 bottom-0 z-[60] bg-black/95 backdrop-blur-xl flex items-center justify-center p-4"
            style={{ top: 'calc(var(--sat, 0px) + 3.25rem)' }}
          >
            <div
              className={cn(
                "w-full max-w-sm flex flex-col gap-4 overflow-hidden border shadow-2xl",
                activeTheme.radius,
                colors.panelBg,
                colors.panelBorder,
              )}
            >
              <div className={cn("p-4 border-b flex items-center justify-between", colors.panelBorder)}>
                <h3 className={cn("text-[10px] font-bold uppercase tracking-widest", colors.textMuted)}>
                  Position Image
                </h3>
                <button
                  onClick={() => setCropImageSrc(null)}
                  className={cn("p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10", colors.textMain)}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="relative flex items-center justify-center bg-black/40 cursor-move h-96">
                <Cropper
                  image={cropImageSrc}
                  crop={crop}
                  zoom={zoom}
                  // minZoom=1 means the image always at least fills the crop
                  // area — preventing the empty white bars that appeared when
                  // you could zoom out smaller than the frame. Paired with
                  // restrictPosition=true so the image edge can't be dragged
                  // past the crop edge either.
                  minZoom={1}
                  maxZoom={10}
                  aspect={cropTarget === "avatar" ? 1 : 9 / 16}
                  cropShape={cropTarget === "avatar" ? "round" : "rect"}
                  onCropChange={setCrop}
                  onCropComplete={onCropComplete}
                  onZoomChange={setZoom}
                  showGrid={true}
                  restrictPosition={true}
                />
                <div className="absolute bottom-2 left-0 right-0 flex justify-center pointer-events-none">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-white/80 bg-black/50 px-2 py-1 rounded-full">
                    Drag to Position • Pinch to Zoom
                  </span>
                </div>
              </div>

              <div className="p-5 flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center px-1">
                    <span className={cn("text-[10px] font-bold uppercase tracking-wider", colors.textMuted)}>
                      Scale & Placement
                    </span>
                    <span className={cn("text-[10px] font-mono", colors.textMuted)}>
                      {Math.round(zoom * 100)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-4 px-1">
                    <Minus size={14} className={colors.textMuted} />
                    <input
                      type="range"
                      value={zoom}
                      min={0.1}
                      max={10}
                      step={0.1}
                      aria-labelledby="Zoom"
                      onChange={(e) => setZoom(Number(e.target.value))}
                      className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-black/10 dark:bg-white/10"
                      style={{ accentColor: colors.accent }}
                    />
                    <Plus size={14} className={colors.textMuted} />
                  </div>
                </div>

                <div className="flex justify-end gap-2 items-center">
                  <button
                    onClick={() => setCropImageSrc(null)}
                    className={cn("px-4 py-2 text-[10px] font-bold uppercase tracking-widest transition-colors opacity-60 hover:opacity-100", colors.textMuted)}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUseOriginal}
                    disabled={isSaving}
                    className={cn(
                      "px-4 py-2 text-[10px] font-bold uppercase tracking-widest border rounded-full transition-all active:scale-95 hover:bg-black/5 dark:hover:bg-white/10",
                      colors.panelBorder,
                      colors.textMain,
                      isSaving && "opacity-50 pointer-events-none",
                    )}
                  >
                    Use Full Image
                  </button>
                  <button
                    onClick={handleSaveCrop}
                    disabled={isSaving}
                    className={cn(
                      "flex items-center gap-2 px-6 py-2.5 text-[10px] font-bold uppercase tracking-widest rounded-full transition-all active:scale-95 shadow-lg",
                      isSaving ? "opacity-50 cursor-not-allowed" : "hover:opacity-90",
                    )}
                    style={{
                      background: colors.accent,
                      color: 'var(--bytelight-on-accent)',
                    }}
                  >
                    {isSaving ? (
                      <Upload size={14} className="animate-pulse" />
                    ) : (
                      <Check size={14} />
                    )}
                    {isSaving ? "Processing..." : "Apply Crop"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Matches the pill-tab style used by Agent / Integrations /
            Status / Packs so all wrapper apps share the same visual
            grammar for tab navigation. */}
        <div className={cn("p-3 rounded-2xl border backdrop-blur-md mb-4 flex justify-center", colors.panelBg, colors.panelBorder)}>
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          {(["appearance", "profiles", "data"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border capitalize",
                colors.panelBorder,
                activeTab !== tab && cn(colors.panelBg, colors.textMain),
              )}
              style={
                activeTab === tab
                  ? {
                      background: resolvedAccent,
                      color: 'var(--bytelight-on-accent)',
                      borderColor: resolvedAccent
                    }
                  : undefined
              }
            >
              {tab}
            </button>
          ))}
          </div>
        </div>

        {/* No inner scroll container — AppShell already provides the
            scrollable body, so tabs scroll with content the way Agent /
            Integrations / Status do, instead of being pinned. */}
        <div className="space-y-8">
          {activeTab === "appearance" && (
            <>
              {/* Live Preview — BL's appearance panel, first thing: the vibe
                  check. Bubbles + buttons drawn with the live theme/skin. */}
              <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <div className="flex items-center justify-between">
                  <h3 className={cn("micro-label", colors.accentText)}>Live Preview</h3>
                  <span className="h-2 w-2 rounded-full" style={{ background: resolvedAccent }} />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-start">
                    <div data-user="false" className={cn("bytelight-message-bubble border px-3.5 py-2 rounded-[var(--shape-bubble)] rounded-tl-none text-[13px]", colors.compBubbleBg, colors.compBubbleText, colors.panelBorder)}>
                      How's the vibe looking?
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <div data-user="true" className={cn("bytelight-message-bubble border px-3.5 py-2 rounded-[var(--shape-bubble)] rounded-tr-none text-[13px]", colors.userBubbleBg, colors.userBubbleText, colors.panelBorder)}>
                      Cosmic. ✨
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button className="bytelight-on-accent rounded-full px-4 py-1.5 text-[12px] font-bold" style={{ background: resolvedAccent }}>
                    Primary
                  </button>
                  <button className={cn("rounded-full border px-4 py-1.5 text-[12px] font-bold", colors.panelBorder, colors.textMain)}>
                    Ghost
                  </button>
                </div>
              </section>

              {/* Appearance Mode */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={() => onThemeChange({ mode: "light" })}
                    className={cn(
                      "flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl border transition-all duration-500",
                      theme.mode === "light"
                        ? `border-transparent scale-105`
                        : `${colors.panelBg} ${colors.panelBorder} ${colors.accentText} hover:opacity-80`,
                    )}
                    style={
                      theme.mode === "light"
                        ? {
                            backgroundColor:
                              theme.id === "monochrome" || theme.id === "custom"
                                ? "#000000"
                                : THEMES[theme.id].light.accent,
                            color: "#FFFFFF",
                          }
                        : undefined
                    }
                  >
                    <Sun size={16} strokeWidth={1.5} />
                    <span className="text-[11px] font-bold uppercase tracking-widest">
                      Daylight
                    </span>
                  </button>
                  <button
                    onClick={() => onThemeChange({ mode: "dark" })}
                    className={cn(
                      "flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl border transition-all duration-500",
                      theme.mode === "dark"
                        ? `border-transparent scale-105`
                        : `${colors.panelBg} ${colors.panelBorder} ${colors.accentText} hover:opacity-80`,
                    )}
                    style={
                      theme.mode === "dark"
                        ? {
                            backgroundColor:
                              theme.id === "monochrome" || theme.id === "custom"
                                ? "#FFFFFF"
                                : THEMES[theme.id].dark.accent,
                            color: "#000000",
                          }
                        : undefined
                    }
                  >
                    <Moon size={16} strokeWidth={1.5} />
                    <span className="text-[11px] font-bold uppercase tracking-widest">
                      Midnight
                    </span>
                  </button>
                </div>
              </section>

              {/* Skin — BL: the atmosphere layer, its own section */}
              <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>Skin</h3>
                <div className="flex gap-2">
                  {([
                    { id: "none", label: "Classic" },
                    { id: "cosmos", label: "Cosmos" },
                  ] as const).map((sk) => {
                    const active = (theme.skin ?? "none") === sk.id;
                    return (
                      <button
                        key={sk.id}
                        onClick={() => onThemeChange({ skin: sk.id })}
                        className={cn(
                          "rounded-full border px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition-all duration-300",
                          colors.panelBorder,
                          active ? cn(colors.accentText, "shadow-md") : cn(colors.textMuted, "opacity-70 hover:opacity-100"),
                        )}
                        style={active ? { background: resolvedAccent + "33" } : undefined}
                      >
                        {sk.label}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Accent Color — BL's own section: Custom picker, Use palette,
                  and the sixteen named accents (ACCENT_PALETTES, verbatim). */}
              <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>Accent Color</h3>
                <div className="flex items-center gap-2">
                  <label className={cn("flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold", colors.panelBorder, colors.textMain)}>
                    <span className="relative h-5 w-5 overflow-hidden rounded-md border border-white/20" style={{ background: theme.accentOverride || resolvedAccent }}>
                      <input
                        type="color"
                        value={theme.accentOverride || resolvedAccent}
                        onChange={(e) => onThemeChange({ accentOverride: e.target.value, accentPalette: null })}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </span>
                    Custom
                  </label>
                  {(theme.accentOverride || theme.accentPalette) && (
                    <button
                      onClick={() => onThemeChange({ accentOverride: null, accentPalette: null })}
                      className={cn("rounded-full border px-3 py-1.5 text-[11px] font-semibold opacity-80 hover:opacity-100", colors.panelBorder, colors.textMuted)}
                    >
                      Use palette
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-3 pt-1">
                  {ACCENT_PALETTES.map((p) => {
                    const active = theme.accentPalette === p.name && !theme.accentOverride;
                    const swatch = p[theme.mode].main;
                    return (
                      <button
                        key={p.name}
                        onClick={() => onThemeChange({ accentPalette: p.name, accentOverride: null })}
                        className="flex flex-col items-center gap-1"
                        title={p.name}
                      >
                        <span
                          className={cn("h-9 w-9 rounded-full border-2 transition-all", active ? "scale-110 border-white/70" : "border-transparent opacity-85 hover:opacity-100")}
                          style={{ background: swatch, boxShadow: active ? `0 0 14px ${swatch}88` : undefined }}
                        />
                        <span className={cn("text-[9px] font-semibold uppercase tracking-wide", active ? colors.textMain : colors.textMuted)}>
                          {p.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Typography — BL's five presets, each label wearing its
                  own heading face */}
              <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>Typography</h3>
                <div className="flex flex-wrap gap-2">
                  {TYPOGRAPHY_PRESETS.map((t) => {
                    const active = theme.typography === t.name;
                    return (
                      <button
                        key={t.name}
                        onClick={() => onThemeChange({ typography: active ? null : t.name })}
                        className={cn(
                          "rounded-xl border px-3 py-2 text-[12px] transition-all",
                          colors.panelBorder,
                          active ? cn(colors.textMain, "shadow-md") : cn(colors.textMuted, "opacity-80 hover:opacity-100"),
                        )}
                        style={{
                          fontFamily: fontStack(t.heading),
                          background: active ? resolvedAccent + "22" : undefined,
                          borderColor: active ? resolvedAccent : undefined,
                        }}
                        title={`${t.heading} / ${t.body} / ${t.mono}`}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
                <p className={cn("text-[10px]", colors.textMuted)}>
                  Tap again to hand fonts back to the skin.
                </p>
              </section>

              {/* Layout — BL: Roundness */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>Layout</h3>
                <div className="flex items-center justify-between">
                  <span className={cn("text-[12px] font-semibold", colors.textMain)}>Roundness</span>
                  <span className={cn("text-[11px]", colors.textMuted)}>
                    {(theme.shapeRadius ?? themeRadiusPx(activeTheme.radius)) <= 6 ? "Sharp" : (theme.shapeRadius ?? themeRadiusPx(activeTheme.radius)) >= 18 ? "Round" : "Soft"}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={24}
                  step={2}
                  value={theme.shapeRadius ?? themeRadiusPx(activeTheme.radius)}
                  onChange={(e) => onThemeChange({ shapeRadius: Number(e.target.value) })}
                  className="w-full cursor-pointer"
                  style={{ accentColor: resolvedAccent }}
                />
              </section>

              {/* Effects — BL: Aura & Glow shape the Cosmos skin; Motion
                  scales its transitions. 100% = default. */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>Effects</h3>
                <p className={cn("text-[11px]", colors.textMuted)}>
                  Aura &amp; Glow shape the Cosmos skin. 100% = default.
                </p>
                {([
                  { key: "aura", label: "Aura" },
                  { key: "glow", label: "Glow" },
                  { key: "motion", label: "Motion" },
                ] as const).map((fx) => (
                  <div key={fx.key} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className={cn("text-[12px] font-semibold", colors.textMain)}>{fx.label}</span>
                      <span className={cn("text-[11px]", colors.textMuted)}>{theme.fx?.[fx.key] ?? 100}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={10}
                      value={theme.fx?.[fx.key] ?? 100}
                      onChange={(e) => onThemeChange({ fx: { ...theme.fx, [fx.key]: Number(e.target.value) } })}
                      className="w-full cursor-pointer"
                      style={{ accentColor: resolvedAccent }}
                    />
                  </div>
                ))}
                <button
                  onClick={() => onThemeChange({ fx: { aura: 100, glow: 100, motion: 100 } })}
                  className="text-[10px] font-bold uppercase tracking-widest opacity-80 transition-colors hover:opacity-100"
                  style={{ color: resolvedAccent }}
                >
                  Reset to defaults
                </button>
              </section>


              {/* Your Avatar — the owner's bubble face + ring color, the
                  user-side counterpart of the companion voice avatars */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>
                  Your Avatar
                </h3>
                <div className="flex items-center gap-4">
                  <div
                    className="w-14 h-14 rounded-full overflow-hidden border-2 flex items-center justify-center shrink-0"
                    style={{
                      borderColor: appSettings.userAvatarColor || "transparent",
                      background: "rgba(127,127,127,0.15)",
                    }}
                  >
                    {appSettings.userAvatar ? (
                      <img src={appSettings.userAvatar} alt="Your avatar" className="w-full h-full object-cover" />
                    ) : (
                      <UserRound size={24} className="opacity-50" />
                    )}
                  </div>
                  <div className="flex flex-col gap-2 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => avatarInputRef.current?.click()}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-widest",
                          colors.panelBg, colors.panelBorder, colors.accentText, "hover:opacity-80",
                        )}
                      >
                        <Upload size={12} strokeWidth={2} />
                        Upload
                      </button>
                      {appSettings.userAvatar && (
                        <button
                          onClick={() => onSettingsChange({ userAvatar: undefined })}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-widest opacity-70",
                            colors.panelBg, colors.panelBorder, colors.textMain, "hover:opacity-100",
                          )}
                        >
                          <Trash2 size={12} strokeWidth={2} />
                          Remove
                        </button>
                      )}
                    </div>
                    <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest cursor-pointer">
                      <span className={cn(colors.textMuted)}>Ring color</span>
                      <input
                        type="color"
                        value={appSettings.userAvatarColor || "#f97316"}
                        onChange={(e) => onSettingsChange({ userAvatarColor: e.target.value })}
                        className="h-6 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
                      />
                    </label>
                  </div>
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleImageUpload(e, "avatar")}
                />
              </section>

              {/* Accent Color */}
              <section className={cn("space-y-6 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>
                  Palette
                </h3>
                <div className="flex flex-wrap justify-center gap-4 sm:gap-6">
                  {(
                    [
                      "burgundy",
                      "crimson",
                      "orange",
                      "forest",
                      "emerald",
                      "teal",
                      "ocean",
                      "sky",
                      "cobalt",
                      "sapphire",
                      "lavender",
                      "cosmos",
                      "plum",
                      "blush",
                      "rose",
                      "magenta",
                      "mocha",
                      "monochrome",
                      "custom",
                    ] as ThemeId[]
                  ).map((themeId, index) => {
                    const t = THEMES[themeId];
                    const isSelected = isColorSelected(themeId);
                    const swatchColor =
                      themeId === "custom"
                        ? theme.customColors?.[theme.mode]?.accent || "#888888"
                        : t[theme.mode].accent;

                    return (
                      <button
                        key={themeId}
                        onClick={() => handleColorSelect(themeId)}
                        className={cn(
                          "group relative flex flex-col items-center gap-3 transition-all duration-500 w-[calc(25%-12px)] sm:w-[calc(16.666%-20px)]",
                          isSelected
                            ? "scale-110"
                            : "opacity-60 hover:opacity-100",
                        )}
                      >
                        <div
                          className={cn(
                            "w-12 h-12 rounded-full border-2 transition-all duration-500 flex items-center justify-center",
                            isSelected
                              ? "border-current"
                              : "border-transparent",
                          )}
                          style={{
                            backgroundColor: swatchColor,
                            borderColor: isSelected
                              ? theme.mode === "light"
                                ? "#FFFFFF"
                                : "#000000"
                              : "transparent",
                            boxShadow: isSelected
                              ? `0 0 25px ${swatchColor}40`
                              : undefined,
                          }}
                        >
                          {isSelected && (
                            <Check
                              size={18}
                              strokeWidth={3}
                              className="bytelight-on-accent"
                            />
                          )}
                        </div>
                        <span
                          className={cn(
                            "text-[9px] font-bold uppercase tracking-widest transition-all duration-300",
                            isSelected
                              ? colors.accentText
                              : cn(
                                  colors.accentText,
                                  "brightness-75 opacity-70",
                                ),
                          )}
                        >
                          {t.name}
                        </span>
                      </button>
                    );
                  })}
                </div>

              </section>

              {/* Custom Theme Editor */}
              {theme.id === "custom" && (
                <section
                  className={cn(
                    "space-y-4 p-4 rounded-2xl border",
                    colors.panelBorder,
                    colors.panelBg,
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h3 className={cn("micro-label", colors.accentText)}>
                      Custom Theme Builder ({theme.mode} mode)
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          onThemeChange({
                            customColors: {
                              light: {
                                pageBg: "#F4F4F5",
                                panelBg: "#FFFFFF",
                                panelBorder: "#E4E4E7",
                                textMain: "#18181B",
                                textMuted: "#71717A",
                                userBubbleBg: "#A1A1AA99",
                                userBubbleText: "#000000",
                                compBubbleBg: "#E4E4E799",
                                compBubbleText: "#000000",
                                accent: "#18181B",
                                accentText: "#18181B",
                              },
                              dark: {
                                pageBg: "#09090B",
                                panelBg: "#18181B",
                                panelBorder: "#27272A",
                                textMain: "#FAFAFA",
                                textMuted: "#A1A1AA",
                                userBubbleBg: "#52525B99",
                                userBubbleText: "#FFFFFF",
                                compBubbleBg: "#27272A99",
                                compBubbleText: "#FFFFFF",
                                accent: "#FAFAFA",
                                accentText: "#FAFAFA",
                              },
                            },
                          });
                        }}
                        className={cn(
                          "text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-full border transition-colors",
                          colors.panelBorder,
                          colors.textMuted,
                          "hover:opacity-80",
                        )}
                      >
                        Reset
                      </button>
                      <button
                        onClick={onClose}
                        className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-full transition-colors"
                        style={{
                          backgroundColor: 'var(--bytelight-text)',
                          color: 'var(--bytelight-page)',
                        }}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {[
                      { key: "pageBg", label: "Page Background" },
                      { key: "panelBg", label: "Panel Background" },
                      { key: "panelBorder", label: "Panel Border" },
                      { key: "textMain", label: "Main Text" },
                      { key: "textMuted", label: "Muted Text" },
                      { key: "userBubbleBg", label: "User Bubble Background" },
                      { key: "userBubbleText", label: "User Bubble Text" },
                      {
                        key: "compBubbleBg",
                        label: "Companion Bubble Background",
                      },
                      { key: "compBubbleText", label: "Companion Bubble Text" },
                      { key: "accent", label: "Accent Background" },
                      { key: "accentText", label: "Accent Text Color" },
                    ].map(({ key, label }) => {
                      const currentColor =
                        theme.customColors?.[theme.mode]?.[key] || "#000000";
                      const isValidHex = /^#[0-9A-F]{6}$/i.test(currentColor);
                      const colorPickerValue = isValidHex
                        ? currentColor
                        : "#000000";

                      return (
                        <div
                          key={key}
                          className="flex items-center justify-between"
                        >
                          <span className={cn("text-xs", colors.textMain)}>
                            {label}
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={currentColor}
                              onChange={(e) => {
                                const newColors = {
                                  ...theme.customColors,
                                  [theme.mode]: {
                                    ...(theme.customColors?.[theme.mode] || {}),
                                    [key]: e.target.value,
                                  },
                                };
                                if (!newColors.light) newColors.light = {};
                                if (!newColors.dark) newColors.dark = {};
                                onThemeChange({
                                  customColors: newColors as any,
                                });
                              }}
                              className={cn(
                                "text-[10px] font-mono bg-transparent border-none w-16 focus:outline-none text-center",
                                colors.textMuted,
                                colors.panelBorder,
                              )}
                            />
                            <input
                              type="color"
                              value={colorPickerValue}
                              onChange={(e) => {
                                const newColors = {
                                  ...theme.customColors,
                                  [theme.mode]: {
                                    ...(theme.customColors?.[theme.mode] || {}),
                                    [key]: e.target.value,
                                  },
                                };
                                // Ensure both modes exist
                                if (!newColors.light) newColors.light = {};
                                if (!newColors.dark) newColors.dark = {};
                                onThemeChange({
                                  customColors: newColors as any,
                                });
                              }}
                              className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Sticky Note Colors */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <div className="flex items-center justify-between">
                  <h3 className={cn("micro-label", colors.accentText)}>
                    Sticky Note Colors
                  </h3>
                  <button
                    onClick={() => {
                      // Clear the override rather than writing five fixed
                      // colours back over it, so the notes follow the theme.
                      onThemeChange({ stickyNoteColors: undefined });
                    }}
                    className={cn(
                      "text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border opacity-70 hover:opacity-100 transition-opacity",
                      colors.textMain,
                      colors.panelBorder,
                    )}
                  >
                    Use theme colors
                  </button>
                </div>
                <div className="flex items-center justify-center gap-3">
                  {shownNoteColors.map((color, index) => (
                    <div key={index} className="relative group">
                      <div
                        className={cn(
                          "w-10 h-10 rounded-lg border flex items-center justify-center overflow-hidden",
                          colors.panelBorder,
                        )}
                        style={{ backgroundColor: color }}
                      >
                        <input
                          type="color"
                          value={color}
                          onChange={(e) => {
                            // Start from what is on screen, which is the
                            // theme's own set until she overrides one.
                            const newColors = [...shownNoteColors];
                            newColors[index] = e.target.value;
                            onThemeChange({ stickyNoteColors: newColors });
                          }}
                          className="absolute inset-0 w-[200%] h-[200%] -top-1/2 -left-1/2 cursor-pointer opacity-0"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* App Identity */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>
                  App Identity
                </h3>
                <div className="flex flex-col gap-6">
                  <div className="flex items-center gap-4 sm:gap-6">
                    <div
                      className="w-16 h-16 sm:w-20 sm:h-20 rounded-[20px] sm:rounded-[24px] flex items-center justify-center transition-all duration-500 shrink-0"
                      style={{ backgroundColor: colors.accent }}
                    >
                      <Smartphone
                        className="bytelight-on-accent w-8 h-8 sm:w-10 sm:h-10"
                        strokeWidth={1.5}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={appSettings.osName ?? ""}
                        onChange={(e) =>
                          onSettingsChange({ osName: e.target.value })
                        }
                        className={cn(
                          "bytelight-field w-full rounded-xl px-3 py-2 focus:outline-none text-lg italic tracking-tight mb-1",
                          colors.textMain,
                        )}
                        placeholder="e.g. Bytelight OS"
                      />
                      <p
                        className={cn(
                          "text-[10px] sm:text-[11px] leading-relaxed font-medium break-words whitespace-normal text-left",
                          colors.textMuted,
                        )}
                      >
                        Your personal OS name.
                      </p>
                    </div>
                  </div>

                  <div className="pt-4">
                    <h3 className={cn("micro-label mb-3", colors.accentText)}>
                      Group Chat Name
                    </h3>
                    <input
                      type="text"
                      value={appSettings.groupChatName ?? ""}
                      onChange={(e) =>
                        onSettingsChange({ groupChatName: e.target.value })
                      }
                      className={cn(
                        "bytelight-field w-full rounded-xl px-3 py-2 focus:outline-none text-sm",
                        colors.textMain,
                      )}
                      placeholder="Bytelight"
                    />
                    <p
                      className={cn(
                        "text-[10px] sm:text-[11px] leading-relaxed font-medium mt-1",
                        colors.textMuted,
                      )}
                    >
                      Appears at the top of your chat interface.
                    </p>
                  </div>

                  <div className="pt-4">
                    <h3 className={cn("micro-label mb-4", colors.accentText)}>
                      System Font
                    </h3>
                    <div className="grid grid-cols-3 gap-3">
                      <button
                        onClick={() =>
                          onSettingsChange({ fontFamily: "font-sans" })
                        }
                        className={cn(
                          "flex items-center justify-center p-4 rounded-[24px] border transition-all duration-500 font-sans",
                          appSettings.fontFamily === "font-sans" ||
                            !appSettings.fontFamily
                            ? "bytelight-on-accent border-transparent scale-105"
                            : `${colors.panelBg} ${colors.panelBorder} ${colors.textMuted} hover:opacity-80`,
                        )}
                        style={
                          appSettings.fontFamily === "font-sans" || !appSettings.fontFamily
                            ? { background: colors.accent, color: 'var(--bytelight-on-accent)' }
                            : undefined
                        }
                      >
                        <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest">
                          Sans
                        </span>
                      </button>
                      <button
                        onClick={() =>
                          onSettingsChange({ fontFamily: "font-serif" })
                        }
                        className={cn(
                          "flex items-center justify-center p-4 rounded-[24px] border transition-all duration-500 font-serif",
                          appSettings.fontFamily === "font-serif"
                            ? "bytelight-on-accent border-transparent scale-105"
                            : `${colors.panelBg} ${colors.panelBorder} ${colors.textMuted} hover:opacity-80`,
                        )}
                        style={
                          appSettings.fontFamily === "font-serif"
                            ? { background: colors.accent, color: 'var(--bytelight-on-accent)' }
                            : undefined
                        }
                      >
                        <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest">
                          Serif
                        </span>
                      </button>
                      <button
                        onClick={() =>
                          onSettingsChange({ fontFamily: "font-mono" })
                        }
                        className={cn(
                          "flex items-center justify-center p-4 rounded-[24px] border transition-all duration-500 font-mono",
                          appSettings.fontFamily === "font-mono"
                            ? "bytelight-on-accent border-transparent scale-105"
                            : `${colors.panelBg} ${colors.panelBorder} ${colors.textMuted} hover:opacity-80`,
                        )}
                        style={
                          appSettings.fontFamily === "font-mono"
                            ? { background: colors.accent, color: 'var(--bytelight-on-accent)' }
                            : undefined
                        }
                      >
                        <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest">
                          Mono
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Send button icon */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>
                  Send Button
                </h3>
                <div className="space-y-3">
                  <p
                    className={cn(
                      "text-[10px] leading-relaxed",
                      colors.textMuted,
                    )}
                  >
                    Choose the icon that sits on the send button in your chat composer.
                  </p>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {SEND_ICONS.map(({ id, label, icon: Icon }) => {
                      const isActive =
                        (appSettings.sendIconId ?? DEFAULT_SEND_ICON_ID) === id;
                      return (
                        <button
                          key={id}
                          onClick={() => onSettingsChange({ sendIconId: id })}
                          className={cn(
                            "flex flex-col items-center justify-center gap-1 p-2.5 rounded-2xl border transition-all duration-300",
                            isActive
                              ? "scale-105"
                              : cn(colors.panelBg, colors.panelBorder, "opacity-70 hover:opacity-100"),
                          )}
                          style={
                            isActive
                              ? {
                                  background: colors.accent,
                                  borderColor: colors.accent,
                                  color: 'var(--bytelight-on-accent)',
                                }
                              : undefined
                          }
                          title={label}
                        >
                          <Icon size={18} strokeWidth={2} />
                          <span className="text-[8px] uppercase tracking-wider font-bold truncate w-full text-center">
                            {label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              {/* Wallpaper */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <div className="flex items-center justify-between">
                  <h3 className={cn("micro-label", colors.accentText)}>
                    Atmosphere
                  </h3>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-[10px] font-bold uppercase tracking-widest",
                        colors.textMuted,
                      )}
                    >
                      Slideshow
                    </span>
                    <Toggle
                      on={!!theme.slideshowEnabled}
                      onClick={() =>
                        onThemeChange({
                          slideshowEnabled: !theme.slideshowEnabled,
                        })
                      }
                      colors={colors}
                      ariaLabel="Toggle slideshow"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-6">
                  {!theme.slideshowEnabled ? (
                    <div className="flex gap-6 items-center">
                      <div
                        className={cn(
                          "w-24 h-32 shrink-0 rounded-[24px] border-2 border-dashed flex items-center justify-center overflow-hidden relative group transition-all duration-500",
                          colors.panelBg,
                          colors.panelBorder,
                          "hover:border-opacity-50",
                        )}
                      >
                        <label className="absolute inset-0 cursor-pointer z-10">
                          <input
                            type="file"
                            onChange={(e) => handleImageUpload(e, "single")}
                            className="hidden"
                            accept="image/*"
                          />
                        </label>
                        {theme.wallpaper ? (
                          <>
                            <img
                              src={theme.wallpaper}
                              className="w-full h-full object-cover opacity-60"
                              alt="Wallpaper"
                            />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Upload size={24} className="text-white" />
                            </div>
                          </>
                        ) : (
                          <ImageIcon
                            size={28}
                            className={colors.textMuted}
                            strokeWidth={1.5}
                          />
                        )}
                      </div>
                      <div className="flex-1 space-y-3">
                        <p
                          className={cn(
                            "text-xs leading-relaxed font-medium text-left",
                            colors.textMuted,
                          )}
                        >
                          Home Screen Background
                        </p>
                        {theme.wallpaper && (
                          <button
                            onClick={() =>
                              onThemeChange({ wallpaper: undefined })
                            }
                            className="text-[10px] font-bold uppercase tracking-widest transition-colors opacity-80 hover:opacity-100"
                            style={{ color: colors.accent }}
                          >
                            Reset Home Screen
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p
                        className={cn(
                          "text-xs leading-relaxed font-medium text-center",
                          colors.textMuted,
                        )}
                      >
                        Home Screen Slideshow (up to 10 images)
                      </p>
                      <div className="grid grid-cols-4 gap-3 pb-2">
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => {
                          const wp = theme.wallpapers?.[index];
                          return (
                            <div
                              key={index}
                              className={cn(
                                "w-full h-28 rounded-[16px] border-2 border-dashed flex items-center justify-center overflow-hidden relative group transition-all duration-500",
                                colors.panelBg,
                                colors.panelBorder,
                                "hover:border-opacity-50",
                                index === 8 ? "col-start-2" : "",
                                index === 9 ? "col-start-3" : "",
                              )}
                            >
                              <label className="absolute inset-0 cursor-pointer z-10">
                                <input
                                  type="file"
                                  onChange={(e) => handleImageUpload(e, index)}
                                  className="hidden"
                                  accept="image/*"
                                />
                              </label>
                              {wp ? (
                                <>
                                  <img
                                    src={wp}
                                    className="w-full h-full object-cover opacity-60"
                                    alt={`Wallpaper ${index + 1}`}
                                  />
                                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity gap-2">
                                    <Upload size={16} className="text-white" />
                                    <button
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        removeSlideshowImage(index);
                                      }}
                                      className={cn(
                                        "bytelight-on-accent p-1 rounded-full relative z-20 hover:scale-110 transition-transform",
                                      )}
                                      style={{ backgroundColor: colors.accent }}
                                    >
                                      <X size={12} />
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <ImageIcon
                                  size={20}
                                  className={colors.textMuted}
                                  strokeWidth={1.5}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Lock screen (ported from Aerie's Settings > Lock screen pane). */}
              {(() => {
                const face = lockFaceOf(theme.lockFace);
                const position = lockPositionOf(theme.lockClockPosition);
                const size = lockSizeOf(theme.lockClockSize);
                const wallpaper = theme.lockScreenWallpaper || theme.wallpaper;
                // Set once this face's clock, or the weather, has been dragged
                // somewhere by hand.
                const movedAt = lockClockAtOf(theme.lockClockAt, face);
                const weatherMoved = lockWeatherAtOf(theme.lockWeatherAt);
                // What has been tucked away; its chip brings it back.
                const hidden = lockHiddenOf(theme.lockHidden);
                const chip = (on: boolean) => cn(
                  "flex items-center justify-center px-3 py-2.5 rounded-2xl border text-[11px] font-bold uppercase tracking-widest transition-all duration-300",
                  on ? "border-transparent" : `${colors.panelBg} ${colors.panelBorder} ${colors.accentText} hover:opacity-80`,
                );
                const chipStyle = (on: boolean) => on ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined;
                const FACES: { id: LockFace; label: string; hint: string }[] = [
                  { id: "stacked", label: "Stacked", hint: "Hour over minute, big" },
                  { id: "dateline", label: "Dateline", hint: "Your picture up top, time along the bottom" },
                  { id: "classic", label: "Classic", hint: "Today's clock, moved and sized your way" },
                ];
                return (<>
                  <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                    <h3 className={cn("micro-label", colors.accentText)}>Lock screen</h3>
                    {/* Its own picture, which falls back to the home wallpaper when unset. */}
                    <div className="flex gap-6 items-center">
                      <div
                        className={cn(
                          "w-24 h-32 shrink-0 rounded-[24px] border-2 border-dashed flex items-center justify-center overflow-hidden relative group transition-all duration-500",
                          colors.panelBg,
                          colors.panelBorder,
                          "hover:border-opacity-50",
                        )}
                      >
                        <label className="absolute inset-0 cursor-pointer z-10">
                          <input
                            type="file"
                            onChange={(e) => handleImageUpload(e, "lockscreen")}
                            className="hidden"
                            accept="image/*"
                          />
                        </label>
                        {theme.lockScreenWallpaper ? (
                          <>
                            <img
                              src={theme.lockScreenWallpaper}
                              className="w-full h-full object-cover opacity-60"
                              alt="Lock Screen Wallpaper"
                            />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Upload size={24} className="text-white" />
                            </div>
                          </>
                        ) : (
                          <ImageIcon
                            size={28}
                            className={colors.textMuted}
                            strokeWidth={1.5}
                          />
                        )}
                      </div>
                      <div className="flex-1 space-y-3">
                        <p
                          className={cn(
                            "text-xs leading-relaxed font-medium text-left",
                            colors.textMuted,
                          )}
                        >
                          Lock Screen Background
                        </p>
                        {theme.lockScreenWallpaper && (
                          <button
                            onClick={() =>
                              onThemeChange({ lockScreenWallpaper: undefined })
                            }
                            className="text-[10px] font-bold uppercase tracking-widest transition-colors opacity-80 hover:opacity-100"
                            style={{ color: colors.accent }}
                          >
                            Reset Lock Screen
                          </button>
                        )}
                      </div>
                    </div>
                  </section>
                  <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                    <h3 className={cn("micro-label", colors.accentText)}>Clock face</h3>
                    <div className="grid grid-cols-3 gap-3">
                      {FACES.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => onThemeChange({ lockFace: f.id })}
                          className="flex flex-col items-center gap-2 text-center"
                          aria-pressed={face === f.id}
                        >
                          <span
                            className="rounded-[18px] p-[3px]"
                            style={{ background: face === f.id ? colors.accent : 'transparent' }}
                          >
                            <LockPreview face={f.id} position={position} size={size} wallpaper={wallpaper} width={88} at={lockClockAtOf(theme.lockClockAt, f.id)} />
                          </span>
                          <span className={chip(face === f.id)} style={chipStyle(face === f.id)}>{f.label}</span>
                          <span className={cn("text-[10px] leading-snug", colors.textMuted)}>{f.hint}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  {/* Holding the clock or the weather on the lock screen moves it,
                      so every face takes a size instead of a Top / Middle / Low
                      row. Each face keeps its own spot. */}
                  <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                    <h3 className={cn("micro-label", colors.accentText)}>Size</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {([["s", "Small"], ["m", "Medium"], ["l", "Large"]] as [LockSize, string][]).map(([id, label]) => (
                        <button key={id} onClick={() => onThemeChange({ lockClockSize: id })} className={chip(size === id)} style={chipStyle(size === id)}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <h3 className={cn("micro-label pt-1", colors.accentText)}>On the lock screen</h3>
                    <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                      Hold the clock or the weather until it lifts, drag it anywhere, and let go. Drag it up to the top to hide it, and tap it here to show it again. Each face remembers where its clock sits; Clock home and Weather home send them back to where they started.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {([["clock", "Clock"], ["weather", "Weather"]] as [LockPiece, string][]).map(([piece, label]) => {
                        const on = !hidden.has(piece);
                        return (
                          <button
                            key={piece}
                            onClick={() => onThemeChange({ lockHidden: withHidden(theme.lockHidden, piece, on) })}
                            className={chip(on)}
                            style={chipStyle(on)}
                            aria-pressed={on}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {(movedAt || weatherMoved) && (
                      <div className="grid grid-cols-2 gap-2">
                        {movedAt && (
                          <button onClick={() => onThemeChange({ lockClockAt: withClockAt(theme.lockClockAt, face, null) })} className={chip(false)}>
                            Clock home
                          </button>
                        )}
                        {weatherMoved && (
                          <button onClick={() => onThemeChange({ lockWeatherAt: undefined })} className={chip(false)}>
                            Weather home
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                  {(() => {
                    const corners = lockShortcutsOf(theme.lockShortcuts);
                    const current = corners[lockCorner];
                    const setCorner = (id: string | null) => {
                      const next: [string | null, string | null] = [corners[0], corners[1]];
                      next[lockCorner] = id;
                      onThemeChange({ lockShortcuts: next });
                    };
                    return (
                      <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                        <h3 className={cn("micro-label", colors.accentText)}>Shortcuts</h3>
                        <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                          Two circles in the bottom corners of the lock screen. Each one opens its app straight away.
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {([[0, "Left corner"], [1, "Right corner"]] as [0 | 1, string][]).map(([c, label]) => (
                            <button key={label} onClick={() => setLockCorner(c)} className={chip(lockCorner === c)} style={chipStyle(lockCorner === c)}>
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => setCorner(null)}
                            className={cn('flex items-center gap-2 px-3 py-2 rounded-xl border text-xs text-left', colors.panelBorder, colors.textMain)}
                            style={current === null ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                          >
                            <span className="flex-1 truncate">Nothing there</span>
                          </button>
                          {[...APPS].filter((a) => a.id !== 'settings').sort((a, b) => a.name.localeCompare(b.name)).map((app) => (
                            <button
                              key={`lock-corner-${app.id}`}
                              onClick={() => setCorner(app.id)}
                              className={cn('flex items-center gap-2 px-3 py-2 rounded-xl border text-xs text-left', colors.panelBorder, colors.textMain)}
                              style={current === app.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                            >
                              <app.icon size={14} />
                              <span className="flex-1 truncate">{app.name}</span>
                            </button>
                          ))}
                        </div>
                      </section>
                    );
                  })()}
                  <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                    <h3 className={cn("micro-label", colors.accentText)}>Who's written you</h3>
                    <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                      A card on the lock screen when there's something new. Names keeps the words off it, for when your phone is face up at work.
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {([["names", "Names"], ["first-line", "First line"], ["nothing", "Nothing"]] as [LockShow, string][]).map(([id, label]) => (
                        <button key={id} onClick={() => onThemeChange({ lockShow: id })} className={chip(lockShowOf(theme.lockShow) === id)} style={chipStyle(lockShowOf(theme.lockShow) === id)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                    <h3 className={cn("micro-label", colors.accentText)}>Spotify</h3>
                    <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                      A card on the lock screen while a song is playing or paused: its cover, the song and the artist, with previous, play or pause, and next. Tap the cover to open Spotify.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {([[true, "On"], [false, "Off"]] as [boolean, string][]).map(([on, label]) => (
                        <button key={label} onClick={() => onThemeChange({ lockSpotify: on })} className={chip(lockSpotifyOf(theme.lockSpotify) === on)} style={chipStyle(lockSpotifyOf(theme.lockSpotify) === on)} aria-pressed={lockSpotifyOf(theme.lockSpotify) === on}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </section>
                  {/* One look for every card on the lock screen. */}
                  <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                    <h3 className={cn("micro-label", colors.accentText)}>Cards</h3>
                    <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                      How the message, note and Spotify cards look on the lock screen. Light suits a light wallpaper, with dark words on it. Auto looks at your wallpaper behind the cards and picks.
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {([["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]] as [LockCardChoice, string][]).map(([id, label]) => (
                        <button key={id} onClick={() => onThemeChange({ lockCards: id })} className={chip(lockCardsOf(theme.lockCards) === id)} style={chipStyle(lockCardsOf(theme.lockCards) === id)} aria-pressed={lockCardsOf(theme.lockCards) === id}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </section>
                </>);
              })()}

              {/* Home widgets. A long press on the home screen
                  opens the same choices. */}
              <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>Widgets</h3>
                <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                  They sit low on your home screen so your wallpaper keeps the top. Holding an empty spot on the home screen opens these too, and holding a widget lets you put it anywhere on the grid.
                </p>
                <div className="space-y-2">
                  {HOME_WIDGETS.map((w) => {
                    const on = homeWidgetsOf(theme.homeWidgets).includes(w.id);
                    return (
                      <button
                        key={`widget-${w.id}`}
                        onClick={() => onThemeChange({ homeWidgets: toggleWidget(homeWidgetsOf(theme.homeWidgets), w.id) })}
                        className={cn('flex w-full items-center justify-between gap-3 px-3 py-2.5 rounded-xl border text-left', colors.panelBorder, colors.textMain)}
                        style={on ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                      >
                        <span className="flex flex-col">
                          <span className="text-xs font-bold">{w.label}</span>
                          <span className="text-[10px] opacity-75">{w.hint}</span>
                        </span>
                        <span className="text-[10px] font-bold tracking-widest">{w.cols}×{w.rows}</span>
                      </button>
                    );
                  })}
                  <button
                    onClick={() => onThemeChange({ homeQuietLine: !theme.homeQuietLine })}
                    className={cn('flex w-full items-center justify-between gap-3 px-3 py-2.5 rounded-xl border text-left', colors.panelBorder, colors.textMain)}
                    style={theme.homeQuietLine ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                  >
                    <span className="flex flex-col">
                      <span className="text-xs font-bold">Quiet line</span>
                      <span className="text-[10px] opacity-75">One line of the latest reply, riding on the dock</span>
                    </span>
                  </button>
                  {theme.homeWidgetSpots && Object.keys(theme.homeWidgetSpots).length > 0 && (
                    <button
                      onClick={() => onThemeChange({ homeWidgetSpots: undefined })}
                      className={cn('flex w-full items-center justify-center px-3 py-2.5 rounded-xl border text-[11px] font-bold uppercase tracking-widest', colors.panelBorder, colors.accentText)}
                    >
                      Put the widgets back
                    </button>
                  )}
                </div>
              </section>

              {/* Dock apps */}
              <section className={cn("space-y-3 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>
                  Home dock
                </h3>
                <p className={cn("text-[10px] leading-relaxed", colors.textMuted)}>
                  Up to 4 apps. The App Drawer launcher is always last.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {[...APPS].filter((a) => a.id !== 'settings').sort((a, b) => a.name.localeCompare(b.name)).map((app) => {
                    const current = migrateAppIds(appSettings.dockAppIds ?? APPS.filter((x) => x.dock).map((x) => x.id));
                    const isOn = current.includes(app.id);
                    const atCap = !isOn && current.length >= 4;
                    return (
                      <button
                        key={`dock-${app.id}`}
                        onClick={() => {
                          if (atCap) return;
                          const next = isOn
                            ? current.filter((id) => id !== app.id)
                            : [...current, app.id];
                          onSettingsChange({ dockAppIds: next });
                        }}
                        disabled={atCap}
                        className={cn(
                          'flex items-center gap-2 px-3 py-2 rounded-xl border text-xs text-left disabled:opacity-40',
                          colors.panelBorder,
                          colors.textMain,
                        )}
                        style={isOn ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                      >
                        <app.icon size={14} />
                        <span className="flex-1 truncate">{app.name}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Apply Settings + Version */}
                <div className="pt-4 flex flex-col items-center gap-3">
                  <button
                    onClick={onClose}
                    className="w-full py-3 rounded-2xl font-bold text-sm transition-all duration-500 hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      backgroundColor: colors.accent,
                      color: 'var(--bytelight-on-accent)',
                    }}
                  >
                    Apply Settings
                  </button>
                  <div
                    className={cn(
                      "text-[10px] font-mono tracking-widest uppercase opacity-40",
                      colors.textMuted,
                    )}
                  >
                    Bytelight v3.2.5
                  </div>
                </div>
              </section>
            </>
          )}



          {activeTab === "profiles" && (
            <ProfilesPanel themeConfig={activeTheme} themeMode={theme.mode} />
          )}

          {activeTab === "data" && (
            <>
              {/* Backend & Worker URLs */}
              <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
                <h3 className={cn("micro-label", colors.accentText)}>
                  Notifications
                </h3>
                <div className="flex items-center justify-between">
                    <div className="text-left">
                      <span
                        className={cn(
                          "block text-sm font-medium",
                          colors.textMain,
                        )}
                      >
                        Push Notifications
                      </span>
                      <span className={cn("text-xs", colors.textMuted)}>
                        {Capacitor.isNativePlatform() || webPushSupported()
                          ? "Get a notification when they write and the app is closed"
                          : "This browser has no web push"}
                      </span>
                    </div>
                    <Toggle
                      on={!!appSettings.pushNotificationsEnabled}
                      onClick={handlePushToggle}
                      colors={colors}
                      ariaLabel="Toggle push notifications"
                    />
                </div>
                {appSettings.pushNotificationsEnabled && (
                  <button
                    onClick={sendPushTest}
                    disabled={pushTestState === "sending"}
                    className={cn("rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60", colors.panelBorder, colors.textMain)}
                  >
                    {pushTestState === "sending" ? "Sending…" : pushTestState === "sent" ? "Sent — check your notifications" : "Send a test notification"}
                  </button>
                )}
                {pushError && (
                  <p className="text-xs" style={{ color: resolvedAccent }}>{pushError}</p>
                )}
              </section>

              {/* Web UI Password — moved from Agent → Models since it's a
                  security setting, not an agent setting. Saves to YAML via
                  the same PUT /api/preferences endpoint PreferencesApp used. */}
              <WebUiPassword themeConfig={activeTheme} themeMode={theme.mode} />

              {/* Setup Sync — explicit send/bring of the whole device setup,
                  extras included. The passive sync covers the big three;
                  this is the deliberate lane for new browsers and the APK. */}
              <SetupSync themeConfig={activeTheme} themeMode={theme.mode} />

              {/* Android shell updates. The version/download routes shipped
                  with the shell and nothing ever called them, so installing a
                  new build meant typing the URL by hand. Stays silent unless
                  the native layer actually moved. */}
              <AppUpdate themeConfig={activeTheme} themeMode={theme.mode} />
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
};
