import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { STORIES } from './library.ts';

/** stories/<show>/show.yaml: what Claude reads about a show. Every field is optional. */
const manifestSchema = z.strictObject({
  name: z.string().min(1).optional(),
  /** Files Claude reads before writing: paths relative to the show folder, or starting with ~/ for files elsewhere. */
  context: z.array(z.string().min(1)).optional(),
  /** How many of the latest episodes Claude reads for format and continuity. */
  recent_episodes: z.number().int().min(0).max(10).default(3),
  /** The writing skill invoked when drafting narration. */
  skill: z.string().min(1).optional(),
});

export type ShowContext = {
  id: string;
  dir: string;
  name: string;
  /** Files Claude may read, with whether each exists right now. */
  files: { path: string; exists: boolean }[];
  /** The newest episode files, oldest first. */
  recentEpisodes: string[];
  /** The file name the next episode gets, such as ep12.yaml. */
  nextEpisodeFile: string;
  skill?: string;
};

const DEFAULT_CONTEXT = ['README.md', 'ARC.md', 'VOTES.md', 'INSIGHTS.md', 'cast.yaml'];
export const SHOW_ID = /^[a-z0-9][a-z0-9-]*$/;

const expand = (dir: string, path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(dir, path));

export function nextEpisodeFile(files: string[]): string {
  const numbers = files.map((file) => /^ep(\d+)\.ya?ml$/i.exec(file)?.[1]).filter((n) => n !== undefined).map(Number);
  const next = (numbers.length === 0 ? 0 : Math.max(...numbers)) + 1;
  return `ep${String(next).padStart(2, '0')}.yaml`;
}

export async function showContext(id: string): Promise<ShowContext> {
  if (!SHOW_ID.test(id)) throw new Error(`Not a show id: ${id}`);
  const dir = join(STORIES, id);
  const manifestFile = join(dir, 'show.yaml');
  const manifest = existsSync(manifestFile) ? manifestSchema.parse(parse(await readFile(manifestFile, 'utf8')) ?? {}) : manifestSchema.parse({});
  const entries = existsSync(dir) ? await readdir(dir) : [];
  const episodes = entries.filter((file) => /^ep\d+\.ya?ml$/i.test(file)).sort();
  const files = [...(manifest.context ?? DEFAULT_CONTEXT)].map((path) => {
    const full = expand(dir, path);
    return { path: full, exists: existsSync(full) };
  });
  return {
    id,
    dir,
    name: manifest.name ?? id.charAt(0).toUpperCase() + id.slice(1),
    files: manifest.context === undefined ? files.filter((file) => file.exists) : files,
    recentEpisodes: episodes.slice(-manifest.recent_episodes).map((file) => join(dir, file)),
    nextEpisodeFile: nextEpisodeFile(entries),
    skill: manifest.skill,
  };
}
