import { readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { env } from './env.ts';
import type { Scene } from './load.ts';
import { ensureDir } from './util.ts';

type Holder = { pid: number; host: string; started: string };

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Runs `fn` while holding the scene's lock, so two renders of one scene never share its work folder.
 * The lock is a file, so it holds across the CLI and the studio. A lock left by a process that died is taken over.
 */
export async function withSceneLock<T>(scene: Scene, fn: () => Promise<T>): Promise<T> {
  const dir = join(env.studioDir, 'locks');
  const file = join(dir, `${scene.id}.lock`);
  await ensureDir(dir);
  const me: Holder = { pid: process.pid, host: hostname(), started: new Date().toISOString() };

  for (let tries = 0; ; tries++) {
    try {
      await writeFile(file, JSON.stringify(me), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 0) throw error;
      const holder = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Partial<Holder>;
      const sameHost = holder.host === me.host;
      if (holder.pid !== undefined && (!sameHost || isAlive(holder.pid))) {
        const where = sameHost ? '' : ` on ${holder.host}. If nothing is rendering there, delete ${file}`;
        throw new Error(`${scene.title} is already rendering (process ${holder.pid}, started ${holder.started})${where}.`);
      }
      await unlink(file).catch(() => undefined);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(file).catch(() => undefined);
  }
}
