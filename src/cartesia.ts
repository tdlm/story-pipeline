import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, env, requireKey } from './env.ts';
import type { Span, Synthesized, SynthRequest } from './speech.ts';
import { ensureDir, request } from './util.ts';

const API = 'https://api.cartesia.ai';
const SAMPLE_RATE = 44100;
const NAMES_FILE = join(ROOT, '.cache', 'cartesia-voices.json');

const headers = (): Record<string, string> => ({
  authorization: `Bearer ${requireKey('cartesiaKey')}`,
  'cartesia-version': env.cartesiaVersion,
  'content-type': 'application/json',
});

export type CartesiaVoice = {
  id: string;
  name: string;
  description: string;
  gender?: string | null;
  preview_file_url?: string | null;
};

export async function listCartesiaVoices(search?: string, withPreviews = false): Promise<CartesiaVoice[]> {
  const params = new URLSearchParams({ limit: '100' });
  if (search !== undefined && search !== '') params.set('q', search);
  if (withPreviews) params.append('expand[]', 'preview_file_url');
  const response = await request(`${API}/voices?${params.toString()}`, { headers: headers() }, 'Cartesia voices');
  const body = (await response.json()) as { data: CartesiaVoice[] };
  return body.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns `Tanner` into Tanner's voice id. Exact name first, then a name that starts with it
 * ("Tanner - Friendly Guide"). Remembered in .cache so it's looked up once.
 */
export async function resolveCartesiaVoice(ref: string): Promise<{ id: string; name: string }> {
  if (UUID.test(ref)) return { id: ref, name: ref };

  const known: Record<string, { id: string; name: string }> = existsSync(NAMES_FILE)
    ? (JSON.parse(await readFile(NAMES_FILE, 'utf8')) as Record<string, { id: string; name: string }>)
    : {};
  const remembered = known[ref.toLowerCase()];
  if (remembered !== undefined) return remembered;

  const wanted = ref.toLowerCase();
  const voices = await listCartesiaVoices(ref);
  const exact = voices.filter((voice) => voice.name.trim().toLowerCase() === wanted);
  const prefixed = voices.filter((voice) => new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(voice.name.trim().toLowerCase()));
  const match = exact[0] ?? (prefixed.length === 1 ? prefixed[0] : undefined);
  if (match === undefined) {
    const options = (prefixed.length > 0 ? prefixed : voices).slice(0, 8).map((voice) => `${voice.name} (${voice.id})`);
    throw new Error(
      `Couldn't pick a single Cartesia voice for "${ref}".${options.length > 0 ? ` Candidates: ${options.join(', ')}.` : ''} Use cartesia:<id> in cast.yaml.`,
    );
  }

  const resolved = { id: match.id, name: match.name };
  await ensureDir(join(ROOT, '.cache'));
  await writeFile(NAMES_FILE, JSON.stringify({ ...known, [wanted]: resolved }, null, 2));
  return resolved;
}

/** Wraps 16-bit mono PCM in a WAV header. */
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type SseEvent =
  | { type: 'chunk'; data?: string }
  | { type: 'timestamps'; word_timestamps?: { words: string[]; start: number[]; end: number[] } }
  | { type: 'done' }
  | { type: 'error'; title?: string; message?: string; error_code?: string };

/**
 * Cartesia text to speech. Uses the streaming endpoint because it's the one that returns word
 * timestamps (for captions); the stream is read whole, then saved as a WAV file.
 */
export async function cartesiaSpeech(request_: SynthRequest): Promise<Synthesized> {
  const voice = await resolveCartesiaVoice(request_.voice);
  const settings = request_.settings;
  const generationConfig = {
    ...(settings?.speed === undefined ? {} : { speed: Math.min(1.5, Math.max(0.6, settings.speed)) }),
    ...(settings?.volume === undefined ? {} : { volume: settings.volume }),
    ...(settings?.emotion === undefined ? {} : { emotion: settings.emotion }),
  };

  const response = await request(
    `${API}/tts/sse`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model_id: request_.model,
        transcript: request_.spoken,
        voice: { id: voice.id },
        language: 'en',
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
        add_timestamps: true,
        ...(Object.keys(generationConfig).length === 0 ? {} : { generation_config: generationConfig }),
      }),
    },
    `Cartesia speech for "${request_.spoken.slice(0, 40)}"`,
  );

  const chunks: Buffer[] = [];
  const words: string[] = [];
  const spans: Span[] = [];
  for (const frame of (await response.text()).split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (data === '') continue;
    const event = JSON.parse(data) as SseEvent;
    if (event.type === 'error') {
      throw new Error(`Cartesia: ${event.title ?? event.error_code ?? 'error'}: ${event.message ?? ''}`);
    }
    if (event.type === 'chunk' && event.data !== undefined) chunks.push(Buffer.from(event.data, 'base64'));
    if (event.type === 'timestamps' && event.word_timestamps !== undefined) {
      const { words: batch, start, end } = event.word_timestamps;
      batch.forEach((word, i) => {
        words.push(word);
        spans.push({ start: start[i] ?? 0, end: end[i] ?? start[i] ?? 0 });
      });
    }
  }
  if (chunks.length === 0) throw new Error(`Cartesia returned no audio for "${request_.spoken.slice(0, 40)}"`);

  return { audio: wav(Buffer.concat(chunks)), ext: 'wav', spans: spans.length > 0 ? spans : null };
}

/** Downloads a Cartesia voice's preview sample, if it has one. */
export async function cartesiaPreview(ref: string): Promise<{ name: string; file: string }> {
  const voice = await resolveCartesiaVoice(ref);
  const dir = join(ROOT, '.cache', 'previews');
  await ensureDir(dir);
  const cached = ['.mp3', '.wav'].map((ext) => join(dir, `cartesia-${voice.id}${ext}`)).find((path) => existsSync(path));
  if (cached !== undefined) return { name: voice.name, file: cached };

  const match = (await listCartesiaVoices(voice.id, true)).find((candidate) => candidate.id === voice.id);
  const url = match?.preview_file_url;
  if (url === undefined || url === null) {
    throw new Error(`${voice.name} has no preview sample. Try: pnpm voices --play cartesia:${ref} --say "a test line"`);
  }
  // Preview links may be signed (no auth) or need the key; try without first.
  let audio = await fetch(url);
  if (!audio.ok) audio = await request(url, { headers: headers() }, `Preview for ${voice.name}`);
  const ext = (audio.headers.get('content-type') ?? '').includes('wav') ? '.wav' : '.mp3';
  const file = join(dir, `cartesia-${voice.id}${ext}`);
  await writeFile(file, Buffer.from(await audio.arrayBuffer()));
  return { name: voice.name, file };
}
