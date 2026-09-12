import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('every guild Embed Builder uses a bot-managed Discord message', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /EMBED_BUILDER_BOT_MANAGED_ALL_GUILD_V2/);
  assert.match(source, /builderBotManaged = Boolean\(interaction\.guild && interaction\.channel\)/);
  assert.doesNotMatch(source, /!isPublicToEveryone\(interaction\.guild, interaction\.channel\)/);
  assert.match(source, /builderBotManaged \? \{\} : \{ flags: MessageFlags\.Ephemeral \}/);
  assert.match(source, /state\.builderMessage = dashboardMessage/);
  assert.match(source, /touchBuilderSessionMessage\(state\.builderMessage\)/);
  assert.match(source, /await state\.builderMessage\.edit\(payload\)/);
});

test('guild Builder no longer depends on the ephemeral webhook path', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /guild Builders are edited through the bot-managed Message object/i);
  assert.match(source, /Non-guild contexts keep the interaction-response fallback/);
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
