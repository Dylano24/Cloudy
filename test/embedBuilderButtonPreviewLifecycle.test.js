import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('button editor closes after successful response, link and disabled mutations', () => {
  const source = fs.readFileSync('src/services/embedBuilderButtonEditorService.js', 'utf8');
  assert.match(source, /export async function cleanupBuilderButtonUi/);
  assert.match(source, /async function closeButtonEditorPanel/);

  const responseStart = source.indexOf('async function showAddResponseModal');
  const linkStart = source.indexOf('async function showAddLinkModal', responseStart);
  const disabledStart = source.indexOf('async function showAddDisabledModal', linkStart);
  const editStart = source.indexOf('async function showEditButtonModal', disabledStart);
  assert.ok(responseStart >= 0 && linkStart > responseStart && disabledStart > linkStart && editStart > disabledStart);

  const responseBody = source.slice(responseStart, linkStart);
  const linkBody = source.slice(linkStart, disabledStart);
  const disabledBody = source.slice(disabledStart, editStart);

  for (const body of [responseBody, linkBody, disabledBody]) {
    assert.match(body, /refreshBuilder\(submitted, state\)/);
    assert.match(body, /closeButtonEditorPanel\(submitted, state\)/);
  }
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
