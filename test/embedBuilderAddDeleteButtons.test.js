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

test('new Builder response or link buttons remain dirty and target the current message until Save/Post', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');

  const responseStart = source.indexOf('async function showAddResponseModal');
  const linkStart = source.indexOf('async function showAddLinkModal', responseStart);
  assert.ok(responseStart >= 0 && linkStart > responseStart);
  const body = source.slice(responseStart, linkStart);

  assert.match(body, /state\.componentRows = next/);
  assert.match(body, /state\.componentRowsSourceMessageId = state\.modifyTarget\?\.messageId/);
  assert.match(body, /state\.componentsDirty = true/);
  assert.match(body, /button_response/);
  assert.match(body, /button_url/);
  assert.match(body, /ButtonStyle\.Link/);
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
