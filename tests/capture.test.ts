import assert from 'node:assert/strict';
import test from 'node:test';
import { fromShare, httpUrl, makeCapture } from '../src/features/capture/capture.ts';

test('manual capture preserves the original and independent captures have different ids', () => {
  const raw = '  Prendere treno\n';
  const first = makeCapture(raw, 'manual');
  assert.equal(first.raw_text, raw);
  assert.equal(first.source_url, null);
  assert.notEqual(first.id, makeCapture(raw, 'manual').id);
  assert.throws(() => makeCapture('   \n', 'manual'));
});

test('Android text and URL payloads use the same capture format', () => {
  const chrome = new FormData();
  chrome.set('title', 'Esempio');
  chrome.set('url', 'https://example.com/articolo');
  const first = fromShare(chrome);
  assert.equal(first.capture_source, 'share');
  assert.equal(first.raw_text, 'Esempio\nhttps://example.com/articolo');
  assert.equal(first.source_url, 'https://example.com/articolo');

  const video = new FormData();
  video.set('text', 'https://youtu.be/example');
  video.set('url', 'https://youtu.be/example');
  assert.equal(fromShare(video).raw_text, 'https://youtu.be/example');
  assert.equal(fromShare(video).source_url, 'https://youtu.be/example');
  assert.throws(() => fromShare(new FormData()));
  assert.equal(httpUrl('javascript:alert(1)'), null);
  assert.equal(httpUrl('https://demo:demo@example.com'), null);
});
