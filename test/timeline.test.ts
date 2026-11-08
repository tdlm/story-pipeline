import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../src/env.ts';
import { loadScene } from '../src/load.ts';
import { parseMarkup, type Speech } from '../src/speech.ts';
import { buildTimeline } from '../src/timeline.ts';

// Run with UPDATE_SNAPSHOTS=1 to accept new timings after an intended change.
const SNAPSHOT = join(ROOT, 'test', 'snapshots', 'timeline.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const STORIES = join(ROOT, 'stories');
const scenes = readdirSync(STORIES, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.yaml') && basename(file) !== 'cast.yaml')
  .sort();

/** A line's length as the mock render voices it (src/speech.ts), without making any audio. */
function mockSpeech(text: string): Speech {
  const { tokens } = parseMarkup(text);
  return { file: '', duration: 0.4 + tokens.length * 0.36, words: [], spentCharacters: 0, fresh: false };
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

type Snapshot = Record<string, { total: number; shots: { id: string; start: number; duration: number; lines: number[] }[] }>;
const saved: Snapshot = existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot) : {};
const current: Snapshot = {};

for (const file of scenes) {
  test(`${file}: timeline matches the snapshot`, async (t) => {
    let scene;
    try {
      scene = await loadScene(join(STORIES, file));
    } catch (error) {
      // Images live outside git, so a fresh clone can't load scenes that reference them.
      if ((error as Error).message.includes('not found')) return t.skip('reference images are not on disk');
      throw error;
    }
    const timeline = buildTimeline(
      scene.shots.map((shot) => ({ transition: shot.transition, hold: shot.hold, speeches: shot.lines.map((line) => mockSpeech(line.text)) })),
    );
    const result = {
      total: round(timeline.total),
      shots: timeline.shots.map((timed, i) => ({
        id: scene.shots[i]?.id ?? '',
        start: round(timed.start),
        duration: round(timed.duration),
        lines: timed.lines.map((line) => round(line.start)),
      })),
    };
    current[file] = result;
    if (UPDATE) return;
    assert.ok(saved[file] !== undefined, `no snapshot for ${file}: run with UPDATE_SNAPSHOTS=1`);
    assert.deepEqual(result, saved[file]);
  });
}

test.after(() => {
  if (UPDATE) writeFileSync(SNAPSHOT, `${JSON.stringify({ ...saved, ...current }, null, 2)}\n`);
});
