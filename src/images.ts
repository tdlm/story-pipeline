import { existsSync } from 'node:fs';
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { env } from './env.ts';
import { ffmpeg } from './ffmpeg.ts';
import {
  EXT_BY_MIME,
  MIME_BY_EXT,
  bufferPart,
  generateContent,
  imagePart,
  responseParts,
  responseText,
  type Part,
} from './gemini.ts';
import { refsForShot, type Ref, type Scene, type Shot } from './load.ts';
import { cachedPath, ensureDir, fileSha, log, sha } from './util.ts';

const CACHE = join(env.cacheDir, 'images');

export type ShotImage = {
  file: string;
  /** Attempt number that produced the kept image (0 for image_file shots). */
  attempt: number;
  /** Problems the checker still saw in the kept image. Empty means it passed or wasn't checked. */
  issues: string[];
  /** Images paid for during this run. */
  generated: number;
  cached: boolean;
  /** Locked with `pnpm keep`: never redrawn unless you --regen it. */
  kept?: boolean;
};

export type ImageOptions = { mock: boolean; check: boolean; regen: boolean };

const ORIENTATION: Record<Scene['aspect'], string> = {
  '9:16': 'tall vertical frame for phone video (9:16)',
  '16:9': 'wide horizontal frame (16:9)',
  '1:1': 'square frame (1:1)',
  '4:5': 'slightly tall frame (4:5)',
};

export function buildPrompt(scene: Scene, shot: Shot): string {
  const { cast } = scene;
  const lines = [`Style: ${cast.style.trim()}`, '', `Shot: ${shot.prompt ?? ''}`];

  if (shot.location !== undefined) {
    lines.push(`Location: ${cast.locations[shot.location]?.description.trim() ?? ''}`);
  }
  if (shot.cast.length > 0) {
    lines.push('Characters in this shot (match their reference images exactly):');
    for (const name of shot.cast) lines.push(`- ${name}: ${cast.characters[name]?.description.trim() ?? ''}`);
    lines.push('No other characters appear.');
  } else {
    lines.push('No characters appear unless the shot description mentions them.');
  }
  if (shot.props.length > 0) {
    lines.push('Props (match their reference images):');
    for (const name of shot.props) lines.push(`- ${name}: ${cast.props[name]?.description.trim() ?? ''}`);
  }

  if (shot.avoid.length > 0) lines.push(`Do not show: ${shot.avoid.join('; ')}.`);
  lines.push(`Composition: ${ORIENTATION[scene.aspect]}.`);
  if (scene.aspect === '9:16') {
    lines.push('Keep faces and the key action in the middle of the frame, away from the top 15% and bottom 25%.');
  }
  lines.push('No captions, titles, speech bubbles, logos or watermarks. Never label or annotate people, animals, wounds, food or furniture: no handwritten words, names or arrows pointing at things. Printed labels on tins and jars, and writing on papers and screens, are fine.');
  return lines.join('\n');
}

class NoImageError extends Error {}

type Image = { data: Buffer; mime: string };

/**
 * Draws a new image, or, with `edit`, changes only what `edit.fixes` lists in an existing one.
 * Editing keeps everything that was already right, so it converges faster than redrawing.
 */
type Mode = { kind: 'edit'; image: Image; fixes: string[] } | { kind: 'plate'; image: Image; relight: boolean };

/**
 * Draws a shot. Modes:
 * - none: from scratch.
 * - plate: edits a picture of the set into the shot, so the room's layout can't drift.
 * - edit: changes only `fixes` in an existing image, keeping everything else.
 */
