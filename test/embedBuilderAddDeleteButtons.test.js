import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Builder uses Add buttons and keeps Delete from builder clickable for a selected embed', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  assert.match(source, /setCustomId\('simple_embed_buttons'\)[\s\S]*?setLabel\('Add buttons'\)/);
  assert.doesNotMatch(source, /setLabel\('Edit buttons'\)/);

  const deleteStart = source.indexOf("setCustomId('simple_embed_delete_from_builder')");
  assert.ok(deleteStart >= 0, 'Delete from builder button missing');
  const deleteBlock = source.slice(deleteStart, deleteStart + 500);
  assert.match(deleteBlock, /Delete from builder/);
  assert.match(deleteBlock, /setDisabled\(!state\.modifyTarget\)/);
  assert.doesNotMatch(deleteBlock, /setDisabled\(!canDeleteBuilderRecord/);
});

test('new Builder buttons remain dirty and target the current message until Save/Post', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const responseStart = source.indexOf('async function showAddResponseModal');
  const responseEnd = source.indexOf('async function showAddLinkModal', responseStart);
  const responseBody = source.slice(responseStart, responseEnd);
  assert.match(responseBody, /state\.componentRows = next/);
  assert.match(responseBody, /state\.componentRowsSourceMessageId = state\.modifyTarget\?\.messageId/);
  assert.match(responseBody, /state\.componentsDirty = true/);

  const linkStart = source.indexOf('async function showAddLinkModal');
  const linkEnd = source.indexOf('async function showEditButtonModal', linkStart);
  const linkBody = source.slice(linkStart, linkEnd);
  assert.match(linkBody, /state\.componentRows = next/);
  assert.match(linkBody, /state\.componentRowsSourceMessageId = state\.modifyTarget\?\.messageId/);
  assert.match(linkBody, /state\.componentsDirty = true/);
});

test('Post message and Save changes both write Builder buttons to Discord', () => {
  const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const postPayload = builder.indexOf('const payload = { embeds: [embeds[index]] };');
  assert.ok(postPayload >= 0, 'post payload missing');
  const postBody = builder.slice(postPayload, postPayload + 500);
  assert.match(postBody, /getBuilderMessageComponents\(state\)/);
  assert.match(postBody, /payload\.components = components/);

  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const saveStart = manager.indexOf('export async function saveModifiedEmbed');
  assert.ok(saveStart >= 0, 'saveModifiedEmbed missing');
  const saveBody = manager.slice(saveStart, saveStart + 9000);
  assert.match(saveBody, /if \(state\.componentsDirty\) payload\.components = getBuilderMessageComponents\(state\)/);
  assert.match(saveBody, /state\.componentRowsSourceMessageId = String\(edited\.id\)/);
  assert.match(saveBody, /state\.componentsDirty = false/);
});
