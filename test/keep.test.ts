import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A throwaway story and cache, so the test never touches the real ones.
const dir = mkdtempSync(join(tmpdir(), 'story-keep-'));
process.env.STORY_CACHE_DIR = join(dir, 'cache');
const { imageKey, keepShot } = await import('../src/images.ts');
const { loadScene } = await import('../src/load.ts');

writeFileSync(join(dir, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\n');
writeFileSync(
  join(dir, 'ep.yaml'),
  'title: Keep test\ncast: cast.yaml\nshots:\n  - id: one\n    image: A door.\n    lines:\n      - narrator: Hello.\n',
);
const scenePath = join(dir, 'ep.yaml');

/** Points the shot's cache entry at a new image, as a render or `pnpm fix` does. */
async function cacheImage(content: string): Promise<void> {
  const scene = await loadScene(scenePath);
  const shot = scene.shots[0]!;
  const imagesDir = join(dir, 'cache', 'images');
  mkdirSync(imagesDir, { recursive: true });
  const key = await imageKey(scene, shot, false);
  const file = join(imagesDir, `${key}-${content}.png`);
  writeFileSync(file, content);
  writeFileSync(join(imagesDir, `${key}.json`), JSON.stringify({ file, attempt: 1, issues: [] }));
}

async function keep(): Promise<string> {
  const scene = await loadScene(scenePath);
  return keepShot(scene, scene.shots[0]!);
}

const kept = (): string => readFileSync(join(dir, 'kept', 'ep', 'one.png'), 'utf8');

test('a shot with no image yet is not kept', async () => {
  assert.equal(await keep(), 'no image');
});

test('keep takes the latest fix, not the last render', async () => {
  await cacheImage('rendered');
  await cacheImage('fixed'); // pnpm fix, with no render after it
  assert.equal(await keep(), 'kept');
  assert.equal(kept(), 'fixed');
});

test('keeping again leaves the kept image alone', async () => {
  await cacheImage('newer');
  assert.equal(await keep(), 'already kept');
  assert.equal(kept(), 'fixed');
});
