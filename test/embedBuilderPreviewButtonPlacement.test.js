import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('custom Builder buttons render with the top preview, not under Message builder', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  assert.match(source, /BUILDER_PREVIEW_BUTTON_PLACEMENT_V1/);

  const controlsStart = source.indexOf('function buildControls(state)');
  const controlsEnd = source.indexOf('function getPreviewUpdateQueue', controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);
  const controls = source.slice(controlsStart, controlsEnd);
  assert.doesNotMatch(controls, /previewRows/);
  assert.doesNotMatch(controls, /buttonPreviewComponents/);

  const refreshStart = source.indexOf('async function refreshBuilder(interaction, state)');
  const refreshEnd = source.indexOf('async function editContent', refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  const refresh = source.slice(refreshStart, refreshEnd);
  assert.match(refresh, /embeds: \[buildPreviewEmbed\(state\)\]/);
  assert.match(refresh, /components: getBuilderMessageComponents\(state\)/);
  assert.match(refresh, /embeds: \[buildControlEmbed\(state\)\]/);
  assert.match(refresh, /components: buildControls\(state\)/);

  const execute = source.slice(source.indexOf('async execute(interaction)'));
  assert.match(
    execute,
    /safeReply\(interaction, \{[\s\S]*?embeds: \[buildPreviewEmbed\(state\)\][\s\S]*?components: getBuilderMessageComponents\(state\)/,
  );
  assert.match(
    execute,
    /interaction\.followUp\(\{[\s\S]*?embeds: \[buildControlEmbed\(state\)\][\s\S]*?components: buildControls\(state\)/,
  );
});
