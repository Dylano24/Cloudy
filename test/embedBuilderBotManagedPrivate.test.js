import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('in a server the Builder preview and controls are the interaction\'s own public replies, never channel posts', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('async execute(interaction) {');
  const end = source.indexOf('const collector = dashboardMessage.createMessageComponentCollector(', start);
  const execute = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // Owner's choice: a normal message is never dropped by the Discord app.
  assert.match(execute, /const builderBotManaged = Boolean\(interaction\.guildId \|\| interaction\.guild\)/);
  assert.match(execute, /const replyVisibility = builderBotManaged \? \{\} : \{ flags: MessageFlags\.Ephemeral \}/);
  assert.match(execute, /InteractionHelper\.safeReply\(interaction, previewPayload\)/);
  assert.match(execute, /interaction\.followUp\(dashboardPayload\)/);
  assert.match(execute, /registerBuilderSessionInteraction\(interaction\.id\)/);
  assert.doesNotMatch(execute, /interaction\.channel\.send\(/,
    'opening a report must never post its preview with channel.send');
  assert.match(execute, /state\.builderMessage\s*=\s*previewMessage/);
  assert.match(execute, /state\.builderDashboardWebhook = builderBotManaged \? null : interaction\.webhook/);
});

test('both immediate and slow slash Search acknowledgements are public in a server (they become the Builder preview)', () => {
  const router = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  const patch = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(router, /commandName === 'embedbuilder'[\s\S]*?interaction\.deferReply\(interaction\.guildId \? \{\} : \{ flags: MessageFlags\.Ephemeral \}\)/);
  assert.match(patch, /const visibility = interaction\.guildId \|\| interaction\.guild \? \{\} : \{ flags: MessageFlags\.Ephemeral \};\s*acknowledgement = interaction\.deferReply\(visibility\)/);
});

test('a Builder preview stays attached to its original webhook message and cannot spawn a replacement', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /state\.builderWebhook\?\.editMessage/);
  assert.match(source, /state\.builderWebhook\.editMessage\(state\.builderMessageId, payload\)/);
  assert.match(source, /state\.builderDashboardWebhook\?\.editMessage/);
  const start = source.indexOf('export async function editBuilderPreviewMessage');
  const end = source.indexOf('async function deliverBuilderPreviewUpdate', start);
  assert.doesNotMatch(source.slice(start, end), /followUp\(/);
  assert.match(source, /deleteBuilderPreviewMessage\(state\)/);
  assert.match(source, /deleteBuilderDashboardMessage\(state\)/);
});

test('Builder preview fix is committed instead of rewritten by startup patches', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.startupPatches, undefined);
  assert.doesNotMatch(pkg.scripts.start, /patch/);
});
