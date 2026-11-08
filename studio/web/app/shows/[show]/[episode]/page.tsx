'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { EpisodeDetail } from '../../../../../server/api-types.ts';
import { ShotCard } from '@/components/shot-card';
import { ShotViewer } from '@/components/shot-viewer';
import { stateLabel, stateTone } from '@/components/shot-state';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useEpisode } from '@/lib/api';
import { cn } from '@/lib/cn';

const TABS = [
  { id: 'shots', label: 'Shots', ready: true },
  { id: 'sound', label: 'Sound', ready: false },
  { id: 'video', label: 'Video', ready: true },
  { id: 'publish', label: 'Publish', ready: false },
] as const;
type TabId = (typeof TABS)[number]['id'];

const VIEWS = [
  { id: 'cards', label: 'Work on shots' },
  { id: 'grid', label: 'Review pictures' },
  { id: 'script', label: 'Read the script' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

function Shots({ episode }: { episode: EpisodeDetail }) {
  const [view, setView] = useState<ViewId>('cards');
  return (
    <div className="flex flex-col gap-4">
      <div className="inline-flex self-start rounded-lg border border-border p-0.5 text-sm">
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => setView(v.id)} className={cn('rounded-md px-3 py-1', v.id === view ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:text-foreground')}>
            {v.label}
          </button>
        ))}
      </div>
      {view === 'cards' && <div className="flex flex-col gap-3">{episode.shotList.map((shot) => <ShotCard key={shot.number} episode={episode} shot={shot} />)}</div>}
      {view === 'grid' && <Pictures episode={episode} />}
      {view === 'script' && <Script episode={episode} />}
    </div>
  );
}

function Pictures({ episode }: { episode: EpisodeDetail }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {episode.shotList.map((shot, i) => (
          <button key={shot.id} onClick={() => setOpen(i)} className="group flex flex-col gap-1.5 text-left">
            <div className={cn('aspect-[9/16] w-full overflow-hidden rounded-lg border-2 bg-border', shot.state === 'to-review' || shot.state === 'out-of-date' ? 'border-warning' : 'border-transparent', 'group-hover:border-accent')}>
              {shot.image !== undefined && <img src={shot.image} alt={`Shot ${shot.number}`} className="h-full w-full object-cover" loading="lazy" />}
            </div>
            <div className="flex items-center justify-between gap-1 text-xs">
              <span className="text-muted">{shot.number}</span>
              <Badge tone={stateTone[shot.state]}>{stateLabel[shot.state]}</Badge>
            </div>
          </button>
        ))}
      </div>
      {open !== null && <ShotViewer shots={episode.shotList} index={open} onChange={setOpen} />}
    </>
  );
}

function Script({ episode }: { episode: EpisodeDetail }) {
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      {episode.shotList.map((shot) => (
        <Card key={shot.id} className="flex gap-4 p-4">
          <span className="w-6 shrink-0 text-sm text-muted">{shot.number}</span>
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            {shot.lines.length === 0 && <p className="text-muted">No lines.</p>}
            {shot.lines.map((line, i) => (
              <p key={i}><span className="text-muted">{line.speaker}: </span>{line.text}</p>
            ))}
            {shot.prompt !== undefined && (
              <details>
                <summary className="cursor-pointer text-muted">Picture</summary>
                <p className="mt-1 whitespace-pre-wrap text-muted">{shot.prompt}</p>
              </details>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function Video({ episode }: { episode: EpisodeDetail }) {
  if (episode.video === undefined) return <p className="text-muted">No video yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">{episode.video.kind === 'final' ? 'Final video' : 'Draft video'}</p>
      <video src={episode.video.url} controls className="max-h-[75vh] w-auto self-start rounded-lg bg-black" />
    </div>
  );
}

export default function EpisodePage() {
  const { show, episode: episodeId } = useParams<{ show: string; episode: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { data: episode, error, isPending } = useEpisode(show, episodeId);

  if (isPending) return <p className="text-muted">Loading…</p>;
  if (error !== null) return <p className="text-warning">{error.message}</p>;

  const fallback: TabId = 'shots';
  const requested = search.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested && t.ready) ? (requested as TabId) : fallback;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href="/" className="text-sm text-muted hover:text-foreground">← {episode.show.name}</Link>
        {episode.header !== undefined && <p className="text-sm text-muted">{episode.header}</p>}
        <h1 className="text-2xl font-semibold">{episode.title}</h1>
        <p className={cn('text-sm', episode.toReview > 0 ? 'text-warning' : 'text-muted')}>{episode.status}</p>
      </div>
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            disabled={!t.ready}
            onClick={() => router.replace(`?tab=${t.id}`, { scroll: false })}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              t.id === tab ? 'border-accent font-medium' : 'border-transparent text-muted hover:text-foreground',
              !t.ready && 'cursor-not-allowed opacity-40 hover:text-muted',
            )}
            title={t.ready ? undefined : 'Coming in a later phase'}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'shots' && <Shots episode={episode} />}
      {tab === 'video' && <Video episode={episode} />}
    </div>
  );
}
