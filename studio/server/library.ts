import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { ROOT, env } from '../../src/env.ts';
import { currentImage } from '../../src/images.ts';
import { loadScene, type Scene, type Shot } from '../../src/load.ts';
import type { EpisodeDetail, EpisodeStage, EpisodeSummary, ShotDetail, ShotState, ShowSummary } from './api-types.ts';

export const STORIES = join(ROOT, 'stories');

/** URL the server serves a project file at. Only files under MEDIA_ROOTS are served. */
export const mediaUrl = (file: string): string => `/api/media/${relative(ROOT, file).split('/').map(encodeURIComponent).join('/')}`;

/** Show and episode ids come from URLs, so they must be plain names. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/i;

/** Until shows get a manifest (Phase 3), ep01-style files are episodes and other scenes are assets. */
const isEpisode = (id: string): boolean => /^ep\d+/i.test(id);

async function showName(dir: string, id: string): Promise<string> {
  const readme = join(dir, 'README.md');
  if (existsSync(readme)) {
    const heading = (await readFile(readme, 'utf8')).match(/^#\s+(.+)$/m)?.[1];
    if (heading !== undefined) return heading.replace(/\s*\(.*\)\s*$/, '').trim();
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

async function shotState(scene: Scene, shot: Shot): Promise<{ state: ShotState; image?: string }> {
  if (shot.imageFile !== undefined) return { state: 'own-picture', image: shot.imageFile };
  if (shot.keptFile !== undefined) return { state: 'kept', image: shot.keptFile };
  const image = await currentImage(scene, shot);
  return image === undefined ? { state: 'not-drawn' } : { state: 'to-review', image };
}

function videoFor(scene: Scene): EpisodeDetail['video'] {
  const dir = join(env.outDir, scene.slug);
  const final = join(dir, `${scene.slug}.mp4`);
  if (existsSync(final)) return { kind: 'final', url: mediaUrl(final) };
  const draft = join(dir, `${scene.slug}-draft.mp4`);
  if (existsSync(draft)) return { kind: 'draft', url: mediaUrl(draft) };
  return undefined;
}

function describe(kind: EpisodeSummary['kind'], stage: EpisodeStage, shots: number, done: number, toReview: number): string {
  if (stage === 'final') return 'Final video made.';
  if (stage === 'draft') return 'Draft video made. Next: check it and make the final.';
  if (toReview > 0) return `${toReview} ${toReview === 1 ? 'picture needs' : 'pictures need'} a look.`;
  if (stage === 'voices') return kind === 'episode' ? 'All pictures kept. Next: voices.' : 'All pictures kept.';
  if (stage === 'not-started') return 'No pictures yet.';
  return `${done} of ${shots} pictures kept.`;
}

async function episodeDetail(show: { id: string; name: string }, sceneFile: string): Promise<EpisodeDetail> {
  const id = basename(sceneFile, '.yaml');
  const scene = await loadScene(sceneFile);
  const shotList: ShotDetail[] = await Promise.all(
    scene.shots.map(async (shot) => {
      const { state, image } = await shotState(scene, shot);
      return {
        number: shot.index + 1,
        id: shot.id,
        state,
        image: image === undefined ? undefined : mediaUrl(image),
        prompt: shot.prompt,
        move: shot.move,
        transition: shot.transition,
        cast: shot.cast,
        location: shot.location,
        lines: shot.lines.map((line) => ({ speaker: line.speaker, text: line.text })),
      };
    }),
  );
  const done = shotList.filter((shot) => shot.state === 'kept' || shot.state === 'own-picture').length;
  const toReview = shotList.filter((shot) => shot.state === 'to-review').length;
  const drawn = shotList.some((shot) => shot.state === 'kept' || shot.state === 'to-review');
  const kind = isEpisode(id) ? 'episode' : 'asset';
  const video = videoFor(scene);
  const stage: EpisodeStage =
    video?.kind === 'final' ? 'final'
    : video?.kind === 'draft' ? 'draft'
    : done === shotList.length ? 'voices'
    : !drawn ? 'not-started'
    : 'pictures';
  return {
    id,
    title: scene.title,
    header: scene.header,
    kind,
    stage,
    status: describe(kind, stage, shotList.length, done, toReview),
    shots: shotList.length,
    toReview,
    done,
    // The first picture drawn for this episode; shot 1 is often a frame reused from the last one.
    cover: (shotList.find((shot) => shot.state === 'kept' || shot.state === 'to-review') ?? shotList[0])?.image,
    show,
    aspect: scene.aspect,
    width: scene.width,
    height: scene.height,
    shotList,
    video,
  };
}

function toSummary(detail: EpisodeDetail): EpisodeSummary {
  const { id, title, header, kind, stage, status, shots, toReview, done, cover } = detail;
  return { id, title, header, kind, stage, status, shots, toReview, done, cover };
}

export async function listShows(): Promise<ShowSummary[]> {
  const entries = await readdir(STORIES, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && existsSync(join(STORIES, entry.name, 'cast.yaml')));
  return Promise.all(
    dirs.map(async (entry) => {
      const dir = join(STORIES, entry.name);
      const show = { id: entry.name, name: await showName(dir, entry.name) };
      const files = (await readdir(dir)).filter((file) => file.endsWith('.yaml') && file !== 'cast.yaml').sort();
      const episodes = await Promise.all(
        files.map(async (file): Promise<EpisodeSummary> => {
          try {
            return toSummary(await episodeDetail(show, join(dir, file)));
          } catch (error) {
            const id = basename(file, '.yaml');
            return {
              id, title: id, kind: isEpisode(id) ? 'episode' : 'asset', stage: 'not-started',
              status: "This scene can't be loaded.", shots: 0, toReview: 0, done: 0, error: (error as Error).message,
            };
          }
        }),
      );
      return { ...show, episodes };
    }),
  );
}

export async function getEpisode(showId: string, episodeId: string): Promise<EpisodeDetail | undefined> {
  if (!SAFE_ID.test(showId) || !SAFE_ID.test(episodeId)) return undefined;
  const dir = join(STORIES, showId);
  const file = join(dir, `${episodeId}.yaml`);
  if (!existsSync(join(dir, 'cast.yaml')) || !existsSync(file)) return undefined;
  return episodeDetail({ id: showId, name: await showName(dir, showId) }, file);
}
