import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ROOT, env } from '../../src/env.ts';
import { getEpisode, listShows } from './library.ts';

export const PORT = Number(process.env.STUDIO_API_PORT ?? 4310);

/** The only folders the media route serves from. Never the project root, so .env is never reachable. */
const MEDIA_ROOTS = [join(ROOT, 'stories'), env.outDir, join(env.cacheDir, 'images'), join(env.studioDir, 'versions')];

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

const app = new Hono();

// Only this machine may talk to the server: another web page can't reach it through your browser.
app.use('*', async (c, next) => {
  const host = (c.req.header('host') ?? '').replace(/:\d+$/, '');
  const origin = c.req.header('origin');
  const local = (value: string): boolean => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(value);
  if (!local(host) || (origin !== undefined && !local(new URL(origin).hostname))) return c.text('Forbidden', 403);
  await next();
});

app.get('/api/shows', async (c) => c.json(await listShows()));

app.get('/api/shows/:show/episodes/:episode', async (c) => {
  const episode = await getEpisode(c.req.param('show'), c.req.param('episode'));
  return episode === undefined ? c.json({ error: 'Not found' }, 404) : c.json(episode);
});

// Images and video, with range requests so the video player can seek.
app.get('/api/media/*', async (c) => {
  const rel = decodeURIComponent(c.req.path.slice('/api/media/'.length));
  const file = resolve(ROOT, rel);
  const type = TYPES[extname(file).toLowerCase()];
  if (type === undefined || !MEDIA_ROOTS.some((root) => file.startsWith(root + sep)) || !existsSync(file)) {
    return c.text('Not found', 404);
  }
  const { size } = await stat(file);
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (range === null) {
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, 'content-length': String(size) } });
  }
  const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
  });
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`Studio server on http://127.0.0.1:${info.port}`);
});
