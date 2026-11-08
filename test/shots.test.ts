import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A throwaway show, cache and studio folder, and a fake Gemini that draws "image N".
const dir = mkdtempSync(join(tmpdir(), 'story-shots-'));
process.env.STORY_STORIES_DIR = join(dir, 'stories');
process.env.STORY_CACHE_DIR = join(dir, 'cache');
process.env.STORY_STUDIO_DIR = join(dir, 'studio');
process.env.GEMINI_API_KEY = 'test-key';
let drawn = 0;
globalThis.fetch = (async () => {
  const parts = [{ inlineData: { mimeType: 'image/png', data: Buffer.from(`image ${++drawn}`).toString('base64') } }];
  return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 });
}) as typeof fetch;

const show = join(dir, 'stories', 'demo');
mkdirSync(show, { recursive: true });
writeFileSync(join(show, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\ncharacters:\n  dana:\n    description: A neighbour.\n    voice: test-voice\n');
const episode = [
  'title: Demo',
  '# A comment that must survive.',
  'shots:',
  '  - id: door',
  '    image: >',
  '      A door in the dark, with a long prompt that wraps over',
  '      two lines.',
  '    lines:',
  '      - narrator: "Someone knocks."',
  '  - id: hatch',
  '    image: A hatch.',
  '',
].join('\n');
writeFileSync(join(show, 'ep01.yaml'), episode);
const file = join(show, 'ep01.yaml');

const { editShot, fixShotPicture, keepShotPicture, redrawShot, useShotVersion, fileRev } = await import('../studio/server/shots.ts');
const { getEpisode } = await import('../studio/server/library.ts');
const load = async () => (await getEpisode('demo', 'ep01'))!;
const read = (url: string | undefined) => readFileSync(join(dir, url!.replace('/api/media/stories/', 'stories/').replace(/^\/api\/media\/(\w+)\//, (_, root: string) => `${{ images: 'cache/images', versions: 'studio/versions' }[root] ?? root}/`)).split('/').map(decodeURIComponent).join('/'), 'utf8');

test('editing lines changes only that shot and keeps the rest of the file', async () => {
  const rev = (await load()).rev;
  await editShot(file, 1, rev, { lines: [{ speaker: 'narrator', text: 'Someone knocks.' }, { speaker: 'dana', text: 'Open up!' }] });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# A comment that must survive\./);
  assert.match(text, /- dana: Open up!/);
  assert.match(text, /  - id: hatch\n    image: A hatch\.\n$/);
});

test('an edit from an old copy is refused', async () => {
  await assert.rejects(editShot(file, 1, fileRev('old'), { lines: [] }), /changed since you opened it/);
});

test('an edit the engine can’t load is refused and the file is untouched', async () => {
  const before = readFileSync(file, 'utf8');
  await assert.rejects(editShot(file, 2, (await load()).rev, { lines: [{ speaker: 'nobody', text: 'Hi.' }] }), /unknown speaker/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('drawing, keeping, fixing and switching versions', async () => {
  assert.equal((await load()).shotList[0]?.state, 'not-drawn');
  await redrawShot(file, 1);
  let shot = (await load()).shotList[0]!;
  assert.equal(shot.state, 'to-review');
  assert.equal(read(shot.image), 'image 1');

  // Changing the prompt marks the picture out of date; it isn't redrawn.
  await editShot(file, 1, (await load()).rev, { image: 'A different door.' });
  shot = (await load()).shotList[0]!;
  assert.equal(shot.state, 'out-of-date');
  assert.match(readFileSync(file, 'utf8'), /image: >\n      A different door\.\n/);
  assert.equal(drawn, 1);

  await redrawShot(file, 1);
  await keepShotPicture(file, 1);
  await fixShotPicture(file, 1, 'brighter');
  shot = (await load()).shotList[0]!;
  assert.equal(shot.state, 'kept');
  assert.equal(read(shot.image), 'image 3');

  // Going back to the first drawing.
  const first = shot.versions.find((v) => v.reason === 'attempt')!;
  await useShotVersion(file, 1, first.name);
  shot = (await load()).shotList[0]!;
  assert.equal(read(shot.image), 'image 1');
  assert.ok(shot.versions.some((v) => v.reason === 'kept-before-restore'));
});

test('unkeeping leaves the picture in place to review, and a new prompt marks it out of date', async () => {
  await keepShotPicture(file, 2).catch(() => undefined);
  await redrawShot(file, 2);
  await keepShotPicture(file, 2);
  const { unkeepShotPicture } = await import('../studio/server/shots.ts');
  await unkeepShotPicture(file, 2);
  let shot = (await load()).shotList[1]!;
  assert.equal(shot.state, 'to-review');
  await editShot(file, 2, (await load()).rev, { image: 'A different hatch.' });
  shot = (await load()).shotList[1]!;
  assert.equal(shot.state, 'out-of-date');
  assert.ok(shot.image !== undefined);
});
