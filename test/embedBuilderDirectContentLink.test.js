import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControls } from '../src/commands/Tools/embedbuilder.js';

test('Edit title and message opens the website directly without an interaction reply', () => {
  const url = 'https://example.com/embed-color?session=test&mode=content';
  const buttons = buildControls({ contentEditorUrl: url }).flatMap(row => row.toJSON().components);
  const button = buttons.find(item => item.label === 'Edit title & message');
  assert.equal(button.style, 5);
  assert.equal(button.url, url);
  assert.equal(button.custom_id, undefined);
});
