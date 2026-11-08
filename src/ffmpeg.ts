import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import './env.ts'; // loads .env first so FFMPEG_DIR is set

/**
 * Where ffmpeg/ffprobe live: FFMPEG_DIR if set, else Homebrew's keg-only ffmpeg-full (which has libass,
 * needed for captions), else whatever is on PATH.
 */
function binDir(): string | undefined {
  const fromEnv = process.env.FFMPEG_DIR?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin'].find((dir) =>
    existsSync(join(dir, 'ffmpeg')),
  );
}

const DIR = binDir();
const bin = (name: string): string => (DIR === undefined ? name : join(DIR, name));

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(missing ? `${command} not found. Install it (macOS: brew install ffmpeg-full).` : error.message));
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed (exit ${code}):\n${stderr.trim().split('\n').slice(-12).join('\n')}`));
    });
  });
}

export const ffmpeg = (args: string[], cwd?: string): Promise<string> =>
  run(bin('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], cwd);

export async function probeDuration(file: string): Promise<number> {
  const output = await run(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Couldn't read the duration of ${file}`);
  return seconds;
}

export async function ffmpegInfo(): Promise<{ version: string; filters: Set<string> }> {
  const version = (await run(bin('ffmpeg'), ['-version'])).split('\n')[0] ?? '';
  const filterList = await run(bin('ffmpeg'), ['-hide_banner', '-filters']);
  const filters = new Set(
    filterList
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((name): name is string => name !== undefined),
  );
  return { version: DIR === undefined ? version : `${version} (${DIR})`, filters };
}

export const REQUIRED_FILTERS = ['zoompan', 'xfade', 'subtitles', 'amix', 'loudnorm', 'xstack', 'adelay'] as const;
