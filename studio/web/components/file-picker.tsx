'use client';

import { useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/cn';

/** Pick or drop files. Images, text, Markdown and PDFs are what Claude can read. */
export function FilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const add = (list: FileList | null): void => {
    if (list !== null) onChange([...files, ...Array.from(list)]);
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setOver(false);
    add(event.dataTransfer.files);
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        className={cn('cursor-pointer rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted', over ? 'border-accent text-accent' : 'border-border')}
      >
        Drop files here or click to choose. Images, notes, Markdown or PDFs.
        <input ref={input} type="file" multiple hidden accept="image/*,.txt,.md,.markdown,.pdf,.yaml,.yml,.json,.csv" onChange={(e) => add(e.target.files)} />
      </div>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
              {file.name}
              <button type="button" className="text-muted hover:text-warning" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`Remove ${file.name}`}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
