import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_BUTTON_PREVIEW] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_BUTTON_PREVIEW] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  const helperAnchor = `export function countBuilderButtons(state) {
  return getBuilderMessageComponents(state).reduce(
    (total, row) => total + row.components.filter(component => Number(component?.type) === BUTTON_COMPONENT_TYPE).length,
    0,
  );
}
`;

  const helperReplacement = helperAnchor + `
async function deletePrivateBuilderMessage(interaction, messageId, message = null) {
  if (!messageId) return;
  const deleted = interaction?.webhook?.deleteMessage
    ? await interaction.webhook.deleteMessage(String(messageId)).then(() => true).catch(() => false)
    : false;
  if (!deleted) await message?.delete?.().catch(() => {});
}

export async function syncBuilderButtonPreview(interaction, state) {
  const rows = getBuilderMessageComponents(state);
  const existingId = state?.activeButtonPreviewMessageId
    ? String(state.activeButtonPreviewMessageId)
    : null;

  if (!rows.length) {
    if (existingId) {
      await deletePrivateBuilderMessage(interaction, existingId, state.activeButtonPreviewMessage);
    }
    state.activeButtonPreviewMessageId = null;
    state.activeButtonPreviewMessage = null;
    return null;
  }

  if (existingId && interaction?.webhook?.editMessage) {
    const edited = await interaction.webhook.editMessage(existingId, {
      content: '',
      embeds: [],
      components: rows,
    }).catch(() => null);
    if (edited) {
      state.activeButtonPreviewMessage = edited;
      return edited;
    }
  }

  const preview = await interaction.followUp({
    components: rows,
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  }).catch(() => null);

  if (preview) {
    state.activeButtonPreviewMessageId = String(preview.id);
    state.activeButtonPreviewMessage = preview;
  }
  return preview;
}
`;

  if (!text.includes('export async function syncBuilderButtonPreview')) {
    if (!text.includes(helperAnchor)) {
      throw new Error('[BUILDER_BUTTON_PREVIEW] count helper anchor missing');
    }
    text = text.replace(helperAnchor, helperReplacement);
  }

  text = text.replaceAll(
    `  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});`,
    `  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});
  await syncBuilderButtonPreview(submitted, state).catch(() => {});`,
  );

  const openAnchor = `export async function openEmbedButtonEditor(buttonInteraction, state, refreshBuilder) {
  await ensureRowsLoaded(buttonInteraction, state);
  await buttonInteraction.deferUpdate().catch(() => {});

  if (state.activeButtonEditorMessage?.delete) {
    await state.activeButtonEditorMessage.delete().catch(() => {});
  }
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorCollector?.stop?.('replaced');

  const panelMessage = await buttonInteraction.followUp({`;

  const openReplacement = `export async function openEmbedButtonEditor(buttonInteraction, state, refreshBuilder) {
  await ensureRowsLoaded(buttonInteraction, state);
  await buttonInteraction.deferUpdate().catch(() => {});
  await syncBuilderButtonPreview(buttonInteraction, state).catch(() => {});

  const existingEditorId = state.activeButtonEditorMessageId
    ? String(state.activeButtonEditorMessageId)
    : null;
  if (
    existingEditorId
    && state.activeButtonEditorCollector
    && !state.activeButtonEditorCollector.ended
    && buttonInteraction.webhook?.editMessage
  ) {
    const edited = await buttonInteraction.webhook.editMessage(
      existingEditorId,
      managerPayload(state),
    ).catch(() => null);
    if (edited) {
      state.activeButtonEditorMessage = edited;
      return;
    }
  }

  if (existingEditorId) {
    await deletePrivateBuilderMessage(
      buttonInteraction,
      existingEditorId,
      state.activeButtonEditorMessage,
    );
  }
  state.activeButtonEditorMessageId = null;
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorCollector?.stop?.('replaced');

  const panelMessage = await buttonInteraction.followUp({`;

  if (!text.includes(openAnchor)) {
    throw new Error('[BUILDER_BUTTON_PREVIEW] open editor anchor missing');
  }
  text = text.replace(openAnchor, openReplacement);

  const activeAnchor = `  if (!panelMessage) return;
  state.activeButtonEditorMessage = panelMessage;

  const collector = panelMessage.createMessageComponentCollector({`;
  const activeReplacement = `  if (!panelMessage) return;
  state.activeButtonEditorMessage = panelMessage;
  state.activeButtonEditorMessageId = String(panelMessage.id);

  const collector = panelMessage.createMessageComponentCollector({`;
  if (!text.includes(activeAnchor)) {
    throw new Error('[BUILDER_BUTTON_PREVIEW] editor message state anchor missing');
  }
  text = text.replace(activeAnchor, activeReplacement);

  const endAnchor = `  collector.on('end', async () => {
    if (state.activeButtonEditorCollector === collector) state.activeButtonEditorCollector = null;
    if (state.activeButtonEditorMessage === panelMessage) {
      state.activeButtonEditorMessage = null;
      await panelMessage.delete?.().catch(() => {});
    }
  });`;
  const endReplacement = `  collector.on('end', async () => {
    if (state.activeButtonEditorCollector === collector) state.activeButtonEditorCollector = null;
    if (state.activeButtonEditorMessageId === String(panelMessage.id)) {
      state.activeButtonEditorMessage = null;
      state.activeButtonEditorMessageId = null;
      await deletePrivateBuilderMessage(buttonInteraction, panelMessage.id, panelMessage);
    }
  });`;
  if (!text.includes(endAnchor)) {
    throw new Error('[BUILDER_BUTTON_PREVIEW] editor cleanup anchor missing');
  }
  text = text.replace(endAnchor, endReplacement);

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const importAnchor = `    openEmbedButtonEditor,
} from '../../services/embedBuilderButtonEditorService.js';`;
  const importReplacement = `    openEmbedButtonEditor,
    syncBuilderButtonPreview,
} from '../../services/embedBuilderButtonEditorService.js';`;
  if (!text.includes('syncBuilderButtonPreview')) {
    if (!text.includes(importAnchor)) {
      throw new Error('[BUILDER_BUTTON_PREVIEW] Builder button import anchor missing');
    }
    text = text.replace(importAnchor, importReplacement);
  }

  const removeAnchor = `                            state.componentsDirty = true;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(buttonInteraction, state);
                            break;`;
  const removeReplacement = `                            state.componentsDirty = true;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(buttonInteraction, state);
                            await syncBuilderButtonPreview(buttonInteraction, state).catch(() => {});
                            break;`;
  if (text.includes(removeAnchor)) {
    text = text.replace(removeAnchor, removeReplacement);
  }

  const resetAnchor = `                            state.componentRows = [];
                            state.componentRowsSourceMessageId = 'new';
                            state.componentsDirty = false;
                            await buttonInteraction.deferUpdate();`;
  const resetReplacement = `                            state.componentRows = [];
                            state.componentRowsSourceMessageId = 'new';
                            state.componentsDirty = false;
                            await buttonInteraction.deferUpdate();
                            await syncBuilderButtonPreview(buttonInteraction, state).catch(() => {});`;
  if (text.includes(resetAnchor)) {
    text = text.replace(resetAnchor, resetReplacement);
  }

  return text;
});

console.log('[BUILDER_BUTTON_PREVIEW] Buttons now appear as a real live component preview and the editor is reused instead of duplicated.');
