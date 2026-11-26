import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swipeStep } from '../src/components/section-swipe.ts';

test('swipe advances left and returns right at the inclusive distance and ratio', () => {
  const start = { x: 180, y: 100 };
  assert.equal(swipeStep(start, { x: 120, y: 140 }, 360), 1);
  assert.equal(swipeStep(start, { x: 240, y: 60 }, 360), -1);
  assert.equal(swipeStep(start, { x: 121, y: 100 }, 360), 0);
  assert.equal(swipeStep(start, { x: 240, y: 141 }, 360), 0);
  assert.equal(swipeStep(start, { x: 170, y: 190 }, 360), 0);
});

test('swipe starts strictly outside the two edge exclusion zones', () => {
  assert.equal(swipeStep({ x: 24, y: 50 }, { x: 100, y: 50 }, 360), 0);
  assert.equal(swipeStep({ x: 25, y: 50 }, { x: 100, y: 50 }, 360), -1);
  assert.equal(swipeStep({ x: 336, y: 50 }, { x: 250, y: 50 }, 360), 0);
  assert.equal(swipeStep({ x: 335, y: 50 }, { x: 250, y: 50 }, 360), 1);
});
