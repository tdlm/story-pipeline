import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A throwaway stories folder and studio folder.
const dir = mkdtempSync(join(tmpdir(), 'story-drafts-'));
process.env.STORY_STORIES_DIR = join(dir, 'stories');
process.env.STORY_STUDIO_DIR = join(dir, 'studio');
const show = join(dir, 'stories', 'demo');
mkdirSync(show, { recursive: true });
writeFileSync(join(show, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\n');
writeFileSync(join(show, 'ARC.md'), '# Arc\n\n- Part 1: a door.\n');
writeFileSync(join(show, 'ep01.yaml'), 'title: One\nshots:\n  - image: A door.\n');
writeFileSync(join(show, 'ep02.yaml'), 'title: Two\nshots:\n  - image: A hatch.\n');

const { accept, createDraft, loadDraft, propose } = await import('../studio/server/drafts.ts');
const { showContext, nextEpisodeFile } = await import('../studio/server/shows.ts');

const episode = 'title: Three\nheader: "DEMO · PART 3"\nshots:\n  - id: knock\n    image: >\n      A knock at the hatch.\n    lines:\n      - narrator: Someone knocks.\n';
const newDraft = () => createDraft({ kind: 'next-part', show: 'demo', title: 'Demo: ep03', kickoff: 'Go.', files: [new File(['notes'], '../../evil name.md')] });

test('the next episode gets the next number', async () => {
  assert.equal(nextEpisodeFile(['ep01.yaml', 'ep09.yaml', 'cast.yaml']), 'ep10.yaml');
  assert.equal((await showContext('demo')).nextEpisodeFile, 'ep03.yaml');
});

test('attachments are stored under a safe name', async () => {
  const draft = await newDraft();
  assert.deepEqual(draft.attachments.map((a) => a.name), ['evil-name.md']);
  assert.ok(existsSync(join(dir, 'studio', 'drafts', draft.id, 'attachments', 'evil-name.md')));
});

test('a proposed episode is checked and previewed, and only written on accept', async () => {
  const draft = await newDraft();
  const proposal = await propose(draft, 'ep03.yaml', episode, 'Part 3');
  assert.equal(proposal.preview?.shots[0]?.lines[0]?.text, 'Someone knocks.');
  assert.equal(existsSync(join(show, 'ep03.yaml')), false);
  await accept(draft, proposal.id);
  assert.equal(readFileSync(join(show, 'ep03.yaml'), 'utf8'), episode);
});

test('a broken episode is refused with the problems', async () => {
  const draft = await newDraft();
  await assert.rejects(propose(draft, 'ep04.yaml', 'title: Four\nshots:\n  - lines: []\n', 'Broken'), /Each shot needs `image`/);
});

test('proposals can only touch the show folder', async () => {
  const draft = await newDraft();
  await assert.rejects(propose(draft, '../other/ARC.md', 'x', 'Escape'), /only change files in stories\/demo/);
  await assert.rejects(propose(draft, '/etc/hosts', 'x', 'Escape'), /only change files/);
  await assert.rejects(propose(draft, 'kept/ep01/a.jpg', 'x', 'Image'), /text files only/);
});

test('accepting is refused if the file changed since it was proposed, and the old version is kept', async () => {
  const draft = await newDraft();
  const stale = await propose(draft, 'ARC.md', '# Arc\n\n- Part 1: a door.\n- Part 2: a hatch.\n', 'Adds part 2');
  writeFileSync(join(show, 'ARC.md'), '# Arc\n\n- Part 1: a door, edited by hand.\n');
  await assert.rejects(accept(draft, stale.id), /changed since this was proposed/);

  const fresh = await propose(draft, 'ARC.md', '# Arc\n\n- Part 1: a door, edited by hand.\n- Part 2: a hatch.\n', 'Adds part 2');
  assert.equal(draft.proposals.find((p) => p.id === stale.id)?.status, 'replaced');
  await accept(draft, fresh.id);
  const versions = join(dir, 'studio', 'versions', 'files', 'stories-demo-ARC.md');
  assert.equal(readFileSync(join(versions, readdirSync(versions)[0]!), 'utf8'), '# Arc\n\n- Part 1: a door, edited by hand.\n');
});

test('drafts are saved and reload', async () => {
  const draft = await newDraft();
  assert.equal((await loadDraft(draft.id))?.kickoff, 'Go.');
  assert.equal(await loadDraft('../../etc'), undefined);
});
