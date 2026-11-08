import test from 'node:test';
import assert from 'node:assert/strict';
import { formatConsoleMessage } from '../src/utils/logger.js';

test('console log keeps the caller context above an error stack', () => {
  const error = new Error('Unknown Channel');
  const line = formatConsoleMessage({ message: 'Could not adjust panel 1 Unknown Channel', stack: error.stack });
  assert.match(line, /^Could not adjust panel 1 Unknown Channel\nError: Unknown Channel\n/);
});

test('console log of a bare error prints its stack once', () => {
  const error = new Error('boom');
  assert.equal(formatConsoleMessage({ message: error.message, stack: error.stack }), error.stack);
});

test('console log shows an error detail field that used to be hidden', () => {
  assert.equal(formatConsoleMessage({ message: 'Create ticket button failed', error: 'Unknown interaction' }),
    'Create ticket button failed (Unknown interaction)');
  assert.equal(formatConsoleMessage({ message: 'Unhandled error:', error: new TypeError('boom') }),
    'Unhandled error: (TypeError: boom)');
  assert.equal(formatConsoleMessage({ message: 'plain' }), 'plain');
});
