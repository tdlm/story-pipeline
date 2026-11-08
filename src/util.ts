import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const sha = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);

const fileHashes = new Map<string, { stamp: string; hash: string }>();

export async function fileSha(path: string): Promise<string> {
  // Remembered until the file changes, so a long-running server notices a replaced reference image.
  const { mtimeMs, size } = await stat(path);
  const stamp = `${mtimeMs}:${size}`;
  const known = fileHashes.get(path);
  if (known?.stamp === stamp) return known.hash;
  const hash = createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 24);
  fileHashes.set(path, { stamp, hash });
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
export type Attempt = { attempt: number; ok: boolean; status?: number; error?: string; ms: number };

export type RequestOptions = {
  maxAttempts?: number;
  /** Retry when the connection drops. Off for paid calls: the provider may have done (and charged for) the work. */
  retryNetworkErrors?: boolean;
  /** Which HTTP errors are worth retrying. */
  retryStatus?: (status: number) => boolean;
  /** First retry waits twice this, then doubling. */
  baseDelayMs?: number;
  /** Told about every attempt, including retries and failures. */
  onAttempt?: (attempt: Attempt) => Promise<void> | void;
};

export async function request(url: string, init: RequestInit, label: string, options: RequestOptions = {}): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 4;
  const retryNetworkErrors = options.retryNetworkErrors ?? true;
  const retryStatus = options.retryStatus ?? ((status: number) => status === 429 || status >= 500);
  const baseDelayMs = options.baseDelayMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const message = (error as Error).message;
      await options.onAttempt?.({ attempt, ok: false, error: message, ms: Date.now() - started });
      if (!retryNetworkErrors) {
        throw new Error(`${label}: the connection dropped (${message}). It may still have been charged, so it wasn't retried.`);
      }
      if (attempt >= maxAttempts) throw new Error(`${label}: network error: ${message}`);
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    await options.onAttempt?.({ attempt, ok: response.ok, status: response.status, ms: Date.now() - started });
    if (response.ok) return response;

    const body = await response.text();
    // A quota of zero (e.g. Gemini's free tier for image models) won't recover by waiting.
    if (response.status === 429 && /limit: 0\b|free_tier/.test(body)) {
      throw new Error(
        `${label}: this key's plan has no quota for it (HTTP 429). For Gemini, turn on billing for the key's project ` +
          `at https://aistudio.google.com/apikey, wait a few minutes, and run again.\n${body.slice(0, 300)}`,
      );
    }
    if (retryStatus(response.status) && attempt < maxAttempts) {
      await sleep(baseDelayMs * 2 ** attempt);
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

/** Hard-links a file to save space, or copies it where links aren't possible. Never write to either in place afterwards. */
export async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}
