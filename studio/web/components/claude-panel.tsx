'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Draft } from '../../server/api-types.ts';
import { FilePicker } from '@/components/file-picker';
import { Button } from '@/components/ui/button';
import { TextArea } from '@/components/ui/field';
import { sendTurn, uploadAttachments } from '@/lib/api';
import { cn } from '@/lib/cn';

type Live = { text: string; activity: string[] };

/** The conversation with Claude for one draft. Replies stream in; proposals appear on the left as they arrive. */
export function ClaudePanel({ draft }: { draft: Draft }) {
  const client = useQueryClient();
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const started = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const send = async (text: string): Promise<void> => {
    if (text.trim() === '' || live !== null) return;
    setError(undefined);
    setPending(text);
    setLive({ text: '', activity: [] });
    try {
      if (files.length > 0) {
        await uploadAttachments(draft.id, files);
        setFiles([]);
        setAttaching(false);
        text = `${text}\n\n(I attached: ${files.map((f) => f.name).join(', ')}.)`;
      }
      await sendTurn(draft.id, text, (event) => {
        if (event.type === 'text') setLive((l) => l && { ...l, text: l.text + event.delta });
        if (event.type === 'activity') setLive((l) => l && { ...l, activity: [...l.activity, event.note] });
        if (event.type === 'proposal') void client.invalidateQueries({ queryKey: ['draft', draft.id] });
        if (event.type === 'done') client.setQueryData(['draft', draft.id], event.draft);
        if (event.type === 'error') setError(event.message);
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLive(null);
      setPending(null);
      void client.invalidateQueries({ queryKey: ['draft', draft.id] });
    }
  };

  // A new draft starts the conversation with the kickoff from its form.
  useEffect(() => {
    if (started.current || draft.messages.length > 0 || draft.kickoff === undefined) return;
    started.current = true;
    void send(draft.kickoff);
  }, [draft]);

  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [draft.messages.length, live?.text, pending]);

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const text = input;
      setInput('');
      void send(text);
    }
  };

  const asks = draft.kind === 'next-part'
    ? [
        { label: 'Draft the script', text: `/${draft.skill} Draft the full episode from the outline we agreed. Propose it with propose_file, plus the updates to ARC.md and VOTES.md.` },
        { label: 'Try another outline', text: 'Give me a different outline for this part, still true to the arc.' },
      ]
    : [
        { label: 'Propose the show files', text: `/${draft.skill} Propose the show's files now, each with propose_file: README.md, ARC.md, cast.yaml, show.yaml and ep01.yaml.` },
        { label: 'Expand the story', text: 'Expand the premise into a fuller story: the world, the main characters and what changes over the first ten parts.' },
      ];
  const busy = live !== null;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-surface">
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {draft.messages.map((message, i) => (
          <div key={i} className={cn('flex flex-col gap-1', message.role === 'user' && 'items-end')}>
            <div className={cn('max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2', message.role === 'user' ? 'bg-accent/10' : 'bg-background')}>
              {message.text}
            </div>
            {message.activity !== undefined && message.activity.length > 0 && <p className="text-xs text-muted">{message.activity.join(' · ')}</p>}
          </div>
        ))}
        {pending !== null && !draft.messages.some((m) => m.text === pending) && (
          <div className="flex flex-col items-end"><div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-accent/10 px-3 py-2">{pending}</div></div>
        )}
        {live !== null && (
          <div className="flex flex-col gap-1">
            <div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-background px-3 py-2">{live.text === '' ? <span className="text-muted">Thinking…</span> : live.text}</div>
            {live.activity.length > 0 && <p className="text-xs text-muted">{live.activity.join(' · ')}</p>}
          </div>
        )}
        {error !== undefined && <p className="text-warning">{error}</p>}
        <div ref={end} />
      </div>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <div className="flex flex-wrap gap-2">
          {asks.map((ask) => <Button key={ask.label} disabled={busy} onClick={() => void send(ask.text)}>{ask.label}</Button>)}
        </div>
        {attaching && <FilePicker files={files} onChange={setFiles} />}
        <TextArea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} placeholder="Reply to Claude. ⌘↵ to send." rows={3} disabled={busy} />
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setAttaching(!attaching)}>{attaching ? 'Hide attachments' : 'Attach files'}</Button>
          <Button variant="primary" disabled={busy || input.trim() === ''} onClick={() => { const text = input; setInput(''); void send(text); }}>Send</Button>
        </div>
      </div>
    </div>
  );
}
