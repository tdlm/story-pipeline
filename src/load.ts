import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  ASPECTS,
  castSchema,
  sceneSchema,
  type Aspect,
  type Cast,
  type Move,
  type Transition,
  type VoiceFx,
  type VoiceSettings,
} from './schema.ts';
import { slugify } from './util.ts';

export type Ref = { label: string; path: string };

export type Line = { speaker: string; text: string; voice: string; settings?: VoiceSettings; fx?: VoiceFx };

export type Shot = {
  index: number;
  id: string;
  prompt?: string;
  imageFile?: string;
  /** An approved image locked with `pnpm keep`. */
  keptFile?: string;
  location?: string;
  cast: string[];
  props: string[];
  move: Move;
  transition: Transition;
  lines: Line[];
  /** Sound effects placed in the shot. Empty when there are none. */
  sfx: { sound: string; at: number; seconds?: number; volume: number }[];
  sfxVolume: number;
  hold?: number;
  references: boolean;
  plate?: { file: string; focus: [number, number]; zoom: number; relight: boolean };
  /** Things that must not be in the picture. */
  avoid: string[];
  /** Text shown over this shot when it's the scene's end card. */
  card?: string;
};

export type Scene = {
  title: string;
  slug: string;
  aspect: Aspect;
  width: number;
  height: number;
  captions: boolean;
  header?: string;
  music?: string;
  musicVolume: number;
  cast: Cast;
  shots: Shot[];
  /** The scene's YAML file. */
  file: string;
  /** Where `pnpm keep` stores this scene's approved images: <scene folder>/kept/<scene file name>/. */
  keptDir: string;
};

