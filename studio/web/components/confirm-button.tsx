'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** A button for spending money: the first click asks, the second spends. */
export function ConfirmButton({ label, confirm, onConfirm, disabled, variant = 'secondary' }: {
  label: ReactNode;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button variant={variant} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span>{confirm}</span>
      <Button variant="primary" onClick={() => { setAsking(false); onConfirm(); }}>Yes</Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
    </span>
  );
}
