import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('in a server the Builder is the command\'s own normal reply (owner\'s choice), never a separate channel post', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('async execute(interaction) {');
  const end = source.indexOf('const collector = dashboardMessage.createMessageComponentCollector(', start);
  const execute = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(execute, /const builderBotManaged = Boolean\(interaction\.guildId\)/);
  assert.match(execute, /const builderReplyFlags = builderBotManaged \? \{\} : \{ flags: MessageFlags\.Ephemeral \}/);
  assert.match(execute, /InteractionHelper\.safeReply\(interaction, \{[\s\S]*\.\.\.builderReplyFlags/);
  assert.match(execute, /interaction\.followUp\(\{[\s\S]*\.\.\.builderReplyFlags/);
  assert.match(execute, /registerBuilderInteraction\(interaction\.id\)/);
  assert.doesNotMatch(execute, /interaction\.channel\.send\(/,
    'opening the Builder never posts the embed itself in the current channel');
  assert.match(execute, /state\.builderMessage\s*=\s*previewMessage/);
  assert.match(execute, /state\.builderDashboardWebhook = interaction\.webhook/);
});

test('slash Search acknowledgements are normal in a server and private elsewhere', () => {
  const router = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  const patch = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(router, /commandName === 'embedbuilder'[\s\S]*?interaction\.deferReply\(interaction\.guildId \? \{\} : \{ flags: MessageFlags\.Ephemeral \}\)/);
  assert.match(patch, /acknowledgement = interaction\.deferReply\(interaction\.guildId \? \{\} : \{ flags: MessageFlags\.Ephemeral \}\)/);
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
