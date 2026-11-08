import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'story-media-'));
process.env.STORY_STORIES_DIR = join(dir, 'stories');
process.env.STORY_OUT_DIR = join(dir, 'out');
const { mediaFile, mediaUrl } = await import('../studio/server/media.ts');
const { ROOT } = await import('../src/env.ts');

test('media URLs round-trip through their named folder', () => {
  const file = join(dir, 'stories', 'hatch', 'kept', 'ep 01', 'a.jpg');
  const url = mediaUrl(file);
  assert.equal(url, '/api/media/stories/hatch/kept/ep%2001/a.jpg');
  assert.equal(mediaFile(url!.slice('/api/media/'.length)), file);
});

test('files outside the media folders get no URL', () => {
  assert.equal(mediaUrl(join(ROOT, '.env')), undefined);
});

test('paths that climb out of a folder are refused', () => {
  assert.equal(mediaFile('stories/..%2F..%2F.env'), undefined);
  assert.equal(mediaFile('stories/%2e%2e/x'), undefined);
  assert.equal(mediaFile('.env'), undefined);
  assert.equal(mediaFile('root/.env'), undefined);
});
