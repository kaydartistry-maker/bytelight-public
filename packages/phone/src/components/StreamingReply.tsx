import React from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { coalesceThinkingSegments, plainThinkingText } from '../lib/thinking';
import { useStreaming, useStreamingSegments } from '../bytelight';
import { groupToolRuns } from '../lib/tool-runs';
import { ToolRun } from './ToolRun';

interface StreamingReplyProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Renders the in-progress companion reply with interleaved tool-call and
// thinking blocks. Tool calls fold into the same ToolRun chip finalized
// messages use, in live mode so pending calls spin. Falls back to plain streamed text when there are no
// tool/thinking events for this message.
export function StreamingReply({ themeConfig, themeMode }: StreamingReplyProps) {
  const colors = themeConfig[themeMode];
  const { messageId, tokens } = useStreaming();
  const segments = useStreamingSegments();

  if (!messageId) return null;
  if (!tokens && !segments) return null;

  const thinkingCard = (key: string, summary: string) => {
    // CLI-lane session recycle note → distinct badge, visible mid-stream.
    if ((summary || '').startsWith('[Session recycled')) {
      return (
        <div
          key={key}
          className={cn('my-1.5 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] opacity-75', colors.panelBorder)}
          style={{ background: 'rgba(127,127,127,0.08)' }}
        >
          <RefreshCw size={11} className="shrink-0" />
          <span>Session recycled — re-primed with recent history</span>
        </div>
      );
    }
    return (
      <div key={key} className="my-1.5 flex items-start gap-1.5 text-xs italic opacity-70">
        <Brain size={12} className="mt-0.5 shrink-0" />
        <div className="min-w-0 whitespace-pre-wrap break-words">
          {plainThinkingText(summary) || 'Thinking…'}
        </div>
      </div>
    );
  };

  // Only render tool/thinking cards during streaming — skip text preview.
  // Text appears cleaner when the final message pops in complete.
  const nonTextSegments = coalesceThinkingSegments(
    segments?.filter((s) => s.type === 'tool' || s.type === 'thinking') || [],
  );

  if (nonTextSegments.length === 0) {
    // No tool/thinking activity — let TypingIndicator handle the dots
    return null;
  }

  return (
    <div className="flex justify-start mb-2">
      <div className={cn('rounded-2xl px-3.5 py-2.5 max-w-[85%] text-sm', colors.compBubbleBg, colors.compBubbleText)}>
        {/* Live shows every tool, plumbing included — no hidden filter here. */}
        {groupToolRuns(nonTextSegments).map((item) => {
          if (item.kind === 'tools') {
            return <ToolRun key={`tools-${item.index}`} tools={item.tools} themeConfig={themeConfig} themeMode={themeMode} live />;
          }
          if (item.segment.type === 'thinking') {
            return thinkingCard(`think-${item.index}`, item.segment.summary);
          }
          return null;
        })}
      </div>
    </div>
  );
}
