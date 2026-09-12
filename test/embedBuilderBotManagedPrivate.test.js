import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('private-channel Embed Builder uses a bot-managed Discord message', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /EMBED_BUILDER_BOT_MANAGED_PRIVATE_V1/);
  assert.match(source, /builderBotManaged = Boolean/);
  assert.match(source, /!isPublicToEveryone\(interaction\.guild, interaction\.channel\)/);
  assert.match(source, /builderBotManaged \? \{\} : \{ flags: MessageFlags\.Ephemeral \}/);
  assert.match(source, /state\.builderMessage = dashboardMessage/);
  assert.match(source, /touchBuilderSessionMessage\(state\.builderMessage\)/);
  assert.match(source, /await state\.builderMessage\.edit\(payload\)/);
});

test('public-channel Embed Builder keeps the existing ephemeral single-preview path', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /MessageFlags\.Ephemeral/);
  assert.match(source, /state\.builderWebhook\?\.editMessage/);
  assert.match(source, /state\.builderWebhook\.editMessage\(state\.builderMessageId, payload\)/);
});

test('bot-managed durability patch runs after the final editor hold patch', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const scriptName of ['start', 'test']) {
    const command = packageJson.scripts[scriptName];
    const editorHold = command.indexOf('patch-embed-editor-visible-presence.js');
    const botManaged = command.indexOf('patch-embed-builder-bot-managed-private.js');
    assert.ok(editorHold >= 0 && botManaged > editorHold, `${scriptName} must apply bot-managed delivery after editor lifecycle patches`);
  }
});
