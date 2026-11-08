import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Draft, TurnEvent } from './api-types.ts';
import { runTurn } from './claude.ts';
import { accept, addAttachments, createDraft, listDrafts, loadDraft, saveDraft } from './drafts.ts';
import { runFakeTurn } from './fake-claude.ts';
import { STORIES, getEpisode, listShows } from './library.ts';
import { mediaFile } from './media.ts';
import { Conflict, editShot, fixShotPicture, keepShotPicture, redrawShot, sceneFile, unkeepShotPicture, useShotVersion, type ShotEdit } from './shots.ts';
import { SHOW_ID, showContext } from './shows.ts';

export const PORT = Number(process.env.STUDIO_API_PORT ?? 4310);


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

// Drafts: writing the next part, or a new show, with Claude.
const FAKE = process.env.STUDIO_FAKE_CLAUDE === '1';
const files = (body: Record<string, unknown>): File[] => {
  const value = body['files'];
  return (Array.isArray(value) ? value : [value]).filter((f): f is File => f instanceof File && f.size > 0);
};
const field = (body: Record<string, unknown>, name: string): string => (typeof body[name] === 'string' ? (body[name] as string).trim() : '');
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

app.get('/api/drafts', async (c) =>
  c.json((await listDrafts()).map(({ id, kind, show, title, updatedAt, proposals }) => ({
    id, kind, show, title, updatedAt, pending: proposals.filter((p) => p.status === 'pending').length,
  }))),
);

app.post('/api/drafts', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const kind = field(body, 'kind') === 'new-show' ? 'new-show' : 'next-part';
  const attachments = files(body);
  const attachedNote = attachments.length > 0 ? `\nI attached ${attachments.length} file${attachments.length === 1 ? '' : 's'}; read ${attachments.length === 1 ? 'it' : 'them'} first.` : '';
  if (kind === 'next-part') {
    const show = field(body, 'show');
    if (!SHOW_ID.test(show) || !existsSync(join(STORIES, show, 'cast.yaml'))) return c.json({ error: 'No such show.' }, 400);
    const context = await showContext(show);
    const vote = field(body, 'vote');
    const notes = field(body, 'notes');
    const kickoff = [
      `Next part: ${context.nextEpisodeFile}.`,
      vote === '' ? 'No vote this time.' : `Vote result: ${vote}`,
      notes === '' ? '' : `My notes: ${notes}`,
      attachedNote,
      'Read the context and the recent episodes, then propose an outline for the next part as numbered beats. Don\'t write the script yet.',
    ].filter(Boolean).join('\n');
    const draft = await createDraft({ kind, show, title: `${context.name}: ${context.nextEpisodeFile.replace('.yaml', '')}`, kickoff, skill: context.skill, files: attachments });
    return c.json({ id: draft.id });
  }
  const title = field(body, 'title');
  const show = slug(title);
  if (show === '' || !SHOW_ID.test(show)) return c.json({ error: 'Give the show a name.' }, 400);
  if (existsSync(join(STORIES, show))) return c.json({ error: `There's already a show folder named ${show}.` }, 400);
  const pitch = field(body, 'pitch');
  const kickoff = [
    `New show: "${title}".`,
    pitch === '' ? '' : `Pitch: ${pitch}`,
    attachedNote,
    'Read the format examples, then suggest a one-paragraph premise and ask me up to three questions that would change the show most. Don\'t propose files yet.',
  ].filter(Boolean).join('\n');
  const draft = await createDraft({ kind, show, title, kickoff, files: attachments });
  return c.json({ id: draft.id });
});

const withDraft = async (id: string): Promise<Draft | undefined> => loadDraft(id);

app.get('/api/drafts/:id', async (c) => {
  const draft = await withDraft(c.req.param('id'));
  return draft === undefined ? c.json({ error: 'Not found' }, 404) : c.json(draft);
});

app.post('/api/drafts/:id/attachments', async (c) => {
  const draft = await withDraft(c.req.param('id'));
  if (draft === undefined) return c.json({ error: 'Not found' }, 404);
  await addAttachments(draft, files(await c.req.parseBody({ all: true })));
  await saveDraft(draft);
  return c.json(draft);
});

// One turn with Claude, streamed as server-sent events.
app.post('/api/drafts/:id/turn', async (c) => {
  const draft = await withDraft(c.req.param('id'));
  if (draft === undefined) return c.json({ error: 'Not found' }, 404);
  const { text } = (await c.req.json()) as { text?: string };
  if (typeof text !== 'string' || text.trim() === '') return c.json({ error: 'Say something.' }, 400);
  return streamSSE(c, async (stream) => {
    const emit = (event: TurnEvent): void => {
      void stream.writeSSE({ data: JSON.stringify(event) });
    };
    try {
      if (FAKE) await runFakeTurn(draft, text.trim(), emit);
      else await runTurn(draft, text.trim(), emit, c.req.raw.signal);
    } catch (error) {
      emit({ type: 'error', message: (error as Error).message });
    }
  });
});

app.post('/api/drafts/:id/proposals/:proposal/:action', async (c) => {
  const draft = await withDraft(c.req.param('id'));
  if (draft === undefined) return c.json({ error: 'Not found' }, 404);
  const action = c.req.param('action');
  try {
    if (action === 'accept') await accept(draft, c.req.param('proposal'));
    else if (action === 'dismiss') {
      const proposal = draft.proposals.find((p) => p.id === c.req.param('proposal') && p.status === 'pending');
      if (proposal === undefined) throw new Error('That proposal is no longer pending.');
      proposal.status = 'dismissed';
    } else return c.json({ error: 'Unknown action' }, 400);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 409);
  }
  draft.updatedAt = new Date().toISOString();
  await saveDraft(draft);
  return c.json(draft);
});

// Shots: edit text for free; redraw and fix are paid and the page confirms them first.
app.post('/api/shows/:show/episodes/:episode/shots/:number/:action', async (c) => {
  const file = sceneFile(c.req.param('show'), c.req.param('episode'));
  const number = Number(c.req.param('number'));
  if (file === undefined || !Number.isInteger(number)) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { rev?: string; lines?: ShotEdit['lines']; image?: string; instruction?: string; version?: string };
  try {
    const action = c.req.param('action');
    if (action === 'edit') await editShot(file, number, body.rev ?? '', { lines: body.lines, image: body.image });
    else if (action === 'redraw') await redrawShot(file, number);
    else if (action === 'fix') await fixShotPicture(file, number, body.instruction ?? '');
    else if (action === 'keep') await keepShotPicture(file, number);
    else if (action === 'unkeep') await unkeepShotPicture(file, number);
    else if (action === 'use-version') await useShotVersion(file, number, body.version ?? '');
    else return c.json({ error: 'Unknown action' }, 400);
  } catch (error) {
    return c.json({ error: (error as Error).message }, error instanceof Conflict ? 409 : 400);
  }
  return c.json(await getEpisode(c.req.param('show'), c.req.param('episode')));
});

// Images and video, with range requests so the video player can seek.
app.get('/api/media/*', async (c) => {
  const file = mediaFile(c.req.path.slice('/api/media/'.length));
  const type = file === undefined ? undefined : TYPES[extname(file).toLowerCase()];
  if (file === undefined || type === undefined || !existsSync(file)) {
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
