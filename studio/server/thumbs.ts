import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../src/env.ts';
import { ffmpeg } from '../../src/ffmpeg.ts';
import { ensureDir, fileSha } from '../../src/util.ts';

/**
 * A smaller JPEG of a picture, for showing it to Claude: about 1024 pixels on the long side, which is
 * all it can see anyway, at a fraction of the upload. Cached until the picture changes.
 */
export async function smallCopy(file: string, longSide = 1024): Promise<Buffer> {
  const dir = join(env.studioDir, 'thumbs');
  const out = join(dir, `${await fileSha(file)}-${longSide}.jpg`);
  if (!existsSync(out)) {
    await ensureDir(dir);
    await ffmpeg(['-y', '-i', file, '-vf', `scale='if(gt(iw,ih),${longSide},-2)':'if(gt(iw,ih),-2,${longSide})'`, '-q:v', '4', out]);
  }
  return readFile(out);
}
