import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../supabase/functions/classify-item/classifier.ts';

const item = { raw_text: 'Prendere treno', ai_allowed: true };
const key = 'synthetic-test-key';

test('AI consent and credential screening prevent any provider call', async () => {
  let calls = 0;
  const transport = async () => { calls++; return new Response(); };
  assert.equal((await classify({ ...item, ai_allowed: false }, key, transport)).status, 'skipped');
  assert.equal((await classify({ ...item, raw_text: 'token: VALORE_FITTIZIO' }, key, transport)).status, 'skipped');
  assert.equal((await classify({ ...item, raw_text: 'https://example.com/?access_token=fittizio' }, key, transport)).status, 'skipped');
  assert.equal((await classify(item, undefined, transport)).status, 'failed');
  assert.equal(calls, 0);
});

test('timeout, quota and invalid data all become recoverable failures', async () => {
  const timeout = async () => { throw new DOMException('Simulated timeout', 'TimeoutError'); };
  const quota = async () => new Response(null, { status: 429 });
  const invalid = async () => Response.json({ choices: [{ message: { content: '{' } }] });
  const unsupported = async () => reply({ kind: 'other', intentions: ['notify'], needs_clarification: false });
  for (const transport of [timeout, quota, invalid, unsupported]) {
    assert.deepEqual(await classify(item, key, transport), { status: 'failed', result: null, model: null });
  }
});

test('retry accepts a valid interpretation and sends only the original text', async () => {
  const result = { kind: 'task', intentions: ['act'], needs_clarification: false };
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages[1], { role: 'user', content: item.raw_text });
    assert.equal(body.response_format.json_schema.strict, true);
    assert.ok(init?.signal);
    return reply(result);
  };
  assert.deepEqual(await classify(item, key, transport), { status: 'ready', result, model: 'openai/gpt-oss-120b' });
});

function reply(result: object) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
}
