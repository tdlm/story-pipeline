'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import type { ShotDetail, ShotSuggestion } from '../../server/api-types.ts';
import { Button } from '@/components/ui/button';
import { TextArea } from '@/components/ui/field';
import { askAboutShot, useShotChat } from '@/lib/api';
import { cn } from '@/lib/cn';

export type Apply = { prompt?: string; fix?: string; lines?: { speaker: string; text: string }[] };

const ASKS = [
  { label: 'Check it against the references', text: 'Look at the picture next to the references. What would a viewer notice is off? Suggest the cheapest way to fix it.' },
  { label: 'Tighten the prompt', text: 'Rewrite the prompt so the image model gets this shot right first time. Keep what works.' },
];

/** Claude for one shot: it looks at the picture and suggests a prompt, a fix or lines. Applying one only fills the editor. */
export function ShotAssistant({ show, episode, shot, onApply }: { show: string; episode: string; shot: ShotDetail; onApply: (apply: Apply) => void }) {
  const client = useQueryClient();
  const key = ['shot-chat', show, episode, shot.number];
  const { data: chat } = useShotChat(show, episode, shot.number, true);
  const [input, setInput] = useState('');
  const [live, setLive] = useState<{ text: string; activity: string[]; asked: string } | null>(null);
  const [fresh, setFresh] = useState<ShotSuggestion[]>([]);
  const [error, setError] = useState<string>();

  const send = async (text: string): Promise<void> => {
    if (text.trim() === '' || live !== null) return;
    setError(undefined);
    setFresh([]);
    setLive({ text: '', activity: [], asked: text });
    try {
      await askAboutShot(show, episode, shot.number, text, (event) => {
        if (event.type === 'text') setLive((l) => l && { ...l, text: l.text + event.delta });
        if (event.type === 'activity') setLive((l) => l && { ...l, activity: [...l.activity, event.note] });
        if (event.type === 'suggestion') setFresh((s) => [...s, event.suggestion]);
        if (event.type === 'done') client.setQueryData(key, event.chat);
        if (event.type === 'error') setError(event.message);
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLive(null);
      void client.invalidateQueries({ queryKey: key });
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send(input);
      setInput('');
    }
  };

  const messages = chat?.messages ?? [];
  const suggestions = live !== null ? fresh : (chat?.suggestions ?? []).slice(-3);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3 text-sm">
      {messages.slice(-6).map((m, i) => (
        <div key={i} className={cn('flex', m.role === 'user' && 'justify-end')}>
          <p className={cn('max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2', m.role === 'user' ? 'bg-accent/10' : 'bg-surface')}>{m.text}</p>
        </div>
      ))}
      {live !== null && (
        <>
          <div className="flex justify-end"><p className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-accent/10 px-3 py-2">{live.asked}</p></div>
          <p className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-surface px-3 py-2">{live.text === '' ? <span className="text-muted">{live.activity.at(-1) ?? 'Looking'}…</span> : live.text}</p>
        </>
      )}
      {suggestions.map((s) => (
        <div key={s.id} className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-surface p-3">
          <p className="font-medium">{s.why}</p>
          {s.fix !== undefined && <p className="text-muted">Fix: {s.fix}</p>}
          {s.prompt !== undefined && <p className="text-muted line-clamp-3" title={s.prompt}>Prompt: {s.prompt}</p>}
          {s.lines !== undefined && <div className="text-muted">{s.lines.map((l, i) => <p key={i}>{l.speaker}: {l.text}</p>)}</div>}
          <div className="flex flex-wrap gap-2">
            {s.fix !== undefined && <Button onClick={() => onApply({ fix: s.fix })}>Use this fix</Button>}
            {s.prompt !== undefined && <Button onClick={() => onApply({ prompt: s.prompt })}>Use this prompt</Button>}
            {s.lines !== undefined && <Button onClick={() => onApply({ lines: s.lines })}>Use these lines</Button>}
          </div>
        </div>
      ))}
      {error !== undefined && <p className="text-warning">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {ASKS.map((ask) => <Button key={ask.label} disabled={live !== null || shot.image === undefined} onClick={() => void send(ask.text)}>{ask.label}</Button>)}
      </div>
      <div className="flex gap-2">
        <TextArea value={input} rows={2} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={live !== null}
          placeholder="What's wrong? “his arm looks wrong”, “she should look scared”. ⌘↵ to send." className="flex-1" />
        <Button variant="primary" disabled={live !== null || input.trim() === ''} onClick={() => { void send(input); setInput(''); }}>Ask</Button>
      </div>
      <p className="text-xs text-muted">Claude only suggests. Using a suggestion fills in the editor; you still choose when to save, redraw or fix.</p>
    </div>
  );
}
