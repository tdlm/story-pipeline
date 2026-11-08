'use client';

import Link from 'next/link';
import type { EpisodeSummary } from '../../server/api-types.ts';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/progress';
import { useDrafts, useShows } from '@/lib/api';

const stageTone = { 'not-started': 'neutral', pictures: 'warning', voices: 'accent', draft: 'accent', final: 'success' } as const;
const stageLabel = { 'not-started': 'Not started', pictures: 'Pictures', voices: 'Pictures done', draft: 'Draft', final: 'Done' } as const;

function EpisodeCard({ show, episode }: { show: string; episode: EpisodeSummary }) {
  return (
    <Link href={`/shows/${show}/${episode.id}`} className="group">
      <Card className="flex h-full gap-3 p-3 transition-colors group-hover:border-accent/50">
        <div className="aspect-[9/16] w-16 shrink-0 overflow-hidden rounded-md bg-border">
          {episode.cover !== undefined && <img src={episode.cover} alt="" className="h-full w-full object-cover" loading="lazy" />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              {episode.header !== undefined && <p className="truncate text-xs text-muted">{episode.header}</p>}
              <p className="truncate font-medium">{episode.title}</p>
            </div>
            <Badge tone={episode.error !== undefined ? 'warning' : stageTone[episode.stage]}>
              {episode.error !== undefined ? 'Problem' : stageLabel[episode.stage]}
            </Badge>
          </div>
          <p className="text-sm text-muted">{episode.status}</p>
          <div className="mt-auto">
            <Progress value={episode.done} total={episode.shots} />
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function Home() {
  const { data: shows, error, isPending } = useShows();
  const { data: drafts } = useDrafts();
  if (isPending) return <p className="text-muted">Loading shows…</p>;
  if (error !== null) return <p className="text-warning">Couldn't reach the studio server. Is it running? ({error.message})</p>;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Shows</h1>
        <Link href="/new-show" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:border-accent/50">New show</Link>
      </div>
      {drafts !== undefined && drafts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted">Drafts with Claude</h2>
          <div className="flex flex-wrap gap-2">
            {drafts.slice(0, 6).map((d) => (
              <Link key={d.id} href={`/drafts/${d.id}`} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:border-accent/50">
                {d.title}{d.pending > 0 && <span className="ml-2 text-warning">{d.pending} to review</span>}
              </Link>
            ))}
          </div>
        </section>
      )}
      {shows.map((show) => {
        const episodes = show.episodes.filter((e) => e.kind === 'episode');
        const assets = show.episodes.filter((e) => e.kind === 'asset');
        return (
          <section key={show.id} className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">{show.name}</h2>
              <Link href={`/shows/${show.id}/next`} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90">Write the next part</Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[...episodes].reverse().map((episode) => <EpisodeCard key={episode.id} show={show.id} episode={episode} />)}
            </div>
            {assets.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">Assets ({assets.length})</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {assets.map((episode) => <EpisodeCard key={episode.id} show={show.id} episode={episode} />)}
                </div>
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}
