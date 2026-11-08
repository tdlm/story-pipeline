'use client';

import { useEffect, useState } from 'react';
import type { EpisodeDetail, ShotDetail } from '../../server/api-types.ts';
import { ConfirmButton } from '@/components/confirm-button';
import { stateLabel, stateTone } from '@/components/shot-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextArea, TextInput } from '@/components/ui/field';
import { useShotAction } from '@/lib/api';
import { cn } from '@/lib/cn';

type Line = { speaker: string; text: string };
const reasonLabel: Record<string, string> = {
  attempt: 'Drawn', fix: 'Fixed', 'kept-before-fix': 'Kept, before a fix', 'kept-before-redraw': 'Kept, before a redraw', 'kept-before-restore': 'Kept, before a swap', unkept: 'Unkept',
};
const money = (usd: number): string => `about $${usd.toFixed(2)}`;

/** One shot: its words on the left, its picture on the right. Text edits are free; drawing asks first. */
export function ShotCard({ episode, shot }: { episode: EpisodeDetail; shot: ShotDetail }) {
  const action = useShotAction(episode.show.id, episode.id);
  const [lines, setLines] = useState<Line[]>(shot.lines);
  const [prompt, setPrompt] = useState(shot.prompt ?? '');
  const [fix, setFix] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  // A fresh copy from the server replaces unsaved edits only when there are none.
  const dirty = JSON.stringify(lines) !== JSON.stringify(shot.lines) || prompt.trim() !== (shot.prompt ?? '').trim();
  useEffect(() => {
    if (!dirty) {
      setLines(shot.lines);
      setPrompt(shot.prompt ?? '');
    }
  }, [shot.lines, shot.prompt]);

  const run = (label: string, body: Parameters<typeof action.mutate>[0]): void => {
    setWorking(label);
    action.mutate(body, { onSettled: () => setWorking(null), onSuccess: () => { setPreview(null); setFix(''); } });
  };
  const n = shot.number;
  const busy = working !== null;
  const speakers = [...new Set([...episode.speakers, ...lines.map((l) => l.speaker)])];
  const canDraw = shot.state !== 'own-picture' && shot.editable;
  const shown = preview ?? shot.image;
  const previewVersion = shot.versions.find((v) => v.url === preview);

  return (
    <Card className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">Shot {n}</h3>
          <Badge tone={stateTone[shot.state]}>{stateLabel[shot.state]}</Badge>
          <span className="truncate text-xs text-muted">{[shot.move, shot.cast.join(', '), shot.location].filter(Boolean).join(' · ')}</span>
        </div>

        {!shot.editable && <p className="text-sm text-muted">This is the series end card. Change it in the show's cast.yaml.</p>}

        <div className="flex flex-col gap-2">
          {lines.map((line, i) => (
            <div key={i} className="flex items-start gap-2">
              <select
                value={line.speaker}
                disabled={!shot.editable || busy}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, speaker: e.target.value } : l)))}
                className="w-32 shrink-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-muted"
              >
                {speakers.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <TextArea
                value={line.text}
                rows={Math.max(1, Math.ceil(line.text.length / 70))}
                disabled={!shot.editable || busy}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, text: e.target.value } : l)))}
                className="min-h-0 flex-1"
              />
              {shot.editable && <Button variant="ghost" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</Button>}
            </div>
          ))}
          {shot.editable && (
            <div><Button variant="ghost" onClick={() => setLines([...lines, { speaker: lines.at(-1)?.speaker ?? 'narrator', text: '' }])}>+ Line</Button></div>
          )}
        </div>

        {shot.prompt !== undefined && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Picture</span>
            <TextArea value={prompt} rows={4} disabled={!shot.editable || busy} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        )}

        {dirty && (
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => run('Saving', { number: n, action: 'edit', rev: episode.rev, lines, ...(prompt.trim() !== (shot.prompt ?? '').trim() ? { image: prompt } : {}) })}
            >
              Save
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setLines(shot.lines); setPrompt(shot.prompt ?? ''); }}>Cancel</Button>
            {prompt.trim() !== (shot.prompt ?? '').trim() && shot.state !== 'kept' && <span className="text-xs text-muted">Saving won't redraw the picture. You choose when.</span>}
          </div>
        )}
        {action.error !== null && <p className="text-sm text-warning">{action.error.message}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-border">
          {shown !== undefined && <img src={shown} alt={`Shot ${n}`} className={cn('h-full w-full object-cover', shot.state === 'out-of-date' && preview === null && 'opacity-60')} />}
          {shown === undefined && <div className="flex h-full items-center justify-center text-sm text-muted">Not drawn yet</div>}
          {busy && <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4 text-center text-sm text-white">{working}…{working === 'Drawing' || working === 'Fixing' ? ' about 20 seconds' : ''}</div>}
        </div>

        {previewVersion !== undefined ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-xs text-muted">{reasonLabel[previewVersion.reason] ?? previewVersion.reason}, {new Date(previewVersion.at).toLocaleString()}{previewVersion.instruction !== undefined ? `: “${previewVersion.instruction}”` : ''}</p>
            <div className="flex gap-2">
              <Button variant="primary" disabled={busy} onClick={() => run('Switching', { number: n, action: 'use-version', version: previewVersion.name })}>Use this one</Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>Back</Button>
            </div>
          </div>
        ) : canDraw ? (
          <div className="flex flex-col gap-2">
            {shot.state === 'out-of-date' && <p className="text-xs text-warning">The prompt changed since this was drawn.</p>}
            <div className="flex flex-wrap gap-2">
              {shot.state === 'to-review' && <Button variant="primary" disabled={busy} onClick={() => run('Keeping', { number: n, action: 'keep' })}>Keep</Button>}
              {shot.state === 'kept' && <Button variant="ghost" disabled={busy} onClick={() => run('Unlocking', { number: n, action: 'unkeep' })}>Unkeep</Button>}
              <ConfirmButton
                label={shot.state === 'not-drawn' ? 'Draw' : 'Redraw'}
                variant={shot.state === 'out-of-date' || shot.state === 'not-drawn' ? 'primary' : 'secondary'}
                confirm={`${money(episode.imageCostUsd)}?`}
                disabled={busy || dirty}
                onConfirm={() => run('Drawing', { number: n, action: 'redraw' })}
              />
            </div>
            {shot.image !== undefined && shot.state !== 'out-of-date' && (
              <div className="flex flex-col gap-2">
                <TextInput value={fix} placeholder="Fix one thing: “make the hatch square”" disabled={busy} onChange={(e) => setFix(e.target.value)} />
                {fix.trim() !== '' && (
                  <ConfirmButton label="Fix it" confirm={`${money(episode.imageCostUsd)}?`} disabled={busy} onConfirm={() => run('Fixing', { number: n, action: 'fix', instruction: fix })} />
                )}
              </div>
            )}
            {dirty && <p className="text-xs text-muted">Save your edits before drawing.</p>}
          </div>
        ) : null}

        {shot.versions.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted">Versions ({shot.versions.length})</p>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {[...shot.versions].reverse().map((v) => (
                <button key={v.name} onClick={() => setPreview(v.url === preview ? null : v.url)} title={reasonLabel[v.reason] ?? v.reason}
                  className={cn('aspect-[9/16] w-10 shrink-0 overflow-hidden rounded border-2', v.url === preview ? 'border-accent' : 'border-transparent')}>
                  <img src={v.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
