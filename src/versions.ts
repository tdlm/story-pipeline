import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { env } from './env.ts';
import { EXT_BY_MIME } from './gemini.ts';
import type { Scene, Shot } from './load.ts';
import { ensureDir, linkOrCopy } from './util.ts';

/** Why a version was saved. */
export type VersionReason = 'attempt' | 'fix' | 'kept-before-fix' | 'kept-before-redraw' | 'kept-before-restore' | 'unkept';

export type Version = {
  /** Full path of the saved image. */
  file: string;
  reason: VersionReason;
  /** ISO time it was saved. */
  at: string;
  /** For `attempt`: which attempt of the render, and what the checker still saw in it. */
  attempt?: number;
  issues?: string[];
  /** For `fix`: what was asked for. */
  instruction?: string;
};

type Source = { data: Buffer; mime: string } | { path: string };

/** One folder per shot, named after the scene's path so shows with the same episode names never share one. */
export function versionsDir(scene: Scene, shot: Shot): string {
  return join(env.studioDir, 'versions', scene.id, shot.id);
}

/**
 * Saves an image as a new version of a shot. Every paid image and every replaced kept image goes here,
 * so nothing approved or paid for is ever lost. Returns the saved file.
 */
export async function saveVersion(
  scene: Scene,
  shot: Shot,
  source: Source,
  info: Omit<Version, 'file' | 'at'>,
): Promise<string> {
  const dir = versionsDir(scene, shot);
  await ensureDir(dir);
  const ext = 'path' in source ? extname(source.path).toLowerCase() : (EXT_BY_MIME[source.mime] ?? '.png');
  const stamp = Date.now();
  let file = join(dir, `${stamp}-${info.reason}${ext}`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stamp}-${info.reason}-${n}${ext}`);

  if ('path' in source) await linkOrCopy(source.path, file);
  else await writeFile(file, source.data, { flag: 'wx' });

  const record = { ...info, file: basename(file), at: new Date(stamp).toISOString() };
  await appendFile(join(dir, 'versions.jsonl'), `${JSON.stringify(record)}\n`);
  return file;
}

/** A shot's versions, oldest first. */
export async function listVersions(scene: Scene, shot: Shot): Promise<Version[]> {
  const dir = versionsDir(scene, shot);
  const log = join(dir, 'versions.jsonl');
  if (!existsSync(log)) return [];
  return (await readFile(log, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const record = JSON.parse(line) as Version;
      return { ...record, file: join(dir, basename(record.file)) };
    });
}