async function generate(prompt: string, refs: Ref[], aspect: string, mode?: Mode): Promise<Image> {
  const parts: Part[] = [];
  if (refs.length > 0) {
    parts.push({
      text: 'Reference images follow. Match them exactly: character designs, proportions, relative heights, faces, clothing, distinctive features, props and locations. Ignore any text labels in them.',
    });
    for (const ref of refs) {
      parts.push({ text: `Reference: ${ref.label}` });
      parts.push(await imagePart(ref.path));
    }
  }
  if (mode === undefined) {
    parts.push({ text: prompt });
  } else if (mode.kind === 'plate') {
    parts.push(
      { text: 'SET PLATE (the exact location for this shot):' },
      bufferPart(mode.image.data, mode.image.mime),
      {
        text: mode.relight
          ? `Edit this set image into the shot described below. Keep the room exactly as it is: the walls, ladder, pipes, furniture, where everything stands and the drawing style. Change the lighting to what the shot describes. Only add or change what the shot needs (lighting, characters, their poses, small details). Keep this framing.\n\n${prompt}`
          : `Edit this set image into the shot described below. Keep the room exactly as it is: the walls, ladder, pipes, furniture, where everything stands, the lighting and the drawing style. Only add or change what the shot needs (characters, their poses, small details). Keep this framing.\n\n${prompt}`,
      },
    );
  } else {
    parts.push(
      { text: 'IMAGE TO EDIT:' },
      bufferPart(mode.image.data, mode.image.mime),
      {
        text: `Edit this image. Change only the following, and keep everything else exactly as it is (composition, characters, poses, lighting, colors and style):\n- ${mode.fixes.join('\n- ')}\n\nFor context, the shot is meant to be:\n${prompt}`,
      },
    );
  }

  const response = await generateContent(
    env.imageModel,
    parts,
    { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect, imageSize: env.imageSize } },
    mode === undefined ? 'Gemini image' : `Gemini image ${mode.kind}`,
  );
  const image = responseParts(response)
    .filter((part) => part.inlineData !== undefined && part.thought !== true)
    .at(-1)?.inlineData;
  if (image === undefined) {
    const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason ?? 'unknown';
    throw new NoImageError(`Gemini returned no image (reason: ${reason}). ${responseText(response).slice(0, 200)}`);
  }
  return { data: Buffer.from(image.data, 'base64'), mime: image.mimeType };
}

const verdictSchema = z.object({ ok: z.boolean(), issues: z.array(z.string()).default([]) });

// Lenient on purpose: every failure pays for another image. Only fail what a viewer would notice
// on a phone in two seconds. Image models can't reliably do left/right, so never fail on sides.
const CHECK_INSTRUCTIONS = `You check continuity for an illustrated story series that viewers watch on a phone, a few seconds per image.
Compare the CANDIDATE image with the REFERENCE images and the shot description.
Fail it ONLY for problems a casual viewer would notice in two seconds:
- a character is clearly off-model: a different head, hair, body type or clothing, or their distinctive feature is missing
- a required character is missing, or an extra character appears
- broken anatomy: extra or missing limbs or hands, merged bodies
- a prop or location has clearly the wrong shape (for example round instead of square)
- physically impossible staging (for example a ladder lying flat where it should stand)
- the main action of the shot is clearly wrong
- big captions, titles, speech bubbles or watermarks
NEVER fail for:
- which side something is on (left or right arm, mirrored details)
- scribbles, labels or numbers on objects, papers, dials or clocks
- small details: exact hand positions, gaze direction, number of lights, sound lines, small props
- style or color differences
When in doubt, pass it.
Reply with JSON only: {"ok": boolean, "issues": [short, specific problems]}.`;

async function check(
  image: { data: Buffer; mime: string },
  refs: Ref[],
  prompt: string,
  avoid: string[] = [],
): Promise<{ ok: boolean; issues: string[] }> {
  const parts: Part[] = [{ text: CHECK_INSTRUCTIONS }];
  if (avoid.length > 0) {
    parts.push({ text: `Also FAIL it if any of these can be seen, even small or in the background:\n- ${avoid.join('\n- ')}` });
  }
  for (const ref of refs) {
    parts.push({ text: `REFERENCE: ${ref.label}` });
    parts.push(await imagePart(ref.path));
  }
  parts.push({ text: 'CANDIDATE:' }, bufferPart(image.data, image.mime), { text: `Shot description:\n${prompt}` });

  const response = await generateContent(
    env.checkModel,
    parts,
    { responseMimeType: 'application/json', temperature: 0 },
    'Gemini check',
  );
  try {
    return verdictSchema.parse(JSON.parse(responseText(response)));
  } catch {
    return { ok: true, issues: ['The checker gave an unreadable answer, so this image was kept unchecked.'] };
  }
}

const MOCK_COLORS = ['0x2b2d42', '0x3d405b', '0x354f52', '0x52489c', '0x6b4226', '0x264653', '0x463f3a', '0x2f3e46'];

