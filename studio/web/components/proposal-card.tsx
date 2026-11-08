'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Proposal } from '../../server/api-types.ts';
import { DiffView } from '@/components/diff-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useProposalAction } from '@/lib/api';

const statusTone = { pending: 'warning', accepted: 'success', dismissed: 'neutral', replaced: 'neutral' } as const;
const statusLabel = { pending: 'Waiting for you', accepted: 'Saved', dismissed: 'Dismissed', replaced: 'Replaced' } as const;

export function ProposalCard({ draftId, proposal }: { draftId: string; proposal: Proposal }) {
  const action = useProposalAction(draftId);
  const [showFile, setShowFile] = useState(false);
  const isNew = proposal.before === undefined;
  const fileName = proposal.path.split('/').at(-1) ?? proposal.path;
  const episodeLink = /^ep\d+\.ya?ml$/i.test(fileName) ? proposal.path.replace(/^stories\//, '/shows/').replace(/\.ya?ml$/i, '') : undefined;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{isNew ? 'New: ' : 'Change: '}{fileName}</p>
          <p className="text-sm text-muted">{proposal.summary}</p>
        </div>
        <Badge tone={statusTone[proposal.status]}>{statusLabel[proposal.status]}</Badge>
      </div>

      {proposal.preview !== undefined && (
        <div className="flex flex-col gap-2 text-sm">
          {proposal.preview.header !== undefined && <p className="text-xs text-muted">{proposal.preview.header}</p>}
          <p className="font-medium">{proposal.preview.title}</p>
          <ol className="flex flex-col gap-2">
            {proposal.preview.shots.map((shot) => (
              <li key={shot.number} className="flex gap-3">
                <span className="w-5 shrink-0 text-xs text-muted">{shot.number}</span>
                <div className="flex min-w-0 flex-col gap-1">
                  {shot.lines.map((line, i) => <p key={i}><span className="text-muted">{line.speaker}: </span>{line.text}</p>)}
                  {shot.lines.length === 0 && <p className="text-muted">No lines.</p>}
                  {shot.prompt !== undefined && <p className="text-xs text-muted line-clamp-2" title={shot.prompt}>Picture: {shot.prompt}</p>}
                  {shot.imageFile !== undefined && <p className="text-xs text-muted">Reuses {shot.imageFile}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {proposal.preview === undefined && !isNew && <DiffView before={proposal.before ?? ''} after={proposal.content} />}
      {(proposal.preview === undefined && isNew) || showFile ? (
        proposal.preview !== undefined && !isNew && showFile ? <DiffView before={proposal.before ?? ''} after={proposal.content} />
        : <pre className="max-h-96 overflow-auto rounded-lg bg-background p-3 text-xs">{proposal.content}</pre>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {proposal.status === 'pending' && (
          <>
            <Button variant="primary" disabled={action.isPending} onClick={() => action.mutate({ proposal: proposal.id, action: 'accept' })}>
              {isNew ? 'Save it' : 'Save the change'}
            </Button>
            <Button variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ proposal: proposal.id, action: 'dismiss' })}>Dismiss</Button>
          </>
        )}
        {proposal.preview !== undefined && (
          <Button variant="ghost" onClick={() => setShowFile(!showFile)}>{showFile ? 'Hide the file' : isNew ? 'Show the file' : 'Show the changes'}</Button>
        )}
        {proposal.status === 'accepted' && episodeLink !== undefined && <Link href={episodeLink} className="text-sm text-accent">Open the episode →</Link>}
      </div>
      {action.error !== null && <p className="text-sm text-warning">{action.error.message}</p>}
    </Card>
  );
}
