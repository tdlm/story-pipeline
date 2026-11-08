import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.ts';
import { ensureDir, request, type RequestOptions } from './util.ts';

export type SpendKind = 'image' | 'image-check' | 'speech' | 'sound-effect';

/** What one paid call buys. Dollars only where the app can estimate them; credits stay as units for now. */
export type Spend = {
  provider: 'gemini' | 'elevenlabs' | 'cartesia';
  kind: SpendKind;
  model?: string;
  units: number;
  unit: 'images' | 'calls' | 'characters' | 'seconds';
  /** Estimated dollars, when known. */
  usd?: number;
};

/** Which scene and shot a call was for, and why. Set around a piece of work with withSpend. */
export type SpendContext = { scene?: string; shot?: string; reason?: string };

export type LedgerEntry = Spend &
  SpendContext & {
    at: string;
    attempt: number;
    ok: boolean;
    status?: number;
    error?: string;
    ms: number;
  };

const context = new AsyncLocalStorage<SpendContext>();

/** Labels every paid call made inside `fn` with this scene, shot and reason. Inner calls add to outer ones. */
export const withSpend = <T>(spend: SpendContext, fn: () => Promise<T>): Promise<T> =>
  context.run({ ...context.getStore(), ...spend }, fn);

export const ledgerFile = (): string => join(env.studioDir, 'ledger.jsonl');

async function record(entry: LedgerEntry): Promise<void> {
  await ensureDir(env.studioDir);
  await appendFile(ledgerFile(), `${JSON.stringify(entry)}\n`);
}

/** Paid calls only retry when the provider says it did no work (429, 503), and never after a dropped connection. */
const PAID: RequestOptions = { maxAttempts: 3, retryNetworkErrors: false, retryStatus: (status) => status === 429 || status === 503 };

/** A request that costs money. Every attempt, including failures, is recorded in the ledger. */
export function paidRequest(url: string, init: RequestInit, label: string, spend: Spend, options: RequestOptions = {}): Promise<Response> {
  const labels = context.getStore() ?? {};
  return request(url, init, label, {
    ...PAID,
    ...options,
    onAttempt: (attempt) =>
      record({
        ...spend,
        // Providers don't charge for refused requests, so only successful ones carry dollars.
        usd: attempt.ok ? spend.usd : undefined,
        ...labels,
        at: new Date().toISOString(),
        ...attempt,
      }),
  });
}

export async function readLedger(): Promise<LedgerEntry[]> {
  const file = ledgerFile();
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEntry);
}
