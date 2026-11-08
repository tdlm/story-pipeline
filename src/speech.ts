import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cartesiaSpeech } from './cartesia.ts';
import { elevenLabsSpeech } from './elevenlabs.ts';
import { env } from './env.ts';
import { ffmpeg, probeDuration } from './ffmpeg.ts';
import type { VoiceSettings } from './schema.ts';
import { ensureDir, sha } from './util.ts';

const TTS_CACHE = join(env.cacheDir, 'tts');

export type Word = { text: string; start: number; end: number; highlight: boolean };
export type Speech = {
  file: string;
  duration: number;
  words: Word[];
  /** ElevenLabs credits spent on this line in this run. */
  spentCharacters: number;
  /** True when the audio was made in this run, not read from the cache. */
  fresh: boolean;
};
export type Span = { start: number; end: number };

/** What a provider returns: the audio, and each spoken word's timing when it has them. */
export type Synthesized = { audio: Buffer; ext: 'mp3' | 'wav'; spans: Span[] | null };

export type Provider = 'elevenlabs' | 'cartesia';

/**
 * Voices in cast.yaml: a bare id is an ElevenLabs voice; `cartesia:Tanner` (a name or an id) is a Cartesia voice.
 * `elevenlabs:<id>` also works, for clarity.
 */
export function parseVoice(voice: string): { provider: Provider; ref: string } {
  const match = /^(elevenlabs|cartesia):(.+)$/.exec(voice.trim());
  if (match === null) return { provider: 'elevenlabs', ref: voice.trim() };
  return { provider: match[1] as Provider, ref: (match[2] ?? '').trim() };
}

type Token = { text: string; highlight: boolean };

/** `*word*` marks words to color in captions. Returns the text to speak and the caption words. */
export function parseMarkup(text: string): { spoken: string; tokens: Token[] } {
  const tokens: Token[] = [];
  let open = false;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const stars = (raw.match(/\*/g) ?? []).length;
    const highlight = open || stars > 0;
    if (stars % 2 === 1) open = !open;
    const clean = raw.replaceAll('*', '');
    if (clean !== '') tokens.push({ text: clean, highlight });
  }
  return { spoken: tokens.map((token) => token.text).join(' '), tokens };
}

/** Fallback timing when a provider gives none: words spread by length across the clip. */
function evenWords(tokens: Token[], duration: number): Word[] {
  const lead = Math.min(0.1, duration * 0.05);
  const usable = Math.max(duration - lead * 2, 0.1);
  const totalChars = tokens.reduce((sum, token) => sum + token.text.length + 1, 0);
  let time = lead;
  return tokens.map((token) => {
    const length = (usable * (token.text.length + 1)) / totalChars;
    const word = { ...token, start: time, end: time + length };
    time += length;
    return word;
  });
}

function toWords(tokens: Token[], spans: Span[] | null, duration: number): Word[] {
  if (spans === null || spans.length !== tokens.length) return evenWords(tokens, duration);
  return tokens.map((token, i) => ({ ...token, start: spans[i]?.start ?? 0, end: spans[i]?.end ?? 0 }));
}

/** ElevenLabs gives timing per character; this groups it into words. */
export function spansFromCharacters(characters: string[], starts: number[], ends: number[]): Span[] {
  const spans: Span[] = [];
  let current: Span | undefined;
  characters.forEach((character, i) => {
    const start = starts[i] ?? 0;
    const end = ends[i] ?? start;
    if (/\s/.test(character)) {
      if (current !== undefined) spans.push(current);
      current = undefined;
      return;
    }
    if (current === undefined) current = { start, end };
    else current.end = end;
  });
  if (current !== undefined) spans.push(current);
  return spans;
}

export type SpeakOptions = {
  text: string;
  voice: string;
  settings?: VoiceSettings;
  draft: boolean;
  mock: boolean;
  /** The same speaker's lines before and after, so the delivery flows. Not part of the cache key. */
  previousText?: string;
  nextText?: string;
};

const modelFor = (provider: Provider, draft: boolean): string =>
  provider === 'cartesia' ? env.cartesiaModel : draft ? env.draftVoiceModel : env.voiceModel;

function speechKey(options: SpeakOptions): string {
  const { provider } = parseVoice(options.voice);
  return sha({
    v: 1,
    spoken: parseMarkup(options.text).spoken,
    voice: options.voice,
    model: options.mock ? 'mock' : modelFor(provider, options.draft),
    settings: options.settings ?? null,
  });
}

/** ElevenLabs characters this line would cost (0 when cached, mocked, or voiced by another provider). */
export function elevenLabsCost(options: SpeakOptions): number {
  if (options.mock || parseVoice(options.voice).provider !== 'elevenlabs') return 0;
  return existsSync(join(TTS_CACHE, `${speechKey(options)}.json`)) ? 0 : parseMarkup(options.text).spoken.length;
}

type Meta = {
  file?: string;
  spans?: Span[] | null;
  /** Older cache entries stored ElevenLabs' raw character alignment. */
  alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
};

export async function speak(options: SpeakOptions): Promise<Speech> {
  const { spoken, tokens } = parseMarkup(options.text);
  const key = speechKey(options);
  await ensureDir(TTS_CACHE);
  const metaFile = join(TTS_CACHE, `${key}.json`);
  let spentCharacters = 0;
  let fresh = false;

  let meta: Meta | undefined = existsSync(metaFile) ? (JSON.parse(await readFile(metaFile, 'utf8')) as Meta) : undefined;
  let audioFile = meta?.file ?? join(TTS_CACHE, `${key}.mp3`);

  if (meta === undefined || !existsSync(audioFile)) {
    if (options.mock) {
      audioFile = join(TTS_CACHE, `${key}.mp3`);
      const seconds = 0.4 + tokens.length * 0.36;
      await ffmpeg([
        '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds.toFixed(2)}`,
        '-af', 'volume=0.05', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '6',
        audioFile,
      ]);
      meta = { file: audioFile, spans: null };
    } else {
      const { provider, ref } = parseVoice(options.voice);
      const request = {
        spoken,
        voice: ref,
        settings: options.settings,
        model: modelFor(provider, options.draft),
        previousText: options.previousText === undefined ? undefined : parseMarkup(options.previousText).spoken,
        nextText: options.nextText === undefined ? undefined : parseMarkup(options.nextText).spoken,
      };
      const result = provider === 'cartesia' ? await cartesiaSpeech(request) : await elevenLabsSpeech(request);
      audioFile = join(TTS_CACHE, `${key}.${result.ext}`);
      await writeFile(audioFile, result.audio);
      meta = { file: audioFile, spans: result.spans };
      if (provider === 'elevenlabs') spentCharacters = spoken.length;
    }
    await writeFile(metaFile, JSON.stringify(meta));
    fresh = !options.mock;
  }

  const spans =
    meta.spans ??
    (meta.alignment === undefined || meta.alignment === null
      ? null
      : spansFromCharacters(meta.alignment.characters, meta.alignment.character_start_times_seconds, meta.alignment.character_end_times_seconds));
  const duration = await probeDuration(audioFile);
  return { file: audioFile, duration, words: toWords(tokens, spans, duration), spentCharacters, fresh };
}

/** What each provider's synthesis function receives. */
export type SynthRequest = {
  spoken: string;
  voice: string;
  settings?: VoiceSettings;
  model: string;
  previousText?: string;
  nextText?: string;
};
