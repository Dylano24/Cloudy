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

  if (
    text.includes('state.activeButtonEditorMessageId')
    && text.includes('state.activeButtonEditorCollector = collector;')
    && text.includes('deletePrivateBuilderMessage')
  ) {
    console.log('[BUILDER_BUTTON_PREVIEW] native editor lifecycle detected; obsolete open-editor migration skipped');
    return text;
  }

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
  if (!text.includes('syncBuilderButtonPreview')) {
    const importMatch = text.match(/import \\{([\\s\\S]*?)\\} from '\\.\\.\\/\\.\\.\\/services\\/embedBuilderButtonEditorService\\.js';/);
    if (!importMatch) {
      throw new Error('[BUILDER_BUTTON_PREVIEW] Builder button import missing');
    }
    const names = importMatch[1].split(',').map(value => value.trim()).filter(Boolean);
    if (!names.includes('syncBuilderButtonPreview')) names.push('syncBuilderButtonPreview');
    text = text.replace(
      importMatch[0],
      `import {
    ${names.join(',\\n    ')},
} from '../../services/embedBuilderButtonEditorService.js';`,
    );
  }

  function ensurePreviewSyncInCase(caseId) {
    const start = text.indexOf(`case '${caseId}':`);
    if (start < 0) return;
    const next = text.indexOf("\n                        case '", start + 8);
    const end = next >= 0 ? next : text.length;
    let block = text.slice(start, end);
    if (block.includes('syncBuilderButtonPreview(buttonInteraction, state)')) return;

    const refreshNeedle = 'await refreshBuilder(buttonInteraction, state);';
    const refreshIndex = block.lastIndexOf(refreshNeedle);
    if (refreshIndex >= 0) {
      const insertAt = refreshIndex + refreshNeedle.length;
      block = block.slice(0, insertAt)
        + "\n                            await syncBuilderButtonPreview(buttonInteraction, state).catch(() => {});"
        + block.slice(insertAt);
      text = text.slice(0, start) + block + text.slice(end);
      return;
    }

    const deferNeedle = 'await buttonInteraction.deferUpdate();';
    const deferIndex = block.lastIndexOf(deferNeedle);
    if (deferIndex >= 0) {
      const insertAt = deferIndex + deferNeedle.length;
      block = block.slice(0, insertAt)
        + "\n                            await syncBuilderButtonPreview(buttonInteraction, state).catch(() => {});"
        + block.slice(insertAt);
      text = text.slice(0, start) + block + text.slice(end);
    }
  }

  ensurePreviewSyncInCase('simple_embed_remove_buttons');
  ensurePreviewSyncInCase('simple_embed_reset');

  return text;
});

console.log('[BUILDER_BUTTON_PREVIEW] Buttons now appear as a real live component preview and the editor is reused instead of duplicated.');
