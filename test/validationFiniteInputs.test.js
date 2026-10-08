import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNumber, validateDiscordId } from '../src/utils/validation.js';

test('economy number validation rejects infinite amounts before account mutation', () => {
  assert.equal(validateNumber(Infinity, 'amount'), null);
  assert.equal(validateNumber(-Infinity, 'amount'), null);
  assert.equal(validateNumber(0, 'amount'), 0);
  assert.equal(validateNumber(12.5, 'amount'), 12.5);
});

test('older valid 17-digit Discord IDs are accepted consistently with startup validation', () => {
  assert.equal(validateDiscordId('12345678901234567'), '12345678901234567');
  assert.equal(validateDiscordId('1234567890123456'), null);
  assert.equal(validateDiscordId('123456789012345678901'), null);
});
