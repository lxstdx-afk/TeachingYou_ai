import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const root = () => new Request('https://example.test/');

test('checks only presence without revealing the token', async () => {
  const token = 'test-token-should-not-appear-in-body';
  const result = await worker.fetch(root(), { TELEGRAM_BOT_TOKEN: token });
  const text = await result.text();
  assert.equal(result.status, 200);
  assert.match(text, /Секрет Telegram найден/);
  assert.ok(!text.includes(token));
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('reports a missing secret', async () => {
  const result = await worker.fetch(root(), {});
  assert.match(await result.text(), /Секрет Telegram не найден/);
});

test('rejects non-root and non-GET requests', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'test' };
  assert.equal((await worker.fetch(new Request('https://example.test/webhook'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://example.test/', { method: 'POST' }), env)).status, 404);
});
