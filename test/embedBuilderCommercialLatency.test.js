import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Builder preloads only registry data and invalidates it after mutations', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const prepareStart = source.indexOf('export function prepareEmbedManager');
  const openStart = source.indexOf('export async function openEmbedManager', prepareStart);
  assert.ok(prepareStart >= 0 && openStart > prepareStart);
  const prepare = source.slice(prepareStart, openStart);
  assert.match(prepare, /getEmbedRegistry\(guild\.id\)/);
  assert.doesNotMatch(prepare, /getCanonicalBuilderRecords\(/);
  assert.match(prepare, /getEmbedRegistryGeneration\(guild\.id\)/);

  const openBody = source.slice(openStart);
  assert.match(openBody, /preparedGeneration === getEmbedRegistryGeneration\(guild\.id\)/);
  assert.match(openBody, /includeBotHistory: false/);
});

test('local Builder state changes refresh preview and dashboard without a defer round-trip', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /async function editBuilderDashboardMessage/);
  assert.match(source, /function queueBuilderRefresh/);
  assert.match(source, /const previewPromise = editBuilderPreviewMessage\(/);
  assert.match(source, /const dashboardPromise = next\.dashboardPayload && state\.builderDashboardMessageId/);
  assert.match(source, /await Promise\.all\(\[/);

  for (const id of ['simple_embed_logo', 'simple_embed_remove_logo', 'simple_embed_clear_media', 'simple_embed_reset']) {
    const start = source.indexOf(`case '${id}':`);
    assert.ok(start >= 0, `missing ${id}`);
    const end = source.indexOf('break;', start);
    const block = source.slice(start, end);
    assert.doesNotMatch(block, /deferUpdate\(\)/);
    assert.match(block, /refreshBuilder\(buttonInteraction, state\)/);
  }
});

test('Modify Search reuses the open manager records before reading the database again', () => {
  const source = fs.readFileSync('src/events/embedManagerTitleSearchReady.js', 'utf8');
  const start = source.indexOf('async function refreshRecords');
  assert.ok(start >= 0);
  const end = source.indexOf('\n}\n\nasync function handleSearchButton', start);
  const block = source.slice(start, end);
  assert.match(block, /__cloudyEmbedManagerRecordCache/);
  assert.match(block, /cached\.records/);
  assert.match(block, /getCanonicalBuilderRecords\(interaction\.guild\)/);
});

test('slash autocomplete coalesces canonical Builder reads', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  assert.match(source, /CANONICAL_SEARCH_CACHE_TTL = 1500/);
  assert.match(source, /async function getFastCanonicalBuilderRecords/);
  assert.match(source, /cached\?\.promise/);
  assert.doesNotMatch(source, /await getCanonicalBuilderRecords\(interaction\.guild\)/);
});

test('Modify opens directly while manager pagination acknowledges and repaints in parallel', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const openStart = source.indexOf('export async function openEmbedManager');
  assert.ok(openStart >= 0);
  const openBody = source.slice(openStart);
  const collectorStart = openBody.indexOf("collector.on('collect'");
  const startup = collectorStart >= 0 ? openBody.slice(0, collectorStart) : openBody;

  const directReplyCheck = startup.indexOf("typeof buttonInteraction.reply === 'function'");
  const directReply = startup.indexOf('buttonInteraction.reply({', directReplyCheck);
  const fallbackDefer = startup.indexOf('buttonInteraction.deferUpdate()', directReply);
  const fallbackFollowUp = startup.indexOf('buttonInteraction.followUp({', directReply);
  assert.ok(directReplyCheck >= 0 && directReply > directReplyCheck);
  assert.match(startup, /withResponse:\s*true/);
  assert.match(startup, /response\?\.resource\?\.message/);
  assert.ok(fallbackDefer > directReply, 'defer must only exist after the direct reply fast path');
  assert.ok(fallbackFollowUp > directReply, 'followUp must only exist after the direct reply fast path');

  const updateStart = source.indexOf('async function updateEmbedManager');
  const updateEnd = source.indexOf('\n}\n\nfunction managerRecordKey', updateStart);
  const updateBody = source.slice(updateStart, updateEnd);
  assert.match(updateBody, /interaction\.update\(payload\)/);
  assert.match(updateBody, /interaction\.editReply\(payload\)/);

  const navigationStart = source.indexOf('async function updateEmbedManagerNavigation');
  const navigationEnd = source.indexOf('\n}\n\nfunction managerRecordKey', navigationStart);
  const navigationBody = source.slice(navigationStart, navigationEnd);
  assert.match(navigationBody, /interaction\.deferUpdate\(\)/);
  assert.match(navigationBody, /buttonInteraction\.webhook\.editMessage\(managerMessage\.id, payload\)/);
  assert.match(navigationBody, /Promise\.all\(\[acknowledgement, rendering\]\)/);

  const collectorBody = openBody.slice(collectorStart);
  const selectionVersion = collectorBody.indexOf('const selectionVersion');
  assert.ok(selectionVersion >= 0);
  const beforeSelection = collectorBody.slice(0, selectionVersion);
  assert.doesNotMatch(beforeSelection, /interaction\.deferUpdate\(\)/);

  for (const id of ['simple_embed_modify_channel_page:', 'simple_embed_modify_embed_page:']) {
    const start = collectorBody.indexOf(id);
    assert.ok(start >= 0, `missing ${id}`);
    const end = collectorBody.indexOf('return;', start);
    const block = collectorBody.slice(start, end);
    assert.match(block, /updateEmbedManagerNavigation\(/);
  }
});

test('Post channel pagination acknowledges and repaints in parallel', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf("if (channelInteraction.customId.startsWith('simple_embed_channel_page:'))");
  assert.ok(start >= 0);
  const end = source.indexOf('\n            return;', start);
  const block = source.slice(start, end);
  assert.match(block, /Promise\.allSettled\(/);
  assert.match(block, /channelInteraction\.deferUpdate\(\)/);
  assert.match(block, /buttonInteraction\.webhook\.editMessage\(channelPickerMessage\.id, payload\)/);
});



test('browser title/message edits use the preview-only fast path', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /function refreshBuilderPreviewOnly/);

  const editorStart = source.indexOf('onEditorUpdate: async (field, value)');
  const editorEnd = source.indexOf('onColor: async color', editorStart);
  assert.ok(editorStart >= 0 && editorEnd > editorStart);
  const editor = source.slice(editorStart, editorEnd);
  assert.match(editor, /refreshBuilderPreviewOnly\(interaction, state\)/);
  assert.doesNotMatch(editor, /refreshBuilder\(interaction, state\)/);

  const session = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.match(session, /EDIT_FLUSH_DELAY_MS = 0/);
});

test('editor heartbeat no longer performs a Discord message edit', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('onEditorHold: async () =>');
  const end = source.indexOf('onEditorUpdate: async (field, value)', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /touchBuilderSessionMessage\(state\.builderDashboardMessage\)/);
  assert.doesNotMatch(block, /refreshBuilder\(/);
});
