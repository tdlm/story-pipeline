import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Mock renders of a tiny scene, entirely in temp folders. Needs ffmpeg, like any render.
const dir = mkdtempSync(join(tmpdir(), 'story-render-'));
process.env.STORY_CACHE_DIR = join(dir, 'cache');
process.env.STORY_STUDIO_DIR = join(dir, 'studio');
process.env.STORY_OUT_DIR = join(dir, 'out');
const { render } = await import('../src/render.ts');
const { renderClip } = await import('../src/video.ts');
type RenderEvent = Parameters<NonNullable<Parameters<typeof render>[1]['onEvent']>>[0];

writeFileSync(join(dir, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\n');
writeFileSync(
  join(dir, 'ep.yaml'),
  [
    'title: Render test',
    'captions: false',
    'shots:',
    '  - image: A door.',
    '    lines:',
    '      - narrator: Knock knock.',
    '  - image: A hatch.',
    '    transition: fade',
    '    sfx: wind',
    '    lines:',
    '      - narrator: Who is there?',
    '',
  ].join('\n'),
);
const scene = join(dir, 'ep.yaml');
const base = { draft: false, mock: true, check: false, regen: new Set<string>(), imagesOnly: false, yes: false };

test('reports each stage in order and finishes with the video', async () => {
  const events: RenderEvent[] = [];
  await render(scene, { ...base, onEvent: (event) => events.push(event) });
  const stages = events.flatMap((e) => (e.type === 'stage' ? [e.stage] : []));
  assert.deepEqual(stages, ['images', 'voices', 'sound', 'video', 'mix']);
  const shots = events.filter((e) => e.type === 'shot');
  assert.equal(shots.length, 2);
  const lastImages = events.filter((e) => e.type === 'progress' && e.stage === 'images').at(-1);
  assert.deepEqual(lastImages, { type: 'progress', stage: 'images', done: 2, total: 2 });
  const finished = events.at(-2);
  assert.equal(finished?.type, 'finished');
  assert.ok(finished?.type === 'finished' && finished.video !== undefined && existsSync(finished.video));
});

test('a cancelled render stops before the next step', async () => {
  const controller = new AbortController();
  const stages: string[] = [];
  await assert.rejects(
    render(scene, {
      ...base,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type !== 'stage') return;
        stages.push(event.stage);
        if (event.stage === 'voices') controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(stages, ['images', 'voices']);
});

test('a second render of the same scene is refused while one runs', async () => {
  const first = render(scene, { ...base, onEvent: () => undefined });
  await assert.rejects(render(scene, { ...base, onEvent: () => undefined }), /already rendering/);
  await first;
  // The lock is released afterwards.
  await render(scene, { ...base, imagesOnly: true, onEvent: () => undefined });
});

test('clips come from the swappable clip maker', async () => {
  let made = 0;
  await render(scene, {
    ...base,
    onEvent: () => undefined,
    makeClip: async (options) => {
      made += 1;
      await renderClip(options);
    },
  });
  assert.equal(made, 2);
});
