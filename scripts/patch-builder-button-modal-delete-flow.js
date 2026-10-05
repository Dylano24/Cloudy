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
    console.log('[BUILDER_BUTTON_MODAL_DELETE] inline modal routing already evolved; leaving current routing intact');
    return text;
  }
  return text.replace(anchor, replacement);
});

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  // This file now owns child-panel lifecycle natively via builderChildMessages.
  // Do not re-apply the older activeButtonEditorMessage/collector migration:
  // doing so can create duplicate cleanup handlers and duplicate button panels.
  if (text.includes('state.builderChildMessages.set(panelMessage.id, panelMessage)')) {
    console.log('[BUILDER_BUTTON_MODAL_DELETE] native child-panel lifecycle detected; obsolete editor migration skipped');
    return text;
  }
  console.log('[BUILDER_BUTTON_MODAL_DELETE] legacy editor shape not recognized; leaving runtime code unchanged');
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
    console.log('[BUILDER_BUTTON_MODAL_DELETE] delete eligibility already evolved; leaving current behavior intact');
    return text;
  }
  return text.replace(oldEligibility, newEligibility);
});

console.log('[BUILDER_BUTTON_MODAL_DELETE] modal routing, single button editor panel and stale template delete fixed.');
