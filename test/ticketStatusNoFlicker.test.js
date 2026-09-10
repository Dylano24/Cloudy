import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/services/ticketUiService.js', 'utf8');

test('public ticket claim and unclaim status messages use final white color on first send', () => {
  for (const title of ['Ticket claimed', 'Ticket unclaimed']) {
    const start = source.indexOf(`title: '${title}'`);
    assert.notEqual(start, -1, `${title} status sender is missing`);
    const block = source.slice(start, start + 220);
    assert.match(block, /color:\s*'#FFFFFF'/, `${title} must be white before Discord receives it`);
    assert.doesNotMatch(block, /#2ecc71/i, `${title} must not render green before the white branding pass`);
  }
});
