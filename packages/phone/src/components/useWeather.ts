// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The sky where the phone is, from Open-Meteo, for the lock screen and the
// home widget alike (moved out of LockScreen.tsx).
//
// The card asks for a position the same way the Weather app does: a fix up to
// five minutes old, giving up after twenty seconds. The browser's defaults want
// a brand-new fix and never time out, which left the card waiting while the
// app already had a reading. It also shows the last reading it had at once
// (kept on the phone) while it asks, and asks again when the screen comes back.
import { useEffect, useState } from 'react';
import type { LockWeather } from './LockClock';

const KEPT = 'bytelight.weather.last';
const FRESH_MS = 30 * 60_000;

interface Kept extends LockWeather { at: number }

function readKept(): Kept | null {
  try {
    const raw = localStorage.getItem(KEPT);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Kept;
    return typeof kept?.temp === 'number' && typeof kept?.code === 'number' ? kept : null;
  } catch {
    return null;
  }
}

export function useWeather(): LockWeather | null {
  const [weather, setWeather] = useState<LockWeather | null>(() => readKept());
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    let gone = false;
    const ask = () => {
      const kept = readKept();
      if (kept && Date.now() - kept.at < 60_000) return;
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          try {
            const { latitude, longitude } = position.coords;
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto&temperature_unit=fahrenheit`);
            const data = await res.json();
            if (!data.current_weather) return;
            const high = data.daily?.temperature_2m_max?.[0];
            const low = data.daily?.temperature_2m_min?.[0];
            const next: LockWeather = {
              temp: Math.round(data.current_weather.temperature),
              code: data.current_weather.weathercode,
              isDay: data.current_weather.is_day === 1,
              ...(typeof high === 'number' ? { high: Math.round(high) } : {}),
              ...(typeof low === 'number' ? { low: Math.round(low) } : {}),
            };
            try { localStorage.setItem(KEPT, JSON.stringify({ ...next, at: Date.now() })); } catch { /* full or private: the card still shows it */ }
            if (!gone) setWeather(next);
          } catch (e) {
            console.error('Failed to fetch weather', e);
          }
        },
        (error) => console.error('Geolocation error:', error),
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 5 * 60_000 },
      );
    };
    ask();
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      const kept = readKept();
      if (!kept || Date.now() - kept.at > FRESH_MS || kept.isDay === undefined) ask();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => { gone = true; document.removeEventListener('visibilitychange', onShow); };
  }, []);
  return weather;
}
