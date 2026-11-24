import React, { useState } from 'react';
import { housePost, shareBody, taskBody, type ShareKind, type ThreadRow } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError } from './actions';
import { Colors, fetchFn } from './parts';

// The brain sends into the house, by hand only: a thread becomes a Command
// Center task, a feeling, note or journal entry becomes a card in the home
// chat. Each button says what really happened, and goes quiet once it has
// worked so the same thing isn't sent twice by a double tap.

function useHouseSend() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (path: 'task' | 'chat', body: unknown, said: (data: any) => string) => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    const r = await housePost(fetchFn, path, body);
    setBusy(false);
    if (r.ok) setDone(said(r.data));
    else setError(r.error ?? 'Something went wrong.');
  };
  return { busy, done, error, send };
}

function Sent({ colors, text }: { colors: Colors; text: string }) {
  return <span className={cn('inline-flex min-h-[44px] items-center text-xs font-semibold', colors.textMuted)}>{text}</span>;
}

export function MakeTaskButton({ thread, colors }: { thread: ThreadRow; colors: Colors }) {
  const h = useHouseSend();
  return (
    <>
      {h.done ? <Sent colors={colors} text={h.done} /> : (
        <ActionButton colors={colors} busy={h.busy} onClick={() => h.send('task', taskBody(thread), () => 'Made it a task in Command Center.')}>
          Make it a task
        </ActionButton>
      )}
      <ActionError error={h.error} />
    </>
  );
}

export function ShareToChatButton({ kind, item, colors }: {
  kind: ShareKind;
  item: { id: string | number; content: string; who?: string; emotion?: string; about?: string; day?: string };
  colors: Colors;
}) {
  const h = useHouseSend();
  return (
    <>
      {h.done ? <Sent colors={colors} text={h.done} /> : (
        <ActionButton colors={colors} busy={h.busy} onClick={() => h.send('chat', shareBody(kind, item), (d) => `Shared to ${d?.threadName || 'the chat'}.`)}>
          Share to chat
        </ActionButton>
      )}
      <ActionError error={h.error} />
    </>
  );
}
