import React, { useEffect } from 'react';
import { Activity, RefreshCw, Wifi, WifiOff, Cpu, Clock, AlertTriangle } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import {
  useConnectionState,
  usePresence,
  useContextUsage,
  useRateLimitInfo,
  useThreads,
  useTotalUnread,
  useSystemStatus,
  useLastError,
  requestStatus,
} from '../bytelight';

interface SystemAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// Status colors now use theme accent - see getStatusColor() inside component

export function SystemApp({ onClose, themeConfig, themeMode, embedded }: SystemAppProps) {
  const colors = themeConfig[themeMode];
  const connection = useConnectionState();
  const presence = usePresence();
  const contextUsage = useContextUsage();
  const rateLimit = useRateLimitInfo();
  const threads = useThreads();
  const totalUnread = useTotalUnread();
  const status = useSystemStatus();
  const lastError = useLastError();

  useEffect(() => {
    requestStatus();
    const interval = setInterval(requestStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  const connected = connection === 'connected';

  const card = cn('rounded-2xl border p-4 mb-3', colors.panelBg, colors.panelBorder);
  const label = cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted);
  const value = cn('text-sm font-medium', colors.textMain);

  function row(k: string, v: React.ReactNode) {
    return (
      <div className="flex items-center justify-between py-1.5">
        <span className={cn('text-xs', colors.textMuted)}>{k}</span>
        <span className={value}>{v}</span>
      </div>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="System"
      icon={Activity}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => requestStatus()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      }
    >
      {/* Connection */}
      <div className={card}>
        <div className="flex items-center gap-2 mb-2">
          {connected ? <Wifi size={15} style={{ color: colors.accent }} /> : <WifiOff size={15} style={{ color: colors.accent, opacity: 0.5 }} />}
          <span className={label}>Connection</span>
        </div>
        {row('Socket', <span style={{ color: colors.accent, opacity: connected ? 1 : 0.5 }}>{connection}</span>)}
        {row('Presence', presence)}
        {row('Threads', threads.length)}
        {row('Unread', totalUnread)}
      </div>

      {/* Context usage */}
      {contextUsage && (
        <div className={card}>
          <div className="flex items-center gap-2 mb-2">
            <Cpu size={15} className={colors.textMuted} />
            <span className={label}>Context</span>
          </div>
          <div className="h-2 w-full rounded-full overflow-hidden mb-2" style={{ background: 'rgba(127,127,127,0.2)' }}>
            <div
              className={cn('h-full rounded-full transition-all', contextUsage.percentage >= 95 && 'animate-pulse')}
              style={{
                width: `${Math.min(100, Math.round(contextUsage.percentage))}%`,
                background: colors.accent,
              }}
            />
          </div>
          {row('Used', `${Math.round(contextUsage.percentage)}%`)}
          {row('Tokens', `${contextUsage.tokensUsed.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()}`)}
          {contextUsage.model && row('Model', contextUsage.model)}
          {contextUsage.estimatedCost !== undefined && row('Est. cost', `$${contextUsage.estimatedCost.toFixed(4)}`)}
        </div>
      )}

      {/* Rate limit */}
      {rateLimit && (
        <div className={card} style={{ borderColor: '#f59e0b' }}>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={15} style={{ color: '#f59e0b' }} />
            <span className={label}>Rate Limit</span>
          </div>
          {row('Status', rateLimit.status)}
          {rateLimit.resetsAt && row('Resets', new Date(rateLimit.resetsAt * 1000).toLocaleTimeString())}
        </div>
      )}

      {/* Runtime */}
      {status && (
        <div className={card}>
          <div className="flex items-center gap-2 mb-2">
            <Clock size={15} className={colors.textMuted} />
            <span className={label}>Runtime</span>
          </div>
          {row('Uptime', formatUptime(status.uptime))}
          {row('Memory (RSS)', formatMb(status.memoryUsage.rss))}
          {row('Heap', `${formatMb(status.memoryUsage.heapUsed)} / ${formatMb(status.memoryUsage.heapTotal)}`)}
          {row('Connections', status.connections)}
          {row('Agent', status.agentProcessing ? 'processing' : 'idle')}
        </div>
      )}


      {lastError && (
        <div className={card} style={{ borderColor: colors.accent }}>
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={15} style={{ color: colors.accent }} />
            <span className={label}>Last Error</span>
          </div>
          <p className={cn('text-xs', colors.textMain)}>
            [{lastError.code}] {lastError.message}
          </p>
        </div>
      )}

      {!status && (
        <p className={cn('text-center text-xs py-4', colors.textMuted)}>
          {connected ? 'Loading system status…' : 'Offline — connect to view system status.'}
        </p>
      )}
    </AppShell>
  );
}
