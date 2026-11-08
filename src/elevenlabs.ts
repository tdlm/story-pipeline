import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, requireKey } from './env.ts';
import { paidRequest } from './ledger.ts';
import { ffmpeg } from './ffmpeg.ts';
import { spansFromCharacters, type Synthesized, type SynthRequest } from './speech.ts';
import { ensureDir, request, sha } from './util.ts';

const API = 'https://api.elevenlabs.io';
const SFX_CACHE = join(env.cacheDir, 'sfx');

const headers = (): Record<string, string> => ({
  'xi-api-key': requireKey('elevenKey'),
  'content-type': 'application/json',
});

/** ElevenLabs text to speech with character timing. Only ElevenLabs' own voice settings are sent. */
export async function elevenLabsSpeech(request_: SynthRequest): Promise<Synthesized> {
  const settings = request_.settings;
  const voiceSettings =
    settings === undefined
      ? undefined
      : {
          stability: settings.stability,
          similarity_boost: settings.similarity_boost,
          style: settings.style,
          use_speaker_boost: settings.use_speaker_boost,
          speed: settings.speed === undefined ? undefined : Math.min(1.2, Math.max(0.7, settings.speed)),
        };
  const response = await paidRequest(
    `${API}/v1/text-to-speech/${encodeURIComponent(request_.voice)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        text: request_.spoken,
        model_id: request_.model,
        ...(voiceSettings === undefined ? {} : { voice_settings: voiceSettings }),
        ...(request_.previousText === undefined ? {} : { previous_text: request_.previousText }),
        ...(request_.nextText === undefined ? {} : { next_text: request_.nextText }),
      }),
    },
    `ElevenLabs speech for "${request_.spoken.slice(0, 40)}"`,
    { provider: 'elevenlabs', kind: 'speech', model: request_.model, units: request_.spoken.length, unit: 'characters' },
  );
  const body = (await response.json()) as {
    audio_base64: string;
    alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
  };
  const alignment = body.alignment ?? null;
  return {
    audio: Buffer.from(body.audio_base64, 'base64'),
    ext: 'mp3',
    spans:
      alignment === null
        ? null
        : spansFromCharacters(alignment.characters, alignment.character_start_times_seconds, alignment.character_end_times_seconds),
  };
}

/** A generated sound effect, rounded up to whole seconds so small timing edits reuse the cache. */
export async function soundEffect(text: string, seconds: number, mock: boolean): Promise<{ file: string; generated: boolean }> {
  const duration = Math.min(22, Math.max(1, Math.ceil(seconds)));
  const key = sha({ v: 1, text, duration, mock });
  await ensureDir(SFX_CACHE);
  const file = join(SFX_CACHE, `${key}.mp3`);
  if (existsSync(file)) return { file, generated: false };

  if (mock) {
    await ffmpeg([
      '-f', 'lavfi', '-i', `anoisesrc=color=brown:amplitude=0.05:seed=7:duration=${duration}`,
      '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '6', file,
    ]);
    return { file, generated: false };
  }

  const response = await paidRequest(
    `${API}/v1/sound-generation?output_format=mp3_44100_128`,
    { method: 'POST', headers: headers(), body: JSON.stringify({ text, duration_seconds: duration }) },
    `ElevenLabs sound effect "${text.slice(0, 40)}"`,
    { provider: 'elevenlabs', kind: 'sound-effect', units: duration, unit: 'seconds' },
  );
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return { file, generated: true };
}

export async function remainingCredits(): Promise<{ remaining: number; limit: number; tier: string }> {
  const response = await request(`${API}/v1/user/subscription`, { headers: headers() }, 'ElevenLabs subscription');
  const body = (await response.json()) as { character_count: number; character_limit: number; tier: string };
  return { remaining: body.character_limit - body.character_count, limit: body.character_limit, tier: body.tier };
}

export type VoiceInfo = {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string | null;
};

export async function listVoices(search?: string): Promise<VoiceInfo[]> {
  const params = new URLSearchParams({ page_size: '100' });
  if (search !== undefined && search !== '') params.set('search', search);
  const response = await request(`${API}/v2/voices?${params.toString()}`, { headers: headers() }, 'ElevenLabs voices');
  const body = (await response.json()) as { voices: VoiceInfo[] };
  return body.voices;
}

// Voices the free plan can use through the API. Voice Library voices ("professional") need a paid plan.
const FREE_PLAN_CATEGORIES = new Set(['premade', 'cloned', 'generated']);

/** One message per voice this key can't speak with: missing, or a library voice on the free plan. */
export async function voiceProblems(voiceIds: string[]): Promise<string[]> {
  const problems: string[] = [];
  let tier: string | undefined;
  for (const id of new Set(voiceIds)) {
    const response = await fetch(`${API}/v1/voices/${encodeURIComponent(id)}`, { headers: headers() });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`ElevenLabs refused the voice lookup (HTTP ${response.status}). Check the key and its Voices: Read permission.`);
    }
    if (!response.ok) {
      problems.push(`${id} isn't available to your ElevenLabs key`);
      continue;
    }
    const voice = (await response.json()) as VoiceInfo;
    if (voice.category !== undefined && !FREE_PLAN_CATEGORIES.has(voice.category)) {
      tier ??= (await remainingCredits()).tier;
      if (tier === 'free') {
        problems.push(
          `${voice.name} (${id}) is a Voice Library voice, which the ElevenLabs free plan can't use through the API. Upgrade to Starter, or pick a premade voice`,
        );
      }
    }
  }
  return problems;
}

/** Downloads a voice's free preview sample (no credits used). */
export async function voicePreview(voiceId: string): Promise<{ name: string; file: string }> {
  const response = await request(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, { headers: headers() }, `ElevenLabs voice ${voiceId}`);
  const voice = (await response.json()) as VoiceInfo;
  const dir = join(env.cacheDir, 'previews');
  await ensureDir(dir);
  const file = join(dir, `${voiceId}.mp3`);
  if (!existsSync(file)) {
    if (voice.preview_url === undefined || voice.preview_url === null) {
      throw new Error(`${voice.name} has no preview sample. Try: pnpm voices --play ${voiceId} --say "a test line"`);
    }
    const audio = await request(voice.preview_url, {}, `Preview for ${voice.name}`);
    await writeFile(file, Buffer.from(await audio.arrayBuffer()));
  }
  return { name: voice.name, file };
}
