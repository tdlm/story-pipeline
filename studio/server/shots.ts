import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { env } from '../../src/env.ts';
import { fixShot, keepShot, releaseKept, shotImage, unkeepShot, useVersion } from '../../src/images.ts';
import { loadScene, type Scene, type Shot } from '../../src/load.ts';
import { withSceneLock } from '../../src/lock.ts';
import { listVersions, versionsDir } from '../../src/versions.ts';
import { editYaml, type YamlEdit } from '../../src/yaml-edit.ts';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/i;
export const fileRev = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class Conflict extends Error {}

/** The scene file for a show's episode, or undefined if the ids aren't plain names or it doesn't exist. */
export function sceneFile(show: string, episode: string): string | undefined {
  if (!SAFE_ID.test(show) || !SAFE_ID.test(episode) || ['cast', 'show'].includes(episode)) return undefined;
  const file = join(env.storiesDir, show, `${episode}.yaml`);
  return existsSync(file) ? file : undefined;
}

/** How many shots the YAML itself has. A series end card added from cast.yaml comes after these. */
export async function yamlShotCount(file: string): Promise<number> {
  const data = parse(await readFile(file, 'utf8')) as { shots?: unknown[] };
  return data.shots?.length ?? 0;
}

async function shotAt(file: string, number: number): Promise<{ scene: Scene; shot: Shot }> {
  const scene = await loadScene(file);
  const shot = scene.shots[number - 1];
  if (shot === undefined) throw new Error(`No shot ${number}.`);
  return { scene, shot };
}

export type ShotEdit = { lines?: { speaker: string; text: string }[]; image?: string };

/**
 * Changes one shot's lines or picture prompt in the episode file, leaving the rest of the file as it was.
 * Refused if the file changed since `rev` was read. Text edits never redraw anything.
 */
export async function editShot(file: string, number: number, rev: string, edit: ShotEdit): Promise<void> {
  const source = await readFile(file, 'utf8');
  if (fileRev(source) !== rev) throw new Conflict('The episode changed since you opened it. Reload to see the latest.');
  if (number < 1 || number > (await yamlShotCount(file))) throw new Error(`Shot ${number} can't be edited here.`);
  const index = number - 1;
  const edits: YamlEdit[] = [];
  if (edit.lines !== undefined) {
    const lines = edit.lines.filter((line) => line.text.trim() !== '').map((line) => ({ [line.speaker.trim()]: line.text.trim() }));
    edits.push({ path: ['shots', index, 'lines'], value: lines });
  }
  if (edit.image !== undefined) {
    if (edit.image.trim() === '') throw new Error('The picture prompt can’t be empty.');
    // Folded prompts (image: >) end with a newline; keep whatever the file had.
    const old = (parse(source) as { shots: { image?: string }[] }).shots[index]?.image ?? '';
    edits.push({ path: ['shots', index, 'image'], value: `${edit.image.trim()}${old.endsWith('\n') ? '\n' : ''}` });
  }
  const edited = editYaml(source, edits);
  if (edited === source) return;
  // The engine must still load the episode, or nothing is saved.
  const temp = `${file}.edit.yaml`;
  await writeFile(temp, edited);
  try {
    await loadScene(temp);
  } catch (error) {
    await rename(temp, `${temp}.bad`).catch(() => undefined);
    throw new Error((error as Error).message.replace(temp, basename(file)));
  }
  await rename(temp, file);
}

/** Paid: draws a new picture for the shot from its current prompt. The checker is off: you are the checker. */
export async function redrawShot(file: string, number: number): Promise<void> {
  const { scene, shot } = await shotAt(file, number);
  await withSceneLock(scene, async () => {
    await shotImage(scene, shot, { mock: false, check: false, regen: true });
    if (shot.keptFile !== undefined) await unkeepShot(scene, shot);
  });
}

/** Paid: changes one thing in the shot's current picture. */
export async function fixShotPicture(file: string, number: number, instruction: string): Promise<void> {
  if (instruction.trim() === '') throw new Error('Say what to change.');
  const { scene, shot } = await shotAt(file, number);
  await withSceneLock(scene, () => fixShot(scene, shot, instruction.trim()));
}

export async function keepShotPicture(file: string, number: number): Promise<void> {
  const { scene, shot } = await shotAt(file, number);
  const result = await keepShot(scene, shot);
  if (result === 'no image') throw new Error('There’s no picture to keep yet.');
}

export async function unkeepShotPicture(file: string, number: number): Promise<void> {
  const { scene, shot } = await shotAt(file, number);
  await withSceneLock(scene, () => releaseKept(scene, shot));
}

/** Free: makes a saved version the shot's picture again. */
export async function useShotVersion(file: string, number: number, version: string): Promise<void> {
  const { scene, shot } = await shotAt(file, number);
  const match = (await listVersions(scene, shot)).find((v) => basename(v.file) === basename(version));
  if (match === undefined) throw new Error('That version isn’t one of this shot’s.');
  await withSceneLock(scene, () => useVersion(scene, shot, join(versionsDir(scene, shot), basename(match.file))));
}
