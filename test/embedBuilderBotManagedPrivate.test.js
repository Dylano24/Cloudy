import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('every guild Embed Builder uses a bot-managed preview message', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /EMBED_BUILDER_BOT_MANAGED_ALL_GUILD_V2/);
  assert.match(source, /builderBotManaged = Boolean\(interaction\.guild && interaction\.channel\)/);
  assert.doesNotMatch(source, /!isPublicToEveryone\(interaction\.guild, interaction\.channel\)/);
  assert.match(source, /const previewResponsePromise = interaction\.reply\(\{/);
  assert.match(source, /const dashboardPromise = interaction\.channel\.send\(\{/);
  assert.match(source, /withResponse: true/);
  assert.match(source, /state\.builderMessage\s*=\s*previewMessage/);
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

test('bot-managed Builder durability is committed rather than rewritten at startup', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.startupPatches, undefined);
  assert.doesNotMatch(pkg.scripts.start, /patch/);
});
