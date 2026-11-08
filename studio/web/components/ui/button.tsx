import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const variants = {
  primary: 'bg-accent text-accent-foreground hover:opacity-90',
  secondary: 'border border-border bg-surface hover:border-accent/50',
  ghost: 'text-muted hover:text-foreground',
} as const;

export function Button({ variant = 'secondary', className, ...props }: ComponentProps<'button'> & { variant?: keyof typeof variants }) {
  return (
    <button
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50', variants[variant], className)}
      {...props}
    />
  );
}
