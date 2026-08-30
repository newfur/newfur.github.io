import test from 'node:test';
import assert from 'node:assert/strict';

test('unit test harness is wired', () => {
  assert.equal(typeof process.version, 'string');
});
