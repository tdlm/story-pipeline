'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FilePicker } from '@/components/file-picker';
import { Button } from '@/components/ui/button';
import { Field, TextArea } from '@/components/ui/field';
import { createDraft, useShows } from '@/lib/api';

export default function NextPart() {
  const { show } = useParams<{ show: string }>();
  const router = useRouter();
  const { data: shows } = useShows();
  const name = shows?.find((s) => s.id === show)?.name ?? show;
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    form.set('kind', 'next-part');
    form.set('show', show);
    for (const file of files) form.append('files', file);
    try {
      const { id } = await createDraft(form);
      router.push(`/drafts/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-xl flex-col gap-5">
      <div>
        <Link href="/" className="text-sm text-muted hover:text-foreground">← Home</Link>
        <h1 className="mt-1 text-2xl font-semibold">Next part of {name}</h1>
        <p className="text-sm text-muted">Claude reads the show's arc, votes and recent episodes, then outlines the next part with you. Nothing is saved until you accept it.</p>
      </div>
      <Field label="Vote result" hint="As you'd say it, e.g. “Go up: 9, wait: 3”. Leave empty if there was no vote.">
        <TextArea name="vote" rows={2} autoFocus />
      </Field>
      <Field label="Notes" hint="Anything you want in this part: a beat, a line, a callback.">
        <TextArea name="notes" rows={4} />
      </Field>
      <Field label="Attachments">
        <FilePicker files={files} onChange={setFiles} />
      </Field>
      {error !== undefined && <p className="text-sm text-warning">{error}</p>}
      <div><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Starting…' : 'Start with Claude'}</Button></div>
    </form>
  );
}
