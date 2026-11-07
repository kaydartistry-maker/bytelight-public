// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, Cloud, CloudMoon, CloudSun, Moon, Sun, CloudRain, Snowflake, Wind, Droplets, Thermometer, RefreshCw } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

interface WeatherAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface WeatherData {
  current: {
    temp: number;
    code: number;
    windSpeed: number;
    humidity: number;
    feelsLike: number;
    isDay: boolean;
  };
  daily: {
    time: string[];
    code: number[];
    maxTemp: number[];
    minTemp: number[];
  };
  hourly: {
    time: string[];
    temp: number[];
    code: number[];
    isDay: boolean[];
  };
}

export function WeatherApp({ onClose, themeConfig, themeMode }: WeatherAppProps) {
  const colors = themeConfig[themeMode];
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationName, setLocationName] = useState<string>('Current Location');

  const fetchWeather = () => {
    setLoading(true);
    setError(null);
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not supported by your browser.');
      setLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;

          // Try to get city name
      try {
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
        const geoData = await geoRes.json();
        setLocationName(geoData.address.city || geoData.address.town || geoData.address.village || geoData.address.county || 'Current Location');
      } catch (e) {
        console.error('Failed to fetch location name', e);
      }

      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`);
      const data = await res.json();

      if (data.current) {
        setWeather({
          current: {
            temp: Math.round(data.current.temperature_2m),
            code: data.current.weather_code,
            windSpeed: Math.round(data.current.wind_speed_10m),
            humidity: Math.round(data.current.relative_humidity_2m),
            feelsLike: Math.round(data.current.apparent_temperature),
            isDay: data.current.is_day !== 0,
          },
          daily: {
            time: data.daily.time,
            code: data.daily.weather_code,
            maxTemp: data.daily.temperature_2m_max.map(Math.round),
            minTemp: data.daily.temperature_2m_min.map(Math.round),
          },
          hourly: {
            time: data.hourly.time.slice(0, 24),
            temp: data.hourly.temperature_2m.slice(0, 24).map(Math.round),
            code: data.hourly.weather_code.slice(0, 24),
            isDay: (data.hourly.is_day ?? []).slice(0, 24).map((d: number) => d !== 0),
          },
        });
      }
        } catch (e) {
          console.error('Weather lookup failed', e);
          setError('Failed to load weather data.');
        } finally {
          setLoading(false);
        }
      },
      (err) => {
        // GeolocationPositionError.code: 1 denied, 2 unavailable, 3 timeout.
        console.error('Geolocation error:', err);
        let msg = 'Location access denied or unavailable.';
        if (err.code === 1) msg = 'Location permission denied.';
        else if (err.code === 2) msg = 'Location unavailable — device couldn\'t get a fix.';
        else if (err.code === 3) msg = 'Location request timed out.';
        setError(msg);
        setLoading(false);
      },
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 5 * 60_000 },
    );
  };

  useEffect(() => {
    fetchWeather();
  }, []);

  // A clear night is a moon, not a sun, as on the home card, and partly cloudy keeps the sun or the moon behind it.
  const getWeatherIcon = (code: number, className: string = "h-6 w-6", day = true) => {
    if (code <= 1) return day ? <Sun className={cn(className, "text-yellow-400")} /> : <Moon className={cn(className, "text-slate-200")} />;
    if (code === 2) return day ? <CloudSun className={cn(className, "text-yellow-300")} /> : <CloudMoon className={cn(className, "text-slate-200")} />;
    if (code <= 48) return <Cloud className={cn(className, "text-gray-400")} />;
    if (code <= 67 || code >= 80) return <CloudRain className={cn(className, "text-blue-400")} />;
    return <Snowflake className={cn(className, "text-blue-200")} />;
  };

  const getWeatherDescription = (code: number) => {
    if (code === 0) return "Clear sky";
    if (code === 1 || code === 2 || code === 3) return "Partly cloudy";
    if (code === 45 || code === 48) return "Fog";
    if (code >= 51 && code <= 67) return "Rain";
    if (code >= 71 && code <= 77) return "Snow";
    if (code >= 80 && code <= 82) return "Rain showers";
    if (code >= 85 && code <= 86) return "Snow showers";
    if (code >= 95) return "Thunderstorm";
    return "Unknown";
  };

  const formatHour = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: 'numeric' });
  };

  const formatDay = (isoString: string, index: number) => {
    if (index === 0) return 'Today';
    const date = new Date(isoString + 'T00:00:00'); // Ensure local timezone parsing
    return date.toLocaleDateString([], { weekday: 'short' });
  };

  return (
    <motion.div
      className={cn("absolute inset-0 z-50 flex flex-col", colors.textMain)}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
    >
      <style>{`
        .weather-scrollbar::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .weather-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .weather-scrollbar::-webkit-scrollbar-thumb {
          background-color: ${colors.accent};
          border-radius: 10px;
          opacity: 0.5;
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
          <h1 className={cn("text-lg font-semibold", colors.textMain)}>Weather</h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchWeather}
            className={cn("p-2 rounded-full transition-colors", colors.textMuted, "hover:bg-black/10 dark:hover:bg-white/10")}
            disabled={loading}
          >
            <RefreshCw size={18} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="bytelight-app-body flex-1 overflow-y-auto p-6 pb-24 weather-scrollbar">
        {loading && !weather ? (
          <div className="flex flex-col items-center justify-center h-full opacity-50">
            <RefreshCw className="h-8 w-8 animate-spin mb-4" />
            <p>Fetching local weather...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full opacity-70 text-center">
            <CloudRain className="h-12 w-12 mb-4 opacity-50" />
            <p className="mb-4">{error}</p>
            <button 
              onClick={fetchWeather}
              className={cn("px-4 py-2 rounded-[var(--shape-control)] text-sm font-medium", colors.panelBg, colors.panelBorder, "border")}
            >
              Try Again
            </button>
          </div>
        ) : weather ? (
          <div className="flex flex-col gap-6 max-w-md mx-auto">
            {/* Current Weather */}
            <div className={cn("flex flex-col items-center text-center p-6 rounded-3xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
              <h2 className="text-2xl font-light tracking-tight mb-2">{locationName}</h2>
              <div className="flex items-center justify-center mb-2">
                {getWeatherIcon(weather.current.code, "h-16 w-16 mr-4", weather.current.isDay)}
                <span className="text-7xl font-light tracking-tighter">{weather.current.temp}°</span>
              </div>
              <p className="text-xl font-medium opacity-80">{getWeatherDescription(weather.current.code)}</p>
              <p className="text-sm opacity-60 mt-1">H:{weather.daily.maxTemp[0]}° L:{weather.daily.minTemp[0]}°</p>
            </div>

            {/* Current Details */}
            <div className={cn("grid grid-cols-3 gap-4 p-4 rounded-3xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
              <div className="flex flex-col items-center">
                <Thermometer className="h-5 w-5 mb-1 opacity-60" />
                <span className="text-xs opacity-60 uppercase tracking-wider mb-1">Feels Like</span>
                <span className="font-medium">{weather.current.feelsLike}°</span>
              </div>
              <div className="flex flex-col items-center">
                <Wind className="h-5 w-5 mb-1 opacity-60" />
                <span className="text-xs opacity-60 uppercase tracking-wider mb-1">Wind</span>
                <span className="font-medium">{weather.current.windSpeed} mph</span>
              </div>
              <div className="flex flex-col items-center">
                <Droplets className="h-5 w-5 mb-1 opacity-60" />
                <span className="text-xs opacity-60 uppercase tracking-wider mb-1">Humidity</span>
                <span className="font-medium">{weather.current.humidity}%</span>
              </div>
            </div>

            {/* Hourly Forecast */}
            <div className={cn("p-5 rounded-3xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
              <h3 className="text-xs font-bold uppercase tracking-widest opacity-50 mb-4">Hourly Forecast</h3>
              <div className="flex gap-6 overflow-x-auto pb-2 weather-scrollbar">
                {weather.hourly.time.map((time, i) => {
                  // Only show every 2nd hour to save space, or all if we want
                  if (i % 2 !== 0 && i !== 0) return null;
                  return (
                    <div key={time} className="flex flex-col items-center min-w-[3rem]">
                      <span className="text-xs opacity-70 mb-2">{i === 0 ? 'Now' : formatHour(time)}</span>
                      {getWeatherIcon(weather.hourly.code[i], "h-6 w-6 mb-2", weather.hourly.isDay[i] ?? true)}
                      <span className="font-medium">{weather.hourly.temp[i]}°</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 7-Day Forecast */}
            <div className={cn("p-5 rounded-3xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
              <h3 className="text-xs font-bold uppercase tracking-widest opacity-50 mb-4">7-Day Forecast</h3>
              <div className="flex flex-col gap-4">
                {weather.daily.time.map((time, i) => (
                  <div key={time} className="flex items-center justify-between">
                    <span className="w-16 font-medium">{formatDay(time, i)}</span>
                    <div className="flex-1 flex justify-center">
                      {getWeatherIcon(weather.daily.code[i], "h-5 w-5")}
                    </div>
                    <div className="flex items-center justify-end gap-3 w-24">
                      <span className="opacity-60 text-sm">{weather.daily.minTemp[i]}°</span>
                      <div className="h-1 w-12 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                        <div 
                          className="h-full rounded-full" 
                          style={{ 
                            backgroundColor: colors.accent,
                            width: '100%',
                            opacity: 0.5
                          }} 
                        />
                      </div>
                      <span className="font-medium text-sm">{weather.daily.maxTemp[i]}°</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