async function mockImage(scene: Scene, shot: Shot, file: string): Promise<void> {
  const color = MOCK_COLORS[shot.index % MOCK_COLORS.length] ?? '0x333333';
  const { width, height } = scene;
  const box = `drawbox=x=${width * 0.3}:y=${height * 0.38}:w=${width * 0.4}:h=${height * 0.24}:color=white@0.5:t=8`;
  await ffmpeg([
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=${width}x${height}`,
    '-vf', `drawgrid=w=${width / 8}:h=${width / 8}:t=2:c=white@0.2,${box}`,
    '-frames:v', '1',
    file,
  ]);
}

/** Cache key: changes when the prompt, any reference image, the model, size or aspect changes. */
export async function imageKey(scene: Scene, shot: Shot, mock: boolean): Promise<string> {
  const refs = refsForShot(scene, shot);
  const refHashes = await Promise.all(refs.map(async (ref) => [ref.label, await fileSha(ref.path)]));
  return sha({
    v: 1,
    prompt: buildPrompt(scene, shot),
    refs: refHashes,
    model: mock ? 'mock' : env.imageModel,
    size: env.imageSize,
    aspect: scene.aspect,
    ...(shot.plate === undefined
      ? {}
      : { plate: [await fileSha(shot.plate.file), shot.plate.focus, shot.plate.zoom, ...(shot.plate.relight ? ['relight'] : [])] }),
  });
}

/** Cuts the shot's window out of its plate: the shot's aspect, centred on `focus`, `zoom` times closer. */
async function plateImage(scene: Scene, shot: Shot): Promise<Image | undefined> {
  if (shot.plate === undefined) return undefined;
  const { file, focus, zoom } = shot.plate;
  const ratio = scene.width / scene.height;
  const out = join(CACHE, 'plates', `${sha([await fileSha(file), focus, zoom, ratio])}.jpg`);
  if (!existsSync(out)) {
    await ensureDir(join(CACHE, 'plates'));
    const w = `if(gt(iw/ih,${ratio}),ih*${ratio},iw)/${zoom}`;
    const h = `if(gt(iw/ih,${ratio}),ih,iw/${ratio})/${zoom}`;
    const x = `max(0,min(iw-ow,${focus[0]}*iw-ow/2))`;
    const y = `max(0,min(ih-oh,${focus[1]}*ih-oh/2))`;
    await ffmpeg(['-i', file, '-vf', `crop=w='${w}':h='${h}':x='${x}':y='${y}'`, '-q:v', '2', out]);
  }
  return { data: await readFile(out), mime: 'image/jpeg' };
}

type CacheEntry = { file: string; attempt: number; issues: string[] };

/** A shot's cache entry with its file resolved, or undefined when there's no entry or its file is gone. */
async function readEntry(key: string): Promise<CacheEntry | undefined> {
  const entryFile = join(CACHE, `${key}.json`);
  if (!existsSync(entryFile)) return undefined;
  const stored = JSON.parse(await readFile(entryFile, 'utf8')) as CacheEntry;
  const file = cachedPath(CACHE, stored.file);
  return existsSync(file) ? { ...stored, file } : undefined;
}

/** Saves an entry with its file stored by name, so the cache works from any folder or machine. */
async function writeEntry(key: string, entry: CacheEntry): Promise<void> {
  await writeFile(join(CACHE, `${key}.json`), JSON.stringify({ ...entry, file: basename(entry.file) }));
}

/** Returns the image for a shot: cached, from image_file, or generated (and checked) now. */
export async function shotImage(scene: Scene, shot: Shot, options: ImageOptions): Promise<ShotImage> {
  if (shot.imageFile !== undefined) {
    return { file: shot.imageFile, attempt: 0, issues: [], generated: 0, cached: true };
  }
  if (shot.keptFile !== undefined && !options.regen) {
    return { file: shot.keptFile, attempt: 0, issues: [], generated: 0, cached: true, kept: true };
  }

  const refs = refsForShot(scene, shot);
  const prompt = buildPrompt(scene, shot);
  const key = await imageKey(scene, shot, options.mock);
  await ensureDir(CACHE);

  if (!options.regen) {
    const entry = await readEntry(key);
    if (entry !== undefined) return { ...entry, generated: 0, cached: true };
  }

  if (options.mock) {
    const file = join(CACHE, `${key}.png`);
    await mockImage(scene, shot, file);
    const entry: CacheEntry = { file, attempt: 1, issues: [] };
    await writeEntry(key, entry);
    return { ...entry, generated: 0, cached: false };
  }

  const plate = await plateImage(scene, shot);
  type Attempt = Image & { attempt: number; issues: string[] };
  let last: Attempt | undefined;
  let best: Attempt | undefined;
  let generated = 0;

  for (let attempt = 1; attempt <= env.imageMaxAttempts; attempt++) {
    // First attempt draws the shot; later ones edit the last image to fix what the check found.
    const mode: Mode | undefined =
      last !== undefined && last.issues.length > 0
        ? { kind: 'edit', image: last, fixes: last.issues }
        : plate === undefined
          ? undefined
          : { kind: 'plate', image: plate, relight: shot.plate?.relight ?? false };
    let image: Image;
    try {
      image = await generate(prompt, refs, scene.aspect, mode);
      generated++;
    } catch (error) {
      if (error instanceof NoImageError && attempt < env.imageMaxAttempts) {
        log(`  shot ${shot.id}: ${error.message} Retrying.`);
        continue;
      }
      throw error;
    }
    const verdict = options.check ? await check(image, refs, prompt, shot.avoid) : { ok: true, issues: [] };
    last = { ...image, attempt, issues: verdict.ok ? [] : verdict.issues };
    // Keep the attempt with the fewest problems; edits can drift, so the last isn't always the best.
    if (best === undefined || last.issues.length <= best.issues.length) best = last;
    if (verdict.ok) break;
    log(`  shot ${shot.id}: attempt ${attempt} has problems (${verdict.issues.join('; ')})${attempt < env.imageMaxAttempts ? ', fixing' : ''}`);
  }

  if (best === undefined) throw new Error(`Shot ${shot.id}: Gemini returned no image after ${env.imageMaxAttempts} attempts.`);

  const entry = await saveEntry(key, best, best.attempt, best.issues);
  return { ...entry, generated, cached: false };
}

async function saveEntry(key: string, image: Image, attempt: number, issues: string[]): Promise<CacheEntry> {
  const file = join(CACHE, `${key}-${Date.now()}${EXT_BY_MIME[image.mime] ?? '.png'}`);
  await writeFile(file, image.data);
  const entry: CacheEntry = { file, attempt, issues };
  await writeEntry(key, entry);
  return entry;
}

/**
 * Edits a shot's current image with your own instruction ("remove the extra hand"), keeping everything else.
 * The result replaces that shot's image for later renders, until its prompt or references change.
 */
export async function fixShot(scene: Scene, shot: Shot, instruction: string): Promise<string> {
  if (shot.imageFile !== undefined) throw new Error(`Shot ${shot.id} uses image_file; edit that picture directly.`);
  if (shot.keptFile !== undefined) {
    // A kept image is edited in place and stays kept.
    const image: Image = { data: await readFile(shot.keptFile), mime: MIME_BY_EXT[extname(shot.keptFile).toLowerCase()] ?? 'image/png' };
    const fixed = await generate(buildPrompt(scene, shot), refsForShot(scene, shot), scene.aspect, { kind: 'edit', image, fixes: [instruction] });
    const file = shot.keptFile.replace(/\.[a-z]+$/i, EXT_BY_MIME[fixed.mime] ?? '.png');
    await writeFile(file, fixed.data);
    if (file !== shot.keptFile) await unlink(shot.keptFile);
    return file;
  }
  const key = await imageKey(scene, shot, false);
  const current = await readEntry(key);
  if (current === undefined) {
    throw new Error(`Shot ${shot.id} has no image yet. Run: pnpm render <scene> --images-only`);
  }
  const image: Image = {
    data: await readFile(current.file),
    mime: MIME_BY_EXT[extname(current.file).toLowerCase()] ?? 'image/png',
  };
  const fixed = await generate(buildPrompt(scene, shot), refsForShot(scene, shot), scene.aspect, { kind: 'edit', image, fixes: [instruction] });
  const entry = await saveEntry(key, fixed, current.attempt + 1, []);
  return entry.file;
}

/**
 * The image the next render would use for this shot, without generating anything:
 * its kept image, else its cached image (including any `pnpm fix` edits). Undefined when it has none yet.
 */
export async function currentImage(scene: Scene, shot: Shot): Promise<string | undefined> {
  if (shot.imageFile !== undefined) return undefined;
  if (shot.keptFile !== undefined) return shot.keptFile;
  const entry = await readEntry(await imageKey(scene, shot, false));
  return entry?.file;
}

export type KeepResult = 'kept' | 'already kept' | 'no image';

/** Locks a shot's current image so prompt and cast changes never redraw it. */
export async function keepShot(scene: Scene, shot: Shot): Promise<KeepResult> {
  if (shot.keptFile !== undefined) return 'already kept';
  const file = await currentImage(scene, shot);
  if (file === undefined) return 'no image';
  await ensureDir(scene.keptDir);
  await copyFile(file, join(scene.keptDir, `${shot.id}${extname(file)}`));
  return 'kept';
}

/** True when this shot would need a new image (used for the cost guard). */
export async function needsImage(scene: Scene, shot: Shot, options: ImageOptions): Promise<boolean> {
  if (shot.imageFile !== undefined || options.mock) return false;
  if (options.regen) return true;
  if (shot.keptFile !== undefined) return false;
  // Same test as shotImage, so the cost guard counts exactly the images a render would pay for.
  return (await readEntry(await imageKey(scene, shot, false))) === undefined;
}
