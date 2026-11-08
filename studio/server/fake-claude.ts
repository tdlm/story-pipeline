import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Draft, TurnEvent } from './api-types.ts';
import { propose, saveDraft, showDir } from './drafts.ts';
import { showContext } from './shows.ts';

/**
 * A stand-in for Claude, for working on the UI without using your Max limits: STUDIO_FAKE_CLAUDE=1.
 * It streams a canned reply and, when asked to draft, proposes a copy of the latest episode.
 */
export async function runFakeTurn(draft: Draft, text: string, emit: (event: TurnEvent) => void): Promise<void> {
  draft.messages.push({ role: 'user', text, at: new Date().toISOString() });
  const drafting = /draft|script|propose/i.test(text) && draft.messages.length > 1;
  const reply = drafting
    ? 'Here is the episode, plus the arc update. (Fake Claude: this is a copy of the latest episode.)'
    : '1. Open on the vote result.\n2. The survivor weighs it.\n3. Something knocks.\n\n(Fake Claude: set STUDIO_FAKE_CLAUDE=0 to use the real one.)';
  const activity = ['Read ARC.md', 'Read VOTES.md'];
  for (const note of activity) emit({ type: 'activity', note });
  for (const word of reply.split(/(?<= )/)) {
    emit({ type: 'text', delta: word });
    await new Promise((done) => setTimeout(done, 15));
  }
  if (drafting && draft.kind === 'next-part') {
    const context = await showContext(draft.show);
    const latest = context.recentEpisodes.at(-1);
    if (latest !== undefined) {
      const episode = await propose(draft, context.nextEpisodeFile, await readFile(latest, 'utf8'), 'The next part (fake: a copy of the latest)');
      emit({ type: 'proposal', proposal: episode });
      activity.push(`Proposed ${episode.path}`);
    }
    const arc = join(showDir(draft), 'ARC.md');
    if (existsSync(arc)) {
      const update = await propose(draft, 'ARC.md', `${await readFile(arc, 'utf8')}\n- (fake) A new beat.\n`, 'Adds the new part to the arc');
      emit({ type: 'proposal', proposal: update });
      activity.push(`Proposed ${update.path}`);
    }
  }
  draft.messages.push({ role: 'assistant', text: reply, at: new Date().toISOString(), activity });
  draft.updatedAt = new Date().toISOString();
  await saveDraft(draft);
  emit({ type: 'done', draft });
}
