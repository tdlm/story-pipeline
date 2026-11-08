import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn('min-h-20 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent', className)} {...props} />;
}

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent', className)} {...props} />;
}
