import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

// A throwaway story and cache, so the test never touches the real ones.
const dir = mkdtempSync(join(tmpdir(), 'story-cache-'));
process.env.STORY_CACHE_DIR = join(dir, 'cache');
const { currentImage, imageKey, needsImage, shotImage } = await import('../src/images.ts');
const { loadScene } = await import('../src/load.ts');
const { speak } = await import('../src/speech.ts');

writeFileSync(join(dir, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\n');
writeFileSync(join(dir, 'ep.yaml'), 'title: Cache test\ncast: cast.yaml\nshots:\n  - id: one\n    image: A door.\n');
const imagesDir = join(dir, 'cache', 'images');
const STALE = '/sessions/some-old-vm/mnt/story-pipeline/.cache';

test('an image entry from another machine still finds its file', async () => {
  const scene = await loadScene(join(dir, 'ep.yaml'));
  const shot = scene.shots[0]!;
  // A mock render writes a real entry and image.
  const { file } = await shotImage(scene, shot, { mock: true, check: false, regen: false });
  // Make a real-model entry that stores the old absolute path, as older runs did.
  const key = await imageKey(scene, shot, false);
  writeFileSync(join(imagesDir, `${key}-1.png`), readFileSync(file));
  writeFileSync(join(imagesDir, `${key}.json`), JSON.stringify({ file: `${STALE}/images/${key}-1.png`, attempt: 1, issues: [] }));

  assert.equal(await currentImage(scene, shot), join(imagesDir, `${key}-1.png`));
  assert.equal(await needsImage(scene, shot, { mock: false, check: false, regen: false }), false);
  const image = await shotImage(scene, shot, { mock: false, check: false, regen: false });
  assert.equal(image.cached, true);
});

test('new image entries store a file name, not a path', async () => {
  const scene = await loadScene(join(dir, 'ep.yaml'));
  const key = await imageKey(scene, scene.shots[0]!, true);
  const stored = JSON.parse(readFileSync(join(imagesDir, `${key}.json`), 'utf8')) as { file: string };
  assert.equal(stored.file, basename(stored.file));
});

test('a voice line from another machine is reused, not remade', async () => {
  const options = { text: 'Hello there.', voice: 'test-voice', draft: false, mock: true };
  const first = await speak(options);
  const metaFile = first.file.replace(/\.[a-z0-9]+$/, '.json');
  const stored = JSON.parse(readFileSync(metaFile, 'utf8')) as { file: string };
  assert.equal(stored.file, basename(first.file));

  writeFileSync(metaFile, JSON.stringify({ ...stored, file: `${STALE}/tts/${stored.file}` }));
  const made = statSync(first.file).mtimeMs;
  const again = await speak(options);
  assert.equal(again.file, first.file);
  assert.equal(statSync(first.file).mtimeMs, made);
});
