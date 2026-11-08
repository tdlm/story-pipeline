import { join, relative, resolve, sep } from 'node:path';
import { env } from '../../src/env.ts';

/** The only folders media is served from, by name. Never the project root, so .env is never reachable. */
const ROOTS: Record<string, () => string> = {
  stories: () => env.storiesDir,
  out: () => env.outDir,
  images: () => join(env.cacheDir, 'images'),
  versions: () => join(env.studioDir, 'versions'),
  drafts: () => join(env.studioDir, 'drafts'),
};

/** The URL a file is served at, or undefined if it isn't under a media folder. */
export function mediaUrl(file: string): string | undefined {
  for (const [name, root] of Object.entries(ROOTS)) {
    const rel = relative(root(), file);
    if (rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep)) {
      return `/api/media/${name}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
    }
  }
  return undefined;
}

/** The file a media URL path (after /api/media/) points at, or undefined if it's outside its folder. */
export function mediaFile(path: string): string | undefined {
  const [name, ...rest] = path.split('/');
  const root = name === undefined ? undefined : ROOTS[name];
  if (root === undefined) return undefined;
  const dir = root();
  const file = resolve(dir, rest.map(decodeURIComponent).join(sep));
  return file.startsWith(dir + sep) ? file : undefined;
}
