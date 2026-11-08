import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A throwaway story, cache and studio folder, and a fake Gemini, so nothing real is touched or paid for.
const dir = mkdtempSync(join(tmpdir(), 'story-ledger-'));
process.env.STORY_CACHE_DIR = join(dir, 'cache');
process.env.STORY_STUDIO_DIR = join(dir, 'studio');
process.env.GEMINI_API_KEY = 'test-key';
process.env.IMAGE_MAX_ATTEMPTS = '2';
process.env.IMAGE_COST_USD = '0.1';

type Reply = { status: number; body?: unknown } | 'drop';
const replies: Reply[] = [];
let calls = 0;
globalThis.fetch = (async () => {
  calls += 1;
  const reply = replies.shift() ?? { status: 200 };
  if (reply === 'drop') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
}) as typeof fetch;

const { paidRequest, readLedger } = await import('../src/ledger.ts');
const { request } = await import('../src/util.ts');
const { shotImage } = await import('../src/images.ts');
const { loadScene } = await import('../src/load.ts');

const spend = { provider: 'gemini', kind: 'image', units: 1, unit: 'images', usd: 0.1 } as const;
const fast = { baseDelayMs: 1 };
const image = (n: number) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from(`image ${n}`).toString('base64') } }] } }] });
const verdict = (ok: boolean, issues: string[] = []) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok, issues }) }] } }] });

test('a paid call is not retried after a dropped connection', async () => {
  calls = 0;
  replies.push('drop', { status: 200 });
  await assert.rejects(paidRequest('https://x', {}, 'Paid', spend, fast), /may still have been charged/);
  assert.equal(calls, 1);
  replies.length = 0;
});

test('a paid call retries when the provider says it did nothing, but not after other errors', async () => {
  calls = 0;
  replies.push({ status: 503 }, { status: 200 });
  await paidRequest('https://x', {}, 'Paid', spend, fast);
  assert.equal(calls, 2);

  calls = 0;
  replies.push({ status: 500 }, { status: 200 });
  await assert.rejects(paidRequest('https://x', {}, 'Paid', spend, fast), /HTTP 500/);
  assert.equal(calls, 1);
  replies.length = 0;
});

test('free calls still retry dropped connections', async () => {
  calls = 0;
  replies.push('drop', { status: 200 });
  await request('https://x', {}, 'Free', fast);
  assert.equal(calls, 2);
});

test('every paid attempt is recorded with its shot and reason', async () => {
  const before = (await readLedger()).length;
  writeFileSync(join(dir, 'cast.yaml'), 'style: plain\nnarrator:\n  voice: test-voice\n');
  writeFileSync(join(dir, 'ep.yaml'), 'title: Ledger test\ncast: cast.yaml\nshots:\n  - id: one\n    image: A door.\n');
  const scene = await loadScene(join(dir, 'ep.yaml'));
  // Attempt 1 fails the check, attempt 2 passes.
  replies.push({ status: 200, body: image(1) }, { status: 200, body: verdict(false, ['extra hand']) }, { status: 200, body: image(2) }, { status: 200, body: verdict(true) });
  await shotImage(scene, scene.shots[0]!, { mock: false, check: true, regen: false });

  const entries = (await readLedger()).slice(before);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.reason, e.shot, e.usd]),
    [
      ['image', 'first draw', 'one', 0.1],
      ['image-check', 'check', 'one', undefined],
      ['image', 'checker retry', 'one', 0.1],
      ['image-check', 'check', 'one', undefined],
    ],
  );
  assert.ok(entries.every((e) => e.scene === scene.id && e.ok));
});

test('failed attempts are recorded without dollars', async () => {
  const before = (await readLedger()).length;
  replies.push({ status: 503 }, { status: 200 });
  await paidRequest('https://x', {}, 'Paid', spend, fast);
  const entries = (await readLedger()).slice(before);
  assert.deepEqual(entries.map((e) => [e.attempt, e.ok, e.status, e.usd]), [[1, false, 503, undefined], [2, true, 200, 0.1]]);
});
