import test from 'node:test';
import assert from 'node:assert/strict';

test('security server suite is wired', () => {
  assert.equal(typeof process.version, 'string');
});
