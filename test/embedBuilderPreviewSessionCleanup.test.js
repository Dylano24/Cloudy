import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('temporary Builder preview is deleted when the Builder collector ends', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  assert.match(source, /BUILDER_PREVIEW_SESSION_CLEANUP_V1/);
  assert.match(source, /async function deleteBuilderPreviewMessage\(state\)/);

  const collectorStart = source.indexOf(
    'const collector = dashboardMessage.createMessageComponentCollector({',
  );
  assert.ok(collectorStart >= 0, 'main Builder collector missing');

  const endStart = source.indexOf("collector.on('end', async (", collectorStart);
  assert.ok(endStart >= 0, 'main Builder end handler missing');
  const endBody = source.slice(endStart, endStart + 1800);

  assert.match(endBody, /deleteBuilderPreviewMessage\(state\)/);
  assert.match(endBody, /deleteBuilderDashboardMessage\(state\)/);
});

test('preview cleanup deletes only temporary Builder UI state', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('async function deleteBuilderPreviewMessage(state)');
  const end = source.indexOf('// BUILDER_PREVIEW_BUTTON_PLACEMENT_V1', start);
  assert.ok(start >= 0 && end > start);

  const helper = source.slice(start, end);
  assert.match(helper, /state\.builderMessage = null/);
  assert.match(helper, /state\.builderMessageId = null/);
  assert.match(helper, /state\.builderPreviewUnavailable = true/);
  assert.match(helper, /message\?\.delete/);
  assert.match(helper, /webhook\?\.deleteMessage/);
  assert.doesNotMatch(helper, /modifyTarget/);
  assert.doesNotMatch(helper, /cachedMessage/);
});
