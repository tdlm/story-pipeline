import { copyFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { env, requireKey } from './env.ts';
import { buildCaptions } from './captions.ts';
import { resolveCartesiaVoice } from './cartesia.ts';
import { remainingCredits, soundEffect, voiceProblems } from './elevenlabs.ts';
import { elevenLabsCost, parseVoice, speak, type Speech } from './speech.ts';
import { ffmpegInfo, probeDuration, REQUIRED_FILTERS } from './ffmpeg.ts';
import { needsImage, shotImage, unkeepShot, type ShotImage } from './images.ts';
import { loadScene, type Scene } from './load.ts';
import { withSceneLock } from './lock.ts';
import { buildTimeline, type TimedShot } from './timeline.ts';
import { ensureDir, log, mapPool } from './util.ts';
import { contactSheet, joinClips, mixAudio, mux, renderClip, type Sound } from './video.ts';

export type RenderOptions = {
  draft: boolean;
  mock: boolean;
  check: boolean;
  /** Shot ids (or "all") whose images should be made again. */
  regen: Set<string>;
  imagesOnly: boolean;
  yes: boolean;
  /** Cancels the render between steps. A step already running (an API call, an ffmpeg job) finishes first. */
  signal?: AbortSignal;
  /** Receives progress. Without it, log messages are printed. */
  onEvent?: (event: RenderEvent) => void;
  makeClip?: ClipMaker;
};

const MAX_IMAGES_WITHOUT_YES = 25;

const isRegen = (options: RenderOptions, id: string): boolean => options.regen.has('all') || options.regen.has(id);

async function preflight(scene: Scene, options: RenderOptions, log: (message: string) => void): Promise<void> {
  const { filters } = await ffmpegInfo();
  const missing = REQUIRED_FILTERS.filter((name) => !filters.has(name));
  if (missing.length > 0) {
    throw new Error(`Your ffmpeg is missing filters: ${missing.join(', ')}. Install a full build (macOS: brew install ffmpeg-full; it's found automatically).`);
  }

  const unknown = options.regen.has('all') ? [] : [...options.regen].filter((id) => !scene.shots.some((shot) => shot.id === id));
  if (unknown.length > 0) throw new Error(`--regen: no shot with id ${unknown.join(', ')}`);

  if (options.mock) return;

  const imageOptions = (id: string) => ({ mock: false, check: options.check, regen: isRegen(options, id) });
  const newImages = (await Promise.all(scene.shots.map((shot) => needsImage(scene, shot, imageOptions(shot.id))))).filter(Boolean).length;
  if (newImages > 0) requireKey('geminiKey');
  if (newImages > MAX_IMAGES_WITHOUT_YES && !options.yes) {
    const cost = newImages * env.imageCostUsd * (options.check ? 1.3 : 1);
    throw new Error(`This run would generate about ${newImages} images (~$${cost.toFixed(2)}). Re-run with --yes to go ahead.`);
  }
  if (newImages > 0) log(`  ${newImages} new image${newImages === 1 ? '' : 's'} to generate (~$${(newImages * env.imageCostUsd).toFixed(2)} before retries)`);

  if (options.imagesOnly) return;

  const lines = scene.shots.flatMap((shot) => shot.lines);

  // Cartesia voices: the key must be set and every name must resolve to one voice.
  const cartesiaRefs = [...new Set(lines.map((line) => parseVoice(line.voice)).filter((v) => v.provider === 'cartesia').map((v) => v.ref))];
  if (cartesiaRefs.length > 0) {
    requireKey('cartesiaKey');
    for (const ref of cartesiaRefs) await resolveCartesiaVoice(ref);
  }

  const elevenLines = lines.filter((line) => parseVoice(line.voice).provider === 'elevenlabs');
  const characters = elevenLines.reduce(
    (sum, line) => sum + elevenLabsCost({ text: line.text, voice: line.voice, settings: line.settings, draft: options.draft, mock: false }),
    0,
  );
  const needsEleven = characters > 0 || scene.shots.some((shot) => shot.sfx.length > 0);
  if (!needsEleven) return;

  requireKey('elevenKey');
  const problems = await voiceProblems(elevenLines.map((line) => parseVoice(line.voice).ref));
  if (problems.length > 0) {
    throw new Error(`Voice problems:\n- ${problems.join('\n- ')}\nRun \`pnpm voices\` and update cast.yaml.`);
  }
  const credits = await remainingCredits();
  if (characters > credits.remaining) {
    throw new Error(`This run needs about ${characters} ElevenLabs credits but only ${credits.remaining} are left.`);
  }
  log(`  ${characters} characters of new speech (${credits.remaining.toLocaleString()} credits left)`);
}

/** Where a render is. The CLI prints only `log` events; the studio shows all of them. */
export type RenderStage = 'images' | 'voices' | 'sound' | 'video' | 'mix';

export type RenderEvent =
  | { type: 'log'; message: string }
  | { type: 'stage'; stage: RenderStage }
  | { type: 'progress'; stage: RenderStage; done: number; total: number }
  | { type: 'shot'; id: string; status: 'kept' | 'cached' | 'generated'; attempt: number; issues: string[] }
  | { type: 'finished'; video?: string; report: string };

/** Makes one shot's clip. Swappable, so code-drawn animation can replace camera moves later. */
export type ClipMaker = typeof renderClip;

/** Prints log events, exactly as the CLI always has. */
const printLogs = (event: RenderEvent): void => {
  if (event.type === 'log') log(event.message);
};

/** One render in progress: the scene, its folders and how it reports. */
type Run = {
  scene: Scene;
  options: RenderOptions;
  outDir: string;
  work: string;
  started: number;
  emit: (event: RenderEvent) => void;
  log: (message: string) => void;
  /** Throws if the render was cancelled. Called before each unit of work. */
  check: () => void;
};

/** Runs `fn` over items with a concurrency limit, checking for cancel before each and reporting progress. */
async function each<T, R>(run: Run, stage: RenderStage, items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  let done = 0;
  run.emit({ type: 'progress', stage, done, total: items.length });
  return mapPool(items, limit, async (item, index) => {
    run.check();
    const result = await fn(item, index);
    run.emit({ type: 'progress', stage, done: ++done, total: items.length });
    return result;
  });
}

function startStage(run: Run, stage: RenderStage, label: string): void {
  run.check();
  run.emit({ type: 'stage', stage });
  run.log(`▸ ${label}`);
}

/** 1. Images first: they cost the most to redo, so you can review them before paying for audio. */
async function drawImages(run: Run): Promise<{ images: ShotImage[]; shotFiles: string[] }> {
  const { scene, options, outDir } = run;
  startStage(run, 'images', 'Images');
  const images = await each(run, 'images', scene.shots, 3, async (shot) => {
    const regen = isRegen(options, shot.id);
    const image = await shotImage(scene, shot, { mock: options.mock, check: options.check, regen });
    if (regen && shot.keptFile !== undefined && !options.mock) {
      // A redrawn shot is no longer the approved one; keep it again once you like it.
      await unkeepShot(scene, shot);
      run.log(`  ${shot.id}: unkept (redrawn; the kept image is saved as a version)`);
    }
    const status = image.kept === true ? 'kept' : image.cached ? 'cached' : 'generated';
    run.emit({ type: 'shot', id: shot.id, status, attempt: image.attempt, issues: image.issues });
    const label = status === 'generated' ? `generated (attempt ${image.attempt})` : status;
    run.log(`  ${shot.id}: ${label}${image.issues.length > 0 ? `, still has issues: ${image.issues.join('; ')}` : ''}`);
    return image;
  });
  const shotFiles = await Promise.all(
    scene.shots.map(async (shot, i) => {
      const image = images[i] as ShotImage;
      const file = join(outDir, 'shots', `${String(shot.index + 1).padStart(2, '0')}-${shot.id}${extname(image.file)}`);
      await copyFile(image.file, file);
      return file;
    }),
  );
  const sheet = join(outDir, 'contact-sheet.jpg');
  await contactSheet(shotFiles, sheet, scene.width, scene.height);
  run.log(`  Contact sheet: ${relative(process.cwd(), sheet)}`);
  return { images, shotFiles };
}

/** 2. Voices. Each line hears the same speaker's previous and next line, so the delivery flows across shots. */
async function voiceLines(run: Run): Promise<Speech[][]> {
  const { scene, options } = run;
  startStage(run, 'voices', 'Voices');
  const allLines = scene.shots.flatMap((shot) => shot.lines);
  const neighbour = (line: (typeof allLines)[number], step: -1 | 1): string | undefined => {
    for (let i = allLines.indexOf(line) + step; i >= 0 && i < allLines.length; i += step) {
      if (allLines[i]?.speaker === line.speaker) return allLines[i]?.text;
    }
    return undefined;
  };
  let done = 0;
  run.emit({ type: 'progress', stage: 'voices', done, total: allLines.length });
  return mapPool(scene.shots, 2, (shot) =>
    mapPool(shot.lines, 2, async (line) => {
      run.check();
      const speech = await speak({
        text: line.text,
        voice: line.voice,
        settings: line.settings,
        draft: options.draft,
        mock: options.mock,
        previousText: neighbour(line, -1),
        nextText: neighbour(line, 1),
      });
      run.emit({ type: 'progress', stage: 'voices', done: ++done, total: allLines.length });
      return speech;
    }),
  );
}

type Effect = { file: string; generated: boolean; start: number; volume: number; voice: false };

/** 4. Sound effects: each layer starts `at` seconds into its shot and by default lasts the rest of it. */
async function makeSounds(run: Run, timeline: { shots: TimedShot[] }): Promise<Effect[]> {
  const { scene, options } = run;
  startStage(run, 'sound', 'Sound');
  const layers = scene.shots.flatMap((shot, i) => {
    const timed = timeline.shots[i] as TimedShot;
    return shot.sfx.map((layer) => ({ ...layer, start: timed.start + layer.at, length: layer.seconds ?? Math.max(1, timed.duration - layer.at) }));
  });
  // Repeated layers (the same sound and length) share one generation.
  const pending = new Map<string, ReturnType<typeof soundEffect>>();
  const effectFor = (sound: string, length: number): ReturnType<typeof soundEffect> => {
    const key = `${Math.ceil(length)}|${sound}`;
    const existing = pending.get(key);
    if (existing !== undefined) return existing.then((effect) => ({ ...effect, generated: false }));
    const created = soundEffect(sound, length, options.mock);
    pending.set(key, created);
    return created;
  };
  return each(run, 'sound', layers, 2, async (layer) => {
    const effect = await effectFor(layer.sound, layer.length);
    return { file: effect.file, generated: effect.generated, start: layer.start, volume: layer.volume, voice: false as const };
  });
}

/** 5. Picture: one clip per shot, then crossfades. */
async function makePicture(run: Run, timeline: { shots: TimedShot[]; total: number }, shotFiles: string[]): Promise<string> {
  const { scene, work } = run;
  const makeClip = run.options.makeClip ?? renderClip;
  startStage(run, 'video', 'Video');
  const clips = await each(run, 'video', scene.shots, 2, async (shot, i) => {
    const timed = timeline.shots[i] as TimedShot;
    const file = join(work, `clip-${String(i + 1).padStart(2, '0')}.mp4`);
    await makeClip({
      image: shotFiles[i] as string,
      out: file,
      seconds: timed.duration,
      move: shot.move,
      width: scene.width,
      height: scene.height,
      dim: shot.card !== undefined,
    });
    return { file, start: timed.start, transition: shot.transition, transitionIn: timed.transitionIn };
  });
  run.check();
  const picture = join(work, 'picture.mp4');
  await joinClips(clips, picture);
  const pictureLength = await probeDuration(picture);
  if (Math.abs(pictureLength - timeline.total) > 0.2) {
    throw new Error(`The joined picture is ${pictureLength.toFixed(2)}s but the timeline is ${timeline.total.toFixed(2)}s. Please report this.`);
  }
  return picture;
}

/** 6. Sound mix, captions, and the finished video. */
async function mixAndMux(run: Run, timeline: { shots: TimedShot[]; total: number }, effects: Effect[]): Promise<string> {
  const { scene, options, work, outDir } = run;
  run.check();
  run.emit({ type: 'stage', stage: 'mix' });
  const sounds: Sound[] = [
    ...timeline.shots.flatMap((timed, i) =>
      timed.lines.map((line, j) => ({
        file: line.speech.file,
        start: line.start,
        volume: 1,
        voice: true,
        fx: scene.shots[i]?.lines[j]?.fx,
      })),
    ),
    ...effects,
  ];
  await mixAudio({
    sounds,
    music: scene.music === undefined ? undefined : { file: scene.music, volume: scene.musicVolume },
    total: timeline.total,
    out: join(work, 'mix.wav'),
  });

  let captions: string | undefined;
  const cards = scene.shots.flatMap((shot, i) => {
    const timed = timeline.shots[i];
    return shot.card === undefined || timed === undefined
      ? []
      : [{ start: timed.start + timed.transitionIn, end: timed.start + timed.duration, text: shot.card }];
  });
  if (scene.captions || scene.header !== undefined || cards.length > 0) {
    captions = 'captions.ass';
    const lines = scene.captions
      ? timeline.shots.flatMap((timed) => timed.lines.map((line) => ({ start: line.start, words: line.speech.words })))
      : [];
    const ass = buildCaptions(lines, {
      width: scene.width,
      height: scene.height,
      font: env.captionFont,
      total: timeline.total,
      header: scene.header,
      cards,
    });
    await writeFile(join(work, captions), ass);
  }

  run.check();
  const video = join(outDir, `${scene.slug}${options.mock ? '-mock' : options.draft ? '-draft' : ''}.mp4`);
  await mux({ cwd: work, video: 'picture.mp4', audio: 'mix.wav', captions, out: video, draft: options.draft });
  return video;
}

/**
 * Renders a scene in stages: images, voices, timing, sound, picture, mix. One render per scene at a time,
 * across every process. `signal` cancels between steps; `onEvent` reports progress (the CLI prints the logs).
 */
export async function render(scenePath: string, options: RenderOptions): Promise<void> {
  const scene = await loadScene(scenePath);
  await withSceneLock(scene, () => renderScene(scene, options));
}

async function renderScene(scene: Scene, options: RenderOptions): Promise<void> {
  const emit = options.onEvent ?? printLogs;
  const outDir = join(env.outDir, scene.slug);
  const run: Run = {
    scene,
    options,
    outDir,
    work: join(outDir, 'work'),
    started: Date.now(),
    emit,
    log: (message) => emit({ type: 'log', message }),
    check: () => options.signal?.throwIfAborted(),
  };
  await ensureDir(join(outDir, 'shots'));
  await ensureDir(run.work);

  run.log(`▸ ${scene.title}: ${scene.shots.length} shots, ${scene.aspect}${options.mock ? ', mock' : ''}${options.draft ? ', draft' : ''}`);
  await preflight(scene, options, run.log);

  const { images, shotFiles } = await drawImages(run);
  if (options.imagesOnly) {
    const report = await writeReport({ scene, options, outDir, images, video: undefined, started: run.started });
    emit({ type: 'finished', report });
    return;
  }

  const speeches = await voiceLines(run);
  const spentCharacters = speeches.flat().reduce((sum, speech) => sum + speech.spentCharacters, 0);

  // 3. Timing: every shot lasts as long as its lines.
  const timeline = buildTimeline(
    scene.shots.map((shot, i) => ({ transition: shot.transition, hold: shot.hold, speeches: speeches[i] as Speech[] })),
  );

  const effects = await makeSounds(run, timeline);
  await makePicture(run, timeline, shotFiles);
  const video = await mixAndMux(run, timeline, effects);

  const report = await writeReport({
    scene,
    options,
    outDir,
    images,
    video: { file: video, timeline: timeline.shots, total: timeline.total, spentCharacters, effects: effects.filter((e) => e.generated).length },
    started: run.started,
  });
  emit({ type: 'finished', video, report });
  run.log(`✓ ${relative(process.cwd(), video)} (${timeline.total.toFixed(1)}s)`);
}

async function writeReport(input: {
  scene: Scene;
  options: RenderOptions;
  outDir: string;
  images: ShotImage[];
  video?: { file: string; timeline: TimedShot[]; total: number; spentCharacters: number; effects: number };
  started: number;
}): Promise<string> {
  const { scene, options, images, video } = input;
  const generated = images.reduce((sum, image) => sum + image.generated, 0);
  const mode = options.mock ? 'mock' : options.draft ? 'draft' : 'final';
  const lines = [
    `# ${scene.title}`,
    '',
    `- Mode: ${mode}, ${scene.aspect}, rendered ${new Date().toLocaleString()} in ${Math.round((Date.now() - input.started) / 1000)}s`,
    `- Images: ${generated} generated this run (~$${(generated * env.imageCostUsd).toFixed(2)}), ${images.filter((i) => i.cached).length} reused`,
  ];
  if (video !== undefined) {
    lines.push(
      `- Video: ${relative(input.outDir, video.file)}, ${video.total.toFixed(1)}s`,
      `- ElevenLabs: ${video.spentCharacters} characters of new speech, ${video.effects} new sound effects`,
    );
  }
  lines.push('', '| # | Shot | Starts | Length | Lines | Image |', '|---|---|---|---|---|---|');
  scene.shots.forEach((shot, i) => {
    const image = images[i] as ShotImage;
    const timed = video?.timeline[i];
    const imageNote =
      shot.imageFile !== undefined ? 'your file' : image.kept === true ? 'kept' : image.cached ? 'reused' : `attempt ${image.attempt}`;
    lines.push(
      `| ${i + 1} | ${shot.id} | ${timed === undefined ? '-' : `${timed.start.toFixed(1)}s`} | ${timed === undefined ? '-' : `${timed.duration.toFixed(1)}s`} | ${shot.lines.length} | ${imageNote}${image.issues.length > 0 ? ' ⚠️' : ''} |`,
    );
  });

  const flagged = scene.shots.filter((_, i) => (images[i] as ShotImage).issues.length > 0);
  if (flagged.length > 0) {
    lines.push('', '## Needs a look', '');
    for (const shot of flagged) {
      lines.push(`- **${shot.id}**: ${(images[shot.index] as ShotImage).issues.join('; ')}. Fix the prompt or run with \`--regen ${shot.id}\`.`);
    }
  }
  const file = join(input.outDir, 'report.md');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}
