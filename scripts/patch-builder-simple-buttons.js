import fs from 'node:fs';

const path = 'src/services/embedBuilderButtonEditorService.js';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

const editableStart = text.indexOf('  const editable = buttons.filter(');
if (editableStart >= 0) {
  const returnStart = text.indexOf('\n  return {', editableStart);
  if (returnStart < 0) throw new Error('[BUILDER_SIMPLE_BUTTONS] manager payload return missing');
  text = text.slice(0, editableStart) + text.slice(returnStart);
}

const editHandler = `        if (componentInteraction.customId === 'embed_button_edit_select') {
          await showEditButtonModal(
            componentInteraction,
            state,
            componentInteraction.values?.[0],
            refreshBuilder,
            panelMessage,
          );
          return;
        }
`;
text = text.replace(editHandler, '');

text = text.replace(
  `        .setDescription([
          ...lines,
          '',
          'Changing a button name/color never changes its existing action or custom ID.',
          'New colored response buttons send an ephemeral response. New link buttons open a URL.',
        ].join('\\n').slice(0, 4096))`,
  `        .setDescription([
          ...lines,
          '',
          'Add a response or link button. New buttons are added automatically from left to right and continue on the next row when needed.',
        ].join('\\n').slice(0, 4096))`,
);

fs.writeFileSync(path, text);
console.log('[BUILDER_SIMPLE_BUTTONS] Add-only button flow enabled; edit/select step removed.');
