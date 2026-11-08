'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ClaudePanel } from '@/components/claude-panel';
import { ProposalCard } from '@/components/proposal-card';
import { useDraft } from '@/lib/api';

export default function DraftPage() {
  const { id } = useParams<{ id: string }>();
  const { data: draft, error, isPending } = useDraft(id);
  if (isPending) return <p className="text-muted">Loading…</p>;
  if (error !== null) return <p className="text-warning">{error.message}</p>;

  const pending = draft.proposals.filter((p) => p.status === 'pending');
  const saved = draft.proposals.filter((p) => p.status === 'accepted');
  const dismissed = draft.proposals.filter((p) => p.status === 'dismissed');
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/" className="text-sm text-muted hover:text-foreground">← Home</Link>
        <h1 className="text-2xl font-semibold">{draft.title}</h1>
        <p className="text-sm text-muted">
          {pending.length > 0 ? `${pending.length} file${pending.length === 1 ? '' : 's'} waiting for you.` : 'Work it out with Claude. Files it proposes appear here for you to save.'}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <div className="flex min-w-0 flex-col gap-3">
          {draft.proposals.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">No files proposed yet.</p>}
          {pending.map((p) => <ProposalCard key={p.id} draftId={draft.id} proposal={p} />)}
          {saved.map((p) => <ProposalCard key={p.id} draftId={draft.id} proposal={p} />)}
          {dismissed.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">Dismissed ({dismissed.length})</summary>
              <div className="mt-3 flex flex-col gap-3">{dismissed.map((p) => <ProposalCard key={p.id} draftId={draft.id} proposal={p} />)}</div>
            </details>
          )}
        </div>
        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-8rem)]">
          <ClaudePanel draft={draft} />
        </div>
      </div>
    </div>
  );
}
