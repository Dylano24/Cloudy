import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_BUTTON_LIFECYCLE] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_BUTTON_LIFECYCLE] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  const helperAnchor = `export async function syncBuilderButtonPreview(interaction, state) {`;
  if (!text.includes(helperAnchor)) {
    throw new Error('[BUILDER_BUTTON_LIFECYCLE] sync preview helper missing');
  }

  if (!text.includes('export async function cleanupBuilderButtonUi')) {
    const insertAt = text.indexOf(helperAnchor);
    const helper = `export async function cleanupBuilderButtonUi(interaction, state) {
  if (!state) return;

  const editorMessage = state.activeButtonEditorMessage || null;
  const editorId = state.activeButtonEditorMessageId
    ? String(state.activeButtonEditorMessageId)
    : editorMessage?.id
      ? String(editorMessage.id)
      : null;
  const previewMessage = state.activeButtonPreviewMessage || null;
  const previewId = state.activeButtonPreviewMessageId
    ? String(state.activeButtonPreviewMessageId)
    : previewMessage?.id
      ? String(previewMessage.id)
      : null;

  const editorCollector = state.activeButtonEditorCollector || null;
  state.activeButtonEditorCollector = null;
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorMessageId = null;
  state.activeButtonPreviewMessage = null;
  state.activeButtonPreviewMessageId = null;

  editorCollector?.stop?.('builder-cleanup');

  await Promise.all([
    editorId ? deletePrivateBuilderMessage(interaction, editorId, editorMessage) : null,
    previewId ? deletePrivateBuilderMessage(interaction, previewId, previewMessage) : null,
  ].filter(Boolean));
}

async function closeButtonEditorPanel(interaction, state) {
  const editorMessage = state.activeButtonEditorMessage || null;
  const editorId = state.activeButtonEditorMessageId
    ? String(state.activeButtonEditorMessageId)
    : editorMessage?.id
      ? String(editorMessage.id)
      : null;
  const editorCollector = state.activeButtonEditorCollector || null;

  state.activeButtonEditorCollector = null;
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorMessageId = null;
  editorCollector?.stop?.('preview-ready');

  if (editorId) {
    await deletePrivateBuilderMessage(interaction, editorId, editorMessage);
  }
}

`;
    text = text.slice(0, insertAt) + helper + text.slice(insertAt);
  }

  // After any successful button mutation: update the real button preview, then
  // close the temporary editor so the preview sits directly under the Builder.
  text = text.replaceAll(
    `  await syncBuilderButtonPreview(submitted, state).catch(() => {});`,
    `  await syncBuilderButtonPreview(submitted, state).catch(() => {});
  await closeButtonEditorPanel(submitted, state).catch(() => {});`,
  );

  // Button deletion uses the component interaction rather than a modal submit.
  text = text.replaceAll(
    `        await syncBuilderButtonPreview(componentInteraction, state).catch(() => {});`,
    `        await syncBuilderButtonPreview(componentInteraction, state).catch(() => {});
        await closeButtonEditorPanel(componentInteraction, state).catch(() => {});`,
  );

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  // Import the full lifecycle cleanup helper.
  if (!text.includes('cleanupBuilderButtonUi')) {
    const importNeedle = `    countBuilderButtons,
    getBuilderMessageComponents,
    openEmbedButtonEditor,
    syncBuilderButtonPreview,
} from '../../services/embedBuilderButtonEditorService.js';`;
    const importReplacement = `    cleanupBuilderButtonUi,
    countBuilderButtons,
    getBuilderMessageComponents,
    openEmbedButtonEditor,
    syncBuilderButtonPreview,
} from '../../services/embedBuilderButtonEditorService.js';`;
    if (!text.includes(importNeedle)) {
      throw new Error('[BUILDER_BUTTON_LIFECYCLE] Builder button import shape missing');
    }
    text = text.replace(importNeedle, importReplacement);
  }

  // Closing the Builder removes its private button editor + preview too.
  const closeStart = text.indexOf("case 'simple_embed_close':");
  if (closeStart >= 0) {
    const closeEnd = text.indexOf("\n                        case '", closeStart + 8);
    let block = text.slice(closeStart, closeEnd >= 0 ? closeEnd : text.length);
    if (!block.includes('cleanupBuilderButtonUi(buttonInteraction, state)')) {
      const defer = 'await buttonInteraction.deferUpdate().catch(() => {});';
      if (block.includes(defer)) {
        block = block.replace(
          defer,
          defer + "\n                            await cleanupBuilderButtonUi(buttonInteraction, state).catch(() => {});",
        );
      }
      text = text.slice(0, closeStart) + block + text.slice(closeEnd >= 0 ? closeEnd : text.length);
    }
  }

  // Reset is also a full preview reset: remove the private editor/preview.
  const resetStart = text.indexOf("case 'simple_embed_reset':");
  if (resetStart >= 0) {
    const resetEnd = text.indexOf("\n                        case '", resetStart + 8);
    let block = text.slice(resetStart, resetEnd >= 0 ? resetEnd : text.length);
    if (!block.includes('cleanupBuilderButtonUi(buttonInteraction, state)')) {
      const target = 'state.title = null;';
      if (block.includes(target)) {
        block = block.replace(
          target,
          "await cleanupBuilderButtonUi(buttonInteraction, state).catch(() => {});\n                            " + target,
        );
      }
      text = text.slice(0, resetStart) + block + text.slice(resetEnd >= 0 ? resetEnd : text.length);
    }
  }

  // Successful Delete from builder removes the extra button UI before state reset.
  const resetDeleted = '    resetBuilderAfterRecordDeletion(state);';
  if (text.includes(resetDeleted)
      && !text.includes('await cleanupBuilderButtonUi(buttonInteraction, state).catch(() => {});\n    resetBuilderAfterRecordDeletion(state);')) {
    text = text.replace(
      resetDeleted,
      '    await cleanupBuilderButtonUi(buttonInteraction, state).catch(() => {});\n' + resetDeleted,
    );
  }

  // Timeout / any other Builder end must not leave private child messages behind.
  const endAnchor = `            collector.on('end', async () => {
                if (state.activeEmbedManager) {`;
  const endReplacement = `            collector.on('end', async () => {
                await cleanupBuilderButtonUi(interaction, state).catch(() => {});
                if (state.activeEmbedManager) {`;
  if (text.includes(endAnchor) && !text.includes(endReplacement)) {
    text = text.replace(endAnchor, endReplacement);
  }

  return text;
});

console.log('[BUILDER_BUTTON_LIFECYCLE] Button preview sits directly under Builder; editor/preview cleanup follows Builder lifecycle.');
