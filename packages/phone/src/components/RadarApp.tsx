// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, Radar, Compass, Mountain } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

interface Companion {
  id: string;
  slug: string;
  display_name: string;
  color: string | null;
}

interface RadarAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  companions: Companion[];
}

interface Blip {
  id: string;
  label: string;
  color: string | null;
  x: number; // 0 to 100 percentage
  y: number; // 0 to 100 percentage
}

export function RadarApp({ onClose, themeConfig, themeMode, companions }: RadarAppProps) {
  const colors = themeConfig[themeMode];

  // Force a brighter accent for the dark radar background on specific light themes
  let radarAccent = colors.accent;
  if (themeMode === 'light') {
    if (themeConfig.id === 'monochrome') radarAccent = '#FFFFFF';
    if (themeConfig.id === 'cobalt') radarAccent = '#A1A1AA'; // Use the dark mode steel accent
  }

  // Generate random starfield
  const stars = useMemo(() => {
    return Array.from({ length: 150 }).map((_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 2 + 0.5,
      opacity: Math.random() * 0.5 + 0.1,
      twinkleDelay: Math.random() * 5
    }));
  }, []);

  // Initialize blips from companions.
  //
  // A useState initializer runs ONCE, at mount. If the companions fetch has not
  // resolved by then the radar seeds itself empty and stays that way forever —
  // much more likely in the native shell, which opens faster than the fetch.
  // Reported upstream. The effect below takes companions arriving late,
  // and keeps the drift position of any blip that is already on screen so the
  // radar does not jump every time the list is refetched.
  const [blips, setBlips] = useState<Blip[]>([]);

  useEffect(() => {
    setBlips((current) => companions.map((c) => {
      const existing = current.find((blip) => blip.id === c.id);
      return {
        id: c.id,
        label: c.display_name,
        color: c.color,
        x: existing ? existing.x : Math.random() * 80 + 10, // 10 to 90
        y: existing ? existing.y : Math.random() * 80 + 10, // 10 to 90
      };
    }));
  }, [companions]);

  const [heading, setHeading] = useState<number | null>(null);
  const [altitude, setAltitude] = useState<number | null>(null);
  const [simulatedHeading, setSimulatedHeading] = useState(0);

  // Simulate subtle movement
  useEffect(() => {
    const interval = setInterval(() => {
      setBlips(current => {
        return current.map(blip => {
          // Very subtle drift
          const dx = (Math.random() - 0.5) * 2;
          const dy = (Math.random() - 0.5) * 2;
          return {
            ...blip,
            x: Math.max(10, Math.min(90, blip.x + dx)),
            y: Math.max(10, Math.min(90, blip.y + dy)),
          };
        });
      });
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // Sensors for Compass and Altimeter
  useEffect(() => {
    let watchId: number | null = null;

    const handleOrientation = (event: DeviceOrientationEvent) => {
      let alpha = event.alpha;
      // iOS webkit compass heading
      if ((event as any).webkitCompassHeading) {
        alpha = (event as any).webkitCompassHeading;
      }
      if (alpha !== null) {
        setHeading(alpha);
      }
    };

    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', handleOrientation, true);
    }

    if ('geolocation' in navigator) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (position.coords.altitude !== null) {
            setAltitude(Math.round(position.coords.altitude));
          }
        },
        () => {
          // Silently handle geolocation error
        },
        { enableHighAccuracy: true },
      );
    }

    // Simulated slow rotation if no real heading is available
    const simInterval = setInterval(() => {
      setSimulatedHeading(h => (h + 0.2) % 360);
    }, 50);

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
      clearInterval(simInterval);
    };
  }, []);

  const displayHeading = heading !== null ? heading : simulatedHeading;

  return (
    <motion.div
      className={cn("absolute inset-0 z-50 flex flex-col", colors.textMain)}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
    >
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
          <h1 className={cn("text-lg font-semibold", colors.textMain)}>Radar</h1>
        </div>
      </header>

      {/* Map Display */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-6 bg-black">
        {/* Galaxy Starfield Background */}
        <div className="absolute inset-0 overflow-hidden">
          {/* Nebula glow */}
          <div 
            className="absolute inset-0 opacity-30"
            style={{
              background: `radial-gradient(circle at 30% 40%, ${radarAccent}40 0%, transparent 40%), 
                           radial-gradient(circle at 70% 60%, ${radarAccent}20 0%, transparent 50%)`
            }}
          />
          {/* Stars */}
          {stars.map(star => (
            <motion.div
              key={star.id}
              className="absolute rounded-full bg-white"
              style={{
                left: `${star.x}%`,
                top: `${star.y}%`,
                width: `${star.size}px`,
                height: `${star.size}px`,
                opacity: star.opacity,
              }}
              animate={{ opacity: [star.opacity, star.opacity * 2, star.opacity] }}
              transition={{ duration: 3 + Math.random() * 2, repeat: Infinity, delay: star.twinkleDelay }}
            />
          ))}
        </div>

        {/* Instruments Overlay */}
        <div className="absolute top-6 left-6 right-6 flex justify-between items-start z-20 pointer-events-none">
          <div className="flex flex-col gap-1 bg-black/40 backdrop-blur-md p-3 rounded-2xl border border-white/10">
            <div className="flex items-center gap-2 text-white/70 mb-1">
              <Compass className="h-4 w-4" style={{ color: radarAccent }} />
              <span className="text-[10px] font-bold uppercase tracking-widest">Heading</span>
            </div>
            <span className="text-2xl font-light text-white tracking-tighter">
              {Math.round(displayHeading)}°
            </span>
          </div>
          
          <div className="flex flex-col gap-1 bg-black/40 backdrop-blur-md p-3 rounded-2xl border border-white/10 items-end">
            <div className="flex items-center gap-2 text-white/70 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest">Altitude</span>
              <Mountain className="h-4 w-4" style={{ color: radarAccent }} />
            </div>
            <span className="text-2xl font-light text-white tracking-tighter">
              {altitude !== null ? `${altitude}m` : '---'}
            </span>
          </div>
        </div>

        {/* Radar Area */}
        <div 
          className="relative flex aspect-square w-full max-w-md items-center justify-center rounded-full border bg-black/10 backdrop-blur-[2px]"
          style={{ borderColor: `${radarAccent}50` }}
        >
          {/* Compass Ring */}
          <motion.div 
            className="absolute -inset-6 rounded-full border-2 border-dashed opacity-30"
            style={{ borderColor: radarAccent, rotate: -displayHeading }}
          >
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 text-xs font-bold text-white">N</div>
            <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-xs font-bold text-white">S</div>
            <div className="absolute top-1/2 -right-4 -translate-y-1/2 text-xs font-bold text-white">E</div>
            <div className="absolute top-1/2 -left-4 -translate-y-1/2 text-xs font-bold text-white">W</div>
          </motion.div>

          {/* Concentric Rings */}
          <div className="absolute inset-8 rounded-full border opacity-40" style={{ borderColor: radarAccent }} />
          <div className="absolute inset-1/4 rounded-full border opacity-30" style={{ borderColor: radarAccent }} />
          <div className="absolute inset-x-1/2 top-0 bottom-0 w-px opacity-30" style={{ backgroundColor: radarAccent }} />
          <div className="absolute inset-y-1/2 left-0 right-0 h-px opacity-30" style={{ backgroundColor: radarAccent }} />

          {/* Gentle Pulse */}
          <motion.div 
            className="absolute inset-0 rounded-full border-[3px] opacity-0"
            style={{ 
              borderColor: radarAccent,
              boxShadow: `0 0 30px ${radarAccent}60, inset 0 0 30px ${radarAccent}60`
            }}
            animate={{ scale: [0.8, 1.25], opacity: [0, 0.6, 0] }}
            transition={{ repeat: Infinity, duration: 4, ease: "easeOut" }}
          />

          {/* Blips */}
          <AnimatePresence>
            {blips.map(blip => {
              const blipColor = blip.color || radarAccent;
              return (
                <motion.div
                  key={blip.id}
                  className="absolute flex flex-col items-center"
                  style={{ left: `${blip.x}%`, top: `${blip.y}%`, transform: 'translate(-50%, -50%)' }}
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0 }}
                  transition={{ duration: 0.8, type: "spring" }}
                >
                  <div className="relative">
                    <div
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: blipColor }}
                    />
                    <motion.div
                      className="absolute -inset-2 rounded-full opacity-60"
                      style={{
                        backgroundColor: blipColor,
                        boxShadow: `0 0 10px ${blipColor}`
                      }}
                      animate={{ scale: [1, 2.5], opacity: [0.6, 0] }}
                      transition={{ repeat: Infinity, duration: 2, ease: "easeOut" }}
                    />
                  </div>
                  <span className={cn("mt-2 text-[10px] font-medium tracking-widest uppercase text-white")}>
                    {blip.label}
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Footer Data */}
      <div className={cn("border-t p-5 text-xs z-10", colors.panelBg, colors.panelBorder, colors.textMuted)}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ backgroundColor: colors.accent }} />
            <span>Tracking Active Signals</span>
          </div>
          <span>{blips.length} Connections</span>
        </div>
      </div>
    </motion.div>
  );
}
