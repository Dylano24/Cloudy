import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('opening any Embed Builder preview or controls never publishes channel messages', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('async execute(interaction) {');
  const end = source.indexOf('const collector = dashboardMessage.createMessageComponentCollector(', start);
  const execute = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(execute, /const builderBotManaged = false/);
  assert.match(execute, /InteractionHelper\.safeReply\(interaction, \{[\s\S]*flags: MessageFlags\.Ephemeral/);
  assert.match(execute, /interaction\.followUp\(\{[\s\S]*flags: MessageFlags\.Ephemeral/);
  assert.doesNotMatch(execute, /interaction\.channel\.send\(/,
    'opening a report must never post its preview in the current channel');
  assert.match(execute, /state\.builderMessage\s*=\s*previewMessage/);
  assert.match(execute, /state\.builderDashboardWebhook = builderBotManaged \? null : interaction\.webhook/);
});

test('both immediate and slow slash Search acknowledgements are ephemeral', () => {
  const router = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  const patch = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(router, /commandName === 'embedbuilder'[\s\S]*?interaction\.deferReply\(\{ flags: MessageFlags\.Ephemeral \}\)/);
  assert.match(patch, /acknowledgement = interaction\.deferReply\(\{ flags: MessageFlags\.Ephemeral \}\)/);
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
