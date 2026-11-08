import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A throwaway story, cache and studio folder, and a fake Gemini, so nothing real is touched or paid for.
const dir = mkdtempSync(join(tmpdir(), 'story-versions-'));
process.env.STORY_CACHE_DIR = join(dir, 'cache');
process.env.STORY_STUDIO_DIR = join(dir, 'studio');
process.env.GEMINI_API_KEY = 'test-key';
process.env.IMAGE_MAX_ATTEMPTS = '2';

let drawn = 0;
const verdicts: { ok: boolean; issues: string[] }[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { generationConfig: { responseModalities?: string[] } };
  const parts = body.generationConfig.responseModalities !== undefined
    ? [{ inlineData: { mimeType: 'image/png', data: Buffer.from(`image ${++drawn}`).toString('base64') } }]
    : [{ text: JSON.stringify(verdicts.shift() ?? { ok: true, issues: [] }) }];
  return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 });
}) as typeof fetch;

const { currentImage, fixShot, keepShot, shotImage, unkeepShot } = await import('../src/images.ts');
const { loadScene } = await import('../src/load.ts');
const { listVersions } = await import('../src/versions.ts');

writeFileSync(join(dir, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\n');
writeFileSync(join(dir, 'ep.yaml'), 'title: Versions test\ncast: cast.yaml\nshots:\n  - id: one\n    image: A door.\n');
const load = async () => {
  const scene = await loadScene(join(dir, 'ep.yaml'));
  return { scene, shot: scene.shots[0]! };
};
const read = (file: string | undefined): string => readFileSync(file ?? '', 'utf8');

test('every paid attempt is saved, and the cache uses the best one', async () => {
  verdicts.push({ ok: false, issues: ['extra hand'] }, { ok: false, issues: ['extra hand', 'wrong door'] });
  const { scene, shot } = await load();
  const image = await shotImage(scene, shot, { mock: false, check: true, regen: false });

  const versions = await listVersions(scene, shot);
  assert.deepEqual(versions.map((v) => [v.reason, v.attempt, read(v.file)]), [
    ['attempt', 1, 'image 1'],
    ['attempt', 2, 'image 2'],
  ]);
  assert.equal(read(image.file), 'image 1');
});

test('a fix is saved as a version and becomes the current image', async () => {
  const { scene, shot } = await load();
  await fixShot(scene, shot, 'remove the extra hand');
  const last = (await listVersions(scene, shot)).at(-1);
  assert.equal(last?.reason, 'fix');
  assert.equal(last?.instruction, 'remove the extra hand');
  assert.equal(read(await currentImage(scene, shot)), 'image 3');
});

test('fixing a kept image saves the kept one first', async () => {
  let { scene, shot } = await load();
  assert.equal(await keepShot(scene, shot), 'kept');
  ({ scene, shot } = await load());
  await fixShot(scene, shot, 'brighter');
  const versions = await listVersions(scene, shot);
  const before = versions.find((v) => v.reason === 'kept-before-fix');
  assert.equal(read(before?.file), 'image 3');
  ({ scene, shot } = await load());
  assert.equal(read(shot.keptFile), 'image 4');
  // Older versions are untouched by the fix.
  assert.deepEqual(versions.filter((v) => v.reason === 'attempt').map((v) => read(v.file)), ['image 1', 'image 2']);
});

test('redrawing a kept shot saves the kept image before unlocking it', async () => {
  const { scene, shot } = await load();
  const kept = shot.keptFile ?? '';
  await unkeepShot(scene, shot);
  assert.equal(existsSync(kept), false);
  const last = (await listVersions(scene, shot)).at(-1);
  assert.equal(last?.reason, 'kept-before-redraw');
  assert.equal(read(last?.file), 'image 4');
});