async function readYaml<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Couldn't read ${what} at ${path}: ${(error as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid ${what} (${path}):\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Loads a scene and its cast, resolves every file path, and reports all problems at once. */
export async function loadScene(scenePath: string): Promise<Scene> {
  const sceneDir = dirname(scenePath);
  const keptDir = join(sceneDir, 'kept', basename(scenePath, extname(scenePath)));
  const input = await readYaml(scenePath, sceneSchema, 'scene');
  const castPath = resolve(sceneDir, input.cast);
  const rawCast = await readYaml(castPath, castSchema, 'cast');
  const castDir = dirname(castPath);
  const problems: string[] = [];

  const absoluteRefs = (owner: string, refs: string[]): string[] =>
    refs.map((ref) => {
      const path = resolve(castDir, ref);
      if (!existsSync(path)) problems.push(`${owner}: reference image not found: ${ref}`);
      return path;
    });

  const cast: Cast = {
    ...rawCast,
    characters: Object.fromEntries(
      Object.entries(rawCast.characters).map(([id, value]) => [
        id,
        { ...value, refs: absoluteRefs(`character "${id}"`, value.refs) },
      ]),
    ),
    locations: Object.fromEntries(
      Object.entries(rawCast.locations).map(([id, value]) => [
        id,
        { ...value, refs: absoluteRefs(`location "${id}"`, value.refs) },
      ]),
    ),
    props: Object.fromEntries(
      Object.entries(rawCast.props).map(([id, value]) => [id, { ...value, refs: absoluteRefs(`prop "${id}"`, value.refs) }]),
    ),
  };

  const voiceFor = (speaker: string, where: string): Pick<Line, 'voice' | 'settings' | 'fx'> => {
    if (speaker === 'narrator') {
      if (cast.narrator === undefined) problems.push(`${where}: the narrator speaks, but cast.yaml has no narrator voice`);
      return { voice: cast.narrator?.voice ?? '', settings: cast.narrator?.settings, fx: cast.narrator?.fx };
    }
    const character = cast.characters[speaker];
    if (character === undefined) {
      problems.push(`${where}: unknown speaker "${speaker}"`);
      return { voice: '' };
    }
    if (character.voice === undefined) problems.push(`${where}: character "${speaker}" has no voice in cast.yaml`);
    return { voice: character.voice ?? '', settings: character.settings, fx: character.fx };
  };

  const seenIds = new Set<string>();
  const shots: Shot[] = input.shots.map((shot, index) => {
    const id = shot.id ?? String(index + 1).padStart(2, '0');
    const where = `shot ${index + 1} (${id})`;
    if (seenIds.has(id)) problems.push(`${where}: duplicate shot id`);
    seenIds.add(id);

    if (shot.location !== undefined && cast.locations[shot.location] === undefined) {
      problems.push(`${where}: unknown location "${shot.location}"`);
    }
    for (const name of shot.cast) {
      if (cast.characters[name] === undefined) problems.push(`${where}: unknown character "${name}"`);
    }
    for (const name of shot.props) {
      if (cast.props[name] === undefined) problems.push(`${where}: unknown prop "${name}"`);
    }

    let plate: string | undefined;
    if (shot.plate !== undefined) {
      plate = resolve(sceneDir, shot.plate);
      if (!existsSync(plate)) problems.push(`${where}: plate not found: ${shot.plate}`);
    }

    let imageFile: string | undefined;
    if (shot.image_file !== undefined) {
      imageFile = resolve(sceneDir, shot.image_file);
      if (!existsSync(imageFile)) problems.push(`${where}: image_file not found: ${shot.image_file}`);
    }

    const lines: Line[] = shot.lines.map((entry) => {
      const [speaker, text] = Object.entries(entry)[0] as [string, string];
      return { speaker, text, ...voiceFor(speaker, where) };
    });

    return {
      index,
      id,
      prompt: shot.image,
      imageFile,
      keptFile: ['.png', '.jpg', '.jpeg', '.webp'].map((ext) => join(keptDir, `${id}${ext}`)).find((path) => existsSync(path)),
      location: shot.location,
      cast: shot.cast,
      props: shot.props,
      move: shot.move,
      transition: shot.transition,
      lines,
      sfx:
        shot.sfx === undefined
          ? []
          : typeof shot.sfx === 'string'
            ? [{ sound: shot.sfx, at: 0, volume: shot.sfx_volume }]
            : shot.sfx.map((layer) => ({ ...layer, volume: layer.volume ?? shot.sfx_volume })),
      sfxVolume: shot.sfx_volume,
      hold: shot.hold,
      references: shot.references,
      plate: plate === undefined ? undefined : { file: plate, focus: shot.plate_focus, zoom: shot.plate_zoom, relight: shot.relight },
      avoid: shot.avoid,
    };
  });

  let music: string | undefined;
  if (input.music !== undefined) {
    music = resolve(sceneDir, input.music);
    if (!existsSync(music)) problems.push(`music file not found: ${input.music}`);
  }

  // The episode's own end card (paths relative to the episode), else the series' (relative to cast.yaml).
  const card =
    input.end_card === false
      ? undefined
      : input.end_card !== undefined
        ? { ...input.end_card, image: resolve(sceneDir, input.end_card.image) }
        : rawCast.end_card === undefined
          ? undefined
          : { ...rawCast.end_card, image: resolve(castDir, rawCast.end_card.image) };
  if (card !== undefined) {
    const image = card.image;
    if (existsSync(image)) {
      shots.push({
        index: shots.length,
        id: 'end-card',
        imageFile: image,
        cast: [],
        props: [],
        move: 'still',
        transition: 'fadeblack',
        lines: [],
        sfx: [],
        sfxVolume: 0,
        hold: card.seconds,
        references: false,
        avoid: [],
        card: card.text,
      });
    } else {
      // Not fatal, so episodes can be drafted before the end card picture exists.
      console.warn(`  (no end card yet: ${relative(process.cwd(), image)} doesn't exist)`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Problems in ${scenePath}:\n- ${problems.join('\n- ')}`);
  }

  return {
    title: input.title,
    slug: slugify(input.title),
    keptDir,
    file: resolve(scenePath),
    aspect: input.aspect,
    ...ASPECTS[input.aspect],
    captions: input.captions,
    header: input.header,
    music,
    musicVolume: input.music_volume,
    cast,
    shots,
  };
}

/** Reference images to send with a shot: its location, then characters, then props. Each file is sent once. */
export function refsForShot(scene: Scene, shot: Shot): Ref[] {
  const refs: Ref[] = [];
  if (!shot.references) return refs;
  const add = (label: string, paths: string[]): void => {
    for (const path of paths) {
      const existing = refs.find((ref) => ref.path === path);
      if (existing === undefined) refs.push({ label, path });
      else if (!existing.label.includes(label)) existing.label = `${existing.label}, ${label}`;
    }
  };
  if (shot.location !== undefined) add(`location "${shot.location}"`, scene.cast.locations[shot.location]?.refs ?? []);
  for (const name of shot.cast) add(`character "${name}"`, scene.cast.characters[name]?.refs ?? []);
  for (const name of shot.props) add(`prop "${name}"`, scene.cast.props[name]?.refs ?? []);
  return refs;
}
