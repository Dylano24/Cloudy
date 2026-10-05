import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor closes after a successful mutation so preview sits directly under Builder', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(source, /export async function cleanupBuilderButtonUi/);
  assert.match(source, /async function closeButtonEditorPanel/);

  const addStart = source.indexOf('async function showAddResponseModal');
  const addLinkStart = source.indexOf('async function showAddLinkModal', addStart);
  const addBody = source.slice(addStart, addLinkStart);
  assert.match(addBody, /syncBuilderButtonPreview\(submitted, state\)/);
  assert.match(addBody, /closeButtonEditorPanel\(submitted, state\)/);

  const linkStart = addLinkStart;
  const editStart = source.indexOf('async function showEditButtonModal', linkStart);
  const linkBody = source.slice(linkStart, editStart);
  assert.match(linkBody, /syncBuilderButtonPreview\(submitted, state\)/);
  assert.match(linkBody, /closeButtonEditorPanel\(submitted, state\)/);
});

test('Close, Reset, Delete from builder and Builder end clean child button UI', () => {
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
