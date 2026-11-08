'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FilePicker } from '@/components/file-picker';
import { Button } from '@/components/ui/button';
import { Field, TextArea, TextInput } from '@/components/ui/field';
import { createDraft } from '@/lib/api';

export default function NewShow() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    form.set('kind', 'new-show');
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
        <h1 className="mt-1 text-2xl font-semibold">New show</h1>
        <p className="text-sm text-muted">Start with a name and a rough idea. Claude helps you shape the premise, cast and arc, then proposes the show's files for you to accept.</p>
      </div>
      <Field label="Name"><TextInput name="title" required autoFocus /></Field>
      <Field label="Pitch" hint="A sentence or a page. Rough is fine.">
        <TextArea name="pitch" rows={6} />
      </Field>
      <Field label="Attachments" hint="Reference art, notes, an existing story doc.">
        <FilePicker files={files} onChange={setFiles} />
      </Field>
      {error !== undefined && <p className="text-sm text-warning">{error}</p>}
      <div><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Starting…' : 'Start with Claude'}</Button></div>
    </form>
  );
}
