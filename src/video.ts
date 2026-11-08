import { copyFile } from 'node:fs/promises';
import { ffmpeg } from './ffmpeg.ts';
import type { Move, Transition, VoiceFx } from './schema.ts';
import { FPS } from './timeline.ts';


/** One shot: the still image with a slow camera move, rendered at 2x then scaled down for smoother motion. */
export async function renderClip(options: {
  image: string;
  out: string;
  seconds: number;
  move: Move;
  width: number;
  height: number;
  /** Darken the picture (for the end card, so its text reads). */
  dim?: boolean;
}): Promise<void> {
  const { width, height } = options;
  const frames = Math.max(2, Math.round(options.seconds * FPS));
  const p = `(on/${frames - 1})`;
  const centerX = 'iw/2-(iw/zoom/2)';
  const centerY = 'ih/2-(ih/zoom/2)';

  const motion: Record<Move, { z: string; x: string; y: string }> = {
    'push-in': { z: `1+0.12*${p}`, x: centerX, y: centerY },
    'pull-out': { z: `1.12-0.12*${p}`, x: centerX, y: centerY },
    'pan-left': { z: '1.15', x: `(iw-iw/zoom)*(1-${p})`, y: centerY },
    'pan-right': { z: '1.15', x: `(iw-iw/zoom)*${p}`, y: centerY },
    'pan-up': { z: '1.15', x: centerX, y: `(ih-ih/zoom)*(1-${p})` },
    'pan-down': { z: '1.15', x: centerX, y: `(ih-ih/zoom)*${p}` },
    still: { z: `1.02+0.02*${p}`, x: centerX, y: centerY },
  };
  const { z, x, y } = motion[options.move];
  const big = `${width * 2}:${height * 2}`;

  await ffmpeg([
    '-i', options.image,
    '-vf', [
      `scale=${big}:force_original_aspect_ratio=increase`,
      `crop=${big}`,
      `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${FPS}`,
      ...(options.dim === true ? ['colorchannelmixer=rr=0.45:gg=0.45:bb=0.45'] : []),
      'format=yuv420p',
    ].join(','),
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
    options.out,
  ]);
}

/** Joins the clips with crossfades. Each clip's `start` is its position on the timeline. */
export async function joinClips(
  clips: { file: string; start: number; transition: Transition; transitionIn: number }[],
  out: string,
): Promise<void> {
  const first = clips[0];
  if (first === undefined) throw new Error('No clips to join');
  if (clips.length === 1) {
    await copyFile(first.file, out);
    return;
  }

  const inputs = clips.flatMap((clip) => ['-i', clip.file]);
  const filters: string[] = [];
  let previous = '[0:v]';
  clips.slice(1).forEach((clip, i) => {
    const index = i + 1;
    const label = index === clips.length - 1 ? '[video]' : `[v${index}]`;
    const kind = clip.transition === 'fadeblack' ? 'fadeblack' : 'fade';
    filters.push(
      `${previous}[${index}:v]xfade=transition=${kind}:duration=${clip.transitionIn.toFixed(3)}:offset=${clip.start.toFixed(3)}${label}`,
    );
    previous = label;
  });

  await ffmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[video]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
    out,
  ]);
}

export type Sound = { file: string; start: number; volume: number; voice: boolean; fx?: VoiceFx };

// A voice through a radio speaker, intercom or tape: band-limited, a little squashed and gritty.
const FX_FILTERS: Record<VoiceFx, string> = {
  radio: 'highpass=f=320,lowpass=f=3200,acompressor=threshold=0.1:ratio=6:attack=5:release=60,acrusher=bits=12:mix=0.15,volume=1.4',
};

/**
 * Places every voice line and sound effect at its time, adds looping music that ducks under the voices,
 * and levels the mix for social video.
 */
