import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder button additions sync to a real live component preview', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  assert.match(source, /export async function syncBuilderButtonPreview/);
  assert.match(source, /components: rows/);
  assert.match(source, /flags: MessageFlags\.Ephemeral/);

  const addResponseStart = source.indexOf('async function showAddResponseModal');
  const addLinkStart = source.indexOf('async function showAddLinkModal');
  const editStart = source.indexOf('async function showEditButtonModal');

  assert.ok(addResponseStart >= 0 && addLinkStart > addResponseStart && editStart > addLinkStart);
  assert.match(source.slice(addResponseStart, addLinkStart), /syncBuilderButtonPreview\(submitted, state\)/);
  assert.match(source.slice(addLinkStart, editStart), /syncBuilderButtonPreview\(submitted, state\)/);
});

test('opening Add buttons reuses the current private editor instead of creating another embed', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  const start = source.indexOf('export async function openEmbedButtonEditor');
  assert.ok(start >= 0);
  const body = source.slice(start);

  assert.match(body, /state\.activeButtonEditorMessageId/);
  assert.match(body, /buttonInteraction\.webhook\.editMessage/);
  assert.match(body, /return;/);
  assert.match(body, /deletePrivateBuilderMessage/);
});

test('Remove buttons and Reset clear the live button preview', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const removeStart = source.indexOf("case 'simple_embed_remove_buttons':");
  const modifyStart = source.indexOf("case 'simple_embed_modify':", removeStart);
  assert.ok(removeStart >= 0 && modifyStart > removeStart);
  assert.match(source.slice(removeStart, modifyStart), /syncBuilderButtonPreview\(buttonInteraction, state\)/);

  const resetStart = source.indexOf("case 'simple_embed_reset':");
  const resetNextCase = source.indexOf("\n                        case '", resetStart + 8);
  assert.ok(resetStart >= 0);
  const resetBody = source.slice(resetStart, resetNextCase >= 0 ? resetNextCase : source.length);
  assert.match(resetBody, /syncBuilderButtonPreview\(buttonInteraction, state\)/);
});
