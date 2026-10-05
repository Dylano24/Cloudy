import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor closes after a successful response or link mutation from the unified modal', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(source, /export async function cleanupBuilderButtonUi/);
  assert.match(source, /async function closeButtonEditorPanel/);

  const responseStart = source.indexOf('async function showAddResponseModal');
  const linkStart = source.indexOf('async function showAddLinkModal', responseStart);
  assert.ok(responseStart >= 0 && linkStart > responseStart);

  const responseBody = source.slice(responseStart, linkStart);
  assert.match(responseBody, /button_response/);
  assert.match(responseBody, /button_url/);
  assert.match(responseBody, /ButtonStyle\.Link/);
  assert.match(responseBody, /refreshBuilder\(submitted, state\)/);
  assert.match(responseBody, /closeButtonEditorPanel\(submitted, state\)/);
});

test('Close, Reset, Delete from builder and Builder end clean child editor state', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

  const closeStart = source.indexOf("case 'simple_embed_close':");
  const closeEnd = source.indexOf("\n                        case '", closeStart + 8);
  assert.match(source.slice(closeStart, closeEnd), /cleanupBuilderButtonUi\(buttonInteraction, state\)/);

  const resetStart = source.indexOf("case 'simple_embed_reset':");
  const resetEnd = source.indexOf("\n                        case '", resetStart + 8);
  assert.match(source.slice(resetStart, resetEnd), /cleanupBuilderButtonUi\(buttonInteraction, state\)/);

  assert.match(
    source,
    /cleanupBuilderButtonUi\(buttonInteraction, state\)[\s\S]{0,200}resetBuilderAfterRecordDeletion\(state\)/,
  );

  const endStart = source.indexOf("collector.on('end'");
  assert.ok(endStart >= 0);
  assert.match(source.slice(endStart, endStart + 1200), /cleanupBuilderButtonUi\(interaction, state\)/);
});
