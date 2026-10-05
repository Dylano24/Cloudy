import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_BUTTON_MODAL_DELETE] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_BUTTON_MODAL_DELETE] ${path}: patched`);
}

patchFile('src/events/interactionCreate.js', text => {
  const anchor = `            interaction.customId.startsWith('cloudy_report:')
            || interaction.customId.startsWith('app_review_')
            || interaction.customId.startsWith('jtc_')
            || interaction.customId.startsWith('config_wizard_modal:')
            || interaction.customId.startsWith('log_dash_channel_modal:')
            || interaction.customId.startsWith('log_dash_filter_modal:')
`;
  const replacement = `            interaction.customId.startsWith('cloudy_report:')
            || interaction.customId.startsWith('app_review_')
            || interaction.customId.startsWith('jtc_')
            || interaction.customId.startsWith('config_wizard_modal:')
            || interaction.customId.startsWith('log_dash_channel_modal:')
            || interaction.customId.startsWith('log_dash_filter_modal:')
            || interaction.customId.startsWith('embed_button_edit_modal:')
`;
  if (!text.includes(anchor)) {
    throw new Error('[BUILDER_BUTTON_MODAL_DELETE] inline modal skip anchor missing');
  }
  return text.replace(anchor, replacement);
});

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  const openAnchor = `export async function openEmbedButtonEditor(buttonInteraction, state, refreshBuilder) {
  await ensureRowsLoaded(buttonInteraction, state);
  await buttonInteraction.deferUpdate().catch(() => {});

  const panelMessage = await buttonInteraction.followUp({`;
  const openReplacement = `export async function openEmbedButtonEditor(buttonInteraction, state, refreshBuilder) {
  await ensureRowsLoaded(buttonInteraction, state);
  await buttonInteraction.deferUpdate().catch(() => {});

  if (state.activeButtonEditorMessage?.delete) {
    await state.activeButtonEditorMessage.delete().catch(() => {});
  }
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorCollector?.stop?.('replaced');

  const panelMessage = await buttonInteraction.followUp({`;
  if (!text.includes(openAnchor)) {
    throw new Error('[BUILDER_BUTTON_MODAL_DELETE] button editor open anchor missing');
  }
  text = text.replace(openAnchor, openReplacement);

  const panelAnchor = `  if (!panelMessage) return;

  const collector = panelMessage.createMessageComponentCollector({`;
  const panelReplacement = `  if (!panelMessage) return;
  state.activeButtonEditorMessage = panelMessage;

  const collector = panelMessage.createMessageComponentCollector({`;
  if (!text.includes(panelAnchor)) {
    throw new Error('[BUILDER_BUTTON_MODAL_DELETE] panel anchor missing');
  }
  text = text.replace(panelAnchor, panelReplacement);

  const collectorAnchor = `  collector.on('collect', componentInteraction => {`;
  const collectorReplacement = `  state.activeButtonEditorCollector = collector;

  collector.on('collect', componentInteraction => {`;
  if (!text.includes(collectorAnchor)) {
    throw new Error('[BUILDER_BUTTON_MODAL_DELETE] collector anchor missing');
  }
  text = text.replace(collectorAnchor, collectorReplacement);

  const functionEnd = `  });
}
`;
  const cleanup = `  });

  collector.on('end', async () => {
    if (state.activeButtonEditorCollector === collector) state.activeButtonEditorCollector = null;
    if (state.activeButtonEditorMessage === panelMessage) {
      state.activeButtonEditorMessage = null;
      await panelMessage.delete?.().catch(() => {});
    }
  });
}
`;
  const lastOpen = text.lastIndexOf(functionEnd);
  if (lastOpen < 0) {
    throw new Error('[BUILDER_BUTTON_MODAL_DELETE] editor function end missing');
  }
  text = text.slice(0, lastOpen) + cleanup + text.slice(lastOpen + functionEnd.length);

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const oldEligibility = `function canDeleteBuilderRecord(target) {
    return Boolean(
        target?.messageId
        && target?.channelId
        && target?.source !== 'system-catalog'
        && !target?.templateMode
    );
}`;
  const newEligibility = `function canDeleteBuilderRecord(target) {
    return Boolean(
        target?.messageId
        && target?.channelId
        && target?.source !== 'system-catalog'
    );
}`;
  if (!text.includes(oldEligibility)) {
    throw new Error('[BUILDER_BUTTON_MODAL_DELETE] delete eligibility block missing');
  }
  return text.replace(oldEligibility, newEligibility);
});

console.log('[BUILDER_BUTTON_MODAL_DELETE] modal routing, single button editor panel and stale template delete fixed.');
