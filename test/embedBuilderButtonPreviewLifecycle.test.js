import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor closes after a successful all-in-one button mutation', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(source, /export async function cleanupBuilderButtonUi/);
  assert.match(source, /async function closeButtonEditorPanel/);

  const addStart = source.indexOf('async function showAddResponseModal');
  const editStart = source.indexOf('async function showEditButtonModal', addStart);
  const addBody = source.slice(addStart, editStart);
  assert.match(addBody, /refreshBuilder\(submitted, state\)/);
  assert.match(addBody, /closeButtonEditorPanel\(submitted, state\)/);
  assert.doesNotMatch(addBody, /showAddLinkModal/);
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
