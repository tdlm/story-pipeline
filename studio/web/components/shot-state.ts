import type { ShotState } from '../../server/api-types.ts';

export const stateLabel: Record<ShotState, string> = { kept: 'Kept', 'to-review': 'Needs a look', 'not-drawn': 'Not drawn', 'own-picture': 'Your picture' };
export const stateTone = { kept: 'success', 'to-review': 'warning', 'not-drawn': 'neutral', 'own-picture': 'neutral' } as const satisfies Record<ShotState, string>;
