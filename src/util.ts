import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const sha = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);

const fileHashes = new Map<string, string>();

export async function fileSha(path: string): Promise<string> {
  const known = fileHashes.get(path);
  if (known !== undefined) return known;
  const hash = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 24);
  fileHashes.set(path, hash);
  return hash;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'scene';

/** Runs `fn` over `items` with at most `limit` running at once, keeping result order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** fetch with retries on network errors, 429 and 5xx. Throws with the response body otherwise. */
export async function request(url: string, init: RequestInit, label: string): Promise<Response> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw new Error(`${label}: network error: ${(error as Error).message}`);
      }
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response;

    const body = await response.text();
    // A quota of zero (e.g. Gemini's free tier for image models) won't recover by waiting.
    if (response.status === 429 && /limit: 0\b|free_tier/.test(body)) {
      throw new Error(
        `${label}: this key's plan has no quota for it (HTTP 429). For Gemini, turn on billing for the key's project ` +
          `at https://aistudio.google.com/apikey, wait a few minutes, and run again.\n${body.slice(0, 300)}`,
      );
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${label} failed (HTTP ${response.status}): ${body.slice(0, 600)}`);
  }
}

export const log = (message: string): void => console.log(message);

/**
 * A cached file's path. Entries store the file's name inside its cache folder; older entries stored a full
 * path, sometimes from another machine, so only the name is used.
 */
export function cachedPath(dir: string, stored: string): string {
  return join(dir, basename(stored));
}
