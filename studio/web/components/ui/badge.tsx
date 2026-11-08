import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const tones = {
  neutral: 'border-border text-muted',
  accent: 'border-accent/40 text-accent',
  warning: 'border-warning/40 text-warning',
  success: 'border-success/40 text-success',
} as const;

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof tones }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', tones[tone], className)} {...props} />;
}