export async function mixAudio(options: { sounds: Sound[]; music?: { file: string; volume: number }; total: number; out: string }): Promise<void> {
  const total = options.total.toFixed(3);
  const args: string[] = [];
  const filters: string[] = [];
  const voices: string[] = [];
  const effects: string[] = [];
  const labels: string[] = [];
  const toStereo = 'aformat=sample_rates=48000:channel_layouts=stereo';

  options.sounds.forEach((sound, index) => {
    const ms = Math.round(sound.start * 1000);
    const fx = sound.fx === undefined ? '' : `${FX_FILTERS[sound.fx]},`;
    args.push('-i', sound.file);
    filters.push(`[${index}:a]${fx}${toStereo},adelay=${ms}|${ms},volume=${sound.volume}[a${index}]`);
    (sound.voice ? voices : effects).push(`[a${index}]`);
  });

  // A copy of the voice bus ducks the music hard and the sound effects a little, so lines always read.
  const duckMusic = options.music !== undefined && voices.length > 0;
  const duckEffects = effects.length > 0 && voices.length > 0;
  if (voices.length > 0) {
    const keys = [duckMusic ? '[musickeyraw]' : '', duckEffects ? '[sfxkeyraw]' : ''].filter(Boolean);
    const bus = `${voices.join('')}amix=inputs=${voices.length}:normalize=0:duration=longest`;
    // Keys are padded with silence so the music and effects keep playing after the last line.
    filters.push(
      keys.length === 0
        ? `${bus}[voices]`
        : `${bus},asplit=${keys.length + 1}[voices]${keys.join('')};` + keys.map((key) => `${key}apad${key.replace('raw', '')}`).join(';'),
    );
    labels.push('[voices]');
  }

  if (effects.length > 0) {
    // Padded to full length first: the compressor stops when its main input does.
    const bus = `${effects.join('')}amix=inputs=${effects.length}:normalize=0:duration=longest,apad=whole_dur=${total}`;
    filters.push(
      duckEffects
        ? `${bus}[sfxraw];[sfxraw][sfxkey]sidechaincompress=threshold=0.012:ratio=5:attack=15:release=400[sfx]`
        : `${bus}[sfx]`,
    );
    labels.push('[sfx]');
  }

  if (options.music !== undefined) {
    const index = options.sounds.length;
    const fadeStart = Math.max(0, options.total - 1.5).toFixed(3);
    args.push('-stream_loop', '-1', '-i', options.music.file);
    const music = `[${index}:a]${toStereo},atrim=0:${total},volume=${options.music.volume},afade=t=out:st=${fadeStart}:d=1.5`;
    filters.push(
      duckMusic
        ? `${music}[musicraw];[musicraw][musickey]sidechaincompress=threshold=0.015:ratio=12:attack=30:release=600[music]`
        : `${music}[music]`,
    );
    labels.push('[music]');
  }

  if (labels.length === 0) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    labels.push('[0:a]');
  }

  filters.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,` +
      `apad=whole_dur=${total},atrim=0:${total},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[mix]`,
  );

  await ffmpeg([...args, '-filter_complex', filters.join(';'), '-map', '[mix]', '-c:a', 'pcm_s16le', options.out]);
}

/** Final file: video + mix, with captions burned in. Runs in `cwd` so the captions path needs no escaping. */
export async function mux(options: {
  cwd: string;
  video: string;
  audio: string;
  captions?: string;
  out: string;
  draft: boolean;
}): Promise<void> {
  const videoCodec =
    options.captions === undefined
      ? ['-c:v', 'copy']
      : ['-vf', `subtitles=${options.captions}`, '-c:v', 'libx264', '-preset', options.draft ? 'veryfast' : 'medium', '-crf', '19', '-pix_fmt', 'yuv420p'];
  await ffmpeg(
    [
      '-i', options.video,
      '-i', options.audio,
      '-map', '0:v', '-map', '1:a',
      ...videoCodec,
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      options.out,
    ],
    options.cwd,
  );
}

/** A grid of every shot's image, for a quick review before spending on audio. */
export async function contactSheet(images: string[], out: string, width: number, height: number): Promise<void> {
  const cellW = Math.round(width / 4);
  const cellH = Math.round(height / 4);
  const columns = Math.min(images.length, 6);
  const inputs = images.flatMap((image) => ['-i', image]);
  const scaled = images.map(
    (_, i) => `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,crop=${cellW}:${cellH}[c${i}]`,
  );
  const layout = images.map((_, i) => `${(i % columns) * cellW}_${Math.floor(i / columns) * cellH}`).join('|');
  const cells = images.map((_, i) => `[c${i}]`).join('');
  const stack =
    images.length === 1 ? `${cells}null[sheet]` : `${cells}xstack=inputs=${images.length}:layout=${layout}:fill=black[sheet]`;

  await ffmpeg([...inputs, '-filter_complex', [...scaled, stack].join(';'), '-map', '[sheet]', '-frames:v', '1', '-q:v', '3', out]);
}
