import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const read = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback;

const readNumber = (name: string, fallback: number): number => {
  const value = Number(read(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const env = {
  geminiKey: read('GEMINI_API_KEY'),
  elevenKey: read('ELEVENLABS_API_KEY'),
  cartesiaKey: read('CARTESIA_API_KEY'),
  imageModel: read('GEMINI_IMAGE_MODEL', 'gemini-3.1-flash-image-preview'),
  checkModel: read('GEMINI_CHECK_MODEL', 'gemini-3-flash-preview'),
  imageSize: read('GEMINI_IMAGE_SIZE', '2K'),
  imageMaxAttempts: readNumber('IMAGE_MAX_ATTEMPTS', 2),
  imageCostUsd: readNumber('IMAGE_COST_USD', 0.1),
  voiceModel: read('ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
  draftVoiceModel: read('ELEVENLABS_DRAFT_MODEL', 'eleven_flash_v2_5'),
  cartesiaModel: read('CARTESIA_MODEL', 'sonic-3.6'),
  cartesiaVersion: read('CARTESIA_VERSION', '2026-08-14'),
  captionFont: read('CAPTION_FONT', 'Impact'),
};

const KEY_NAMES = { geminiKey: 'GEMINI_API_KEY', elevenKey: 'ELEVENLABS_API_KEY', cartesiaKey: 'CARTESIA_API_KEY' } as const;

export function requireKey(key: keyof typeof KEY_NAMES): string {
  const value = env[key];
  if (value === '') {
    throw new Error(`${KEY_NAMES[key]} is not set. Copy .env.example to .env and paste your key.`);
  }
  return value;
}
