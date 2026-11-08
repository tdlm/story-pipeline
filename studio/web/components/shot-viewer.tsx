'use client';

import { useEffect } from 'react';
import type { ShotDetail } from '../../server/api-types.ts';
import { Badge } from '@/components/ui/badge';
import { stateLabel, stateTone } from '@/components/shot-state';

type Props = { shots: ShotDetail[]; index: number; onChange: (index: number | null) => void };

/** Full-size view of one shot. Arrow keys move between shots, Escape closes. */
export function ShotViewer({ shots, index, onChange }: Props) {
  const shot = shots[index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onChange(null);
      if (event.key === 'ArrowRight' && index < shots.length - 1) onChange(index + 1);
      if (event.key === 'ArrowLeft' && index > 0) onChange(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, shots.length, onChange]);

  if (shot === undefined) return null;
  return (
    <div className="fixed inset-0 z-50 flex bg-black/80 p-4" onClick={() => onChange(null)} role="dialog" aria-modal="true">
      <div className="mx-auto flex max-h-full w-full max-w-5xl flex-col gap-4 overflow-auto rounded-xl bg-surface p-4 md:flex-row" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-center md:w-1/2">
          {shot.image !== undefined
            ? <img src={shot.image} alt={`Shot ${shot.number}`} className="max-h-[80vh] rounded-lg object-contain" />
            : <div className="flex aspect-[9/16] w-full max-w-xs items-center justify-center rounded-lg bg-border text-muted">Not drawn yet</div>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Shot {shot.number} of {shots.length}</h3>
            <Badge tone={stateTone[shot.state]}>{stateLabel[shot.state]}</Badge>
          </div>
          {shot.lines.length > 0 && (
            <div className="flex flex-col gap-2">
              {shot.lines.map((line, i) => (
                <p key={i}><span className="text-muted">{line.speaker}: </span>{line.text}</p>
              ))}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-muted">More</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {shot.cast.length > 0 && <><dt className="text-muted">Cast</dt><dd>{shot.cast.join(', ')}</dd></>}
              {shot.location !== undefined && <><dt className="text-muted">Place</dt><dd>{shot.location}</dd></>}
              <dt className="text-muted">Camera</dt><dd>{shot.move}</dd>
              <dt className="text-muted">Into it</dt><dd>{shot.transition}</dd>
            </dl>
            {shot.prompt !== undefined && <p className="mt-3 whitespace-pre-wrap text-muted">{shot.prompt}</p>}
          </details>
          <p className="mt-auto text-xs text-muted">← → to move between shots · Esc to close. Keep, fix and redraw arrive with image review.</p>
        </div>
      </div>
    </div>
  );
}
