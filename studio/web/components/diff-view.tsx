import { diffLines } from 'diff';
import { cn } from '@/lib/cn';

/** Line diff of a changed file: removed lines struck, added lines highlighted, long unchanged runs folded. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-background p-3 text-xs leading-relaxed">
      {parts.map((part, i) => {
        const lines = part.value.replace(/\n$/, '').split('\n');
        if (!part.added && !part.removed && lines.length > 6) {
          const head = lines.slice(0, 2);
          const tail = lines.slice(-2);
          return (
            <span key={i} className="text-muted">
              {head.join('\n')}{'\n'}<span className="italic">… {lines.length - 4} unchanged lines …</span>{'\n'}{tail.join('\n')}{'\n'}
            </span>
          );
        }
        return (
          <span key={i} className={cn(part.added && 'bg-success/15 text-success', part.removed && 'bg-warning/15 text-warning line-through', !part.added && !part.removed && 'text-muted')}>
            {lines.map((line) => `${part.added ? '+ ' : part.removed ? '- ' : '  '}${line}`).join('\n')}{'\n'}
          </span>
        );
      })}
    </pre>
  );
}
