import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_BUTTON_FIX] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_BUTTON_FIX] ${path}: patched`);
}

patchFile('src/commands/Tools/embedbuilder.js', text => {
  text = text.replaceAll(".setLabel('Edit buttons')", ".setLabel('Add buttons')");
  text = text.replaceAll(
    ".setLabel(state.pendingBuilderDelete ? 'Cancel delete' : 'Delete from Builder')",
    ".setLabel(state.pendingBuilderDelete ? 'Cancel delete' : 'Delete from builder')",
  );
  text = text.replaceAll(
    '.setDisabled(!canDeleteBuilderRecord(state.modifyTarget))',
    '.setDisabled(!state.modifyTarget)',
  );

  const postPayload = '        const payload = { embeds: [embeds[index]] };';
  if (text.includes(postPayload) && !text.includes(
    "const components = getBuilderMessageComponents(state);\n            if (components.length) payload.components = components;",
  )) {
    text = text.replace(
      postPayload,
      `        const payload = { embeds: [embeds[index]] };
        if (isLast) {
            const components = getBuilderMessageComponents(state);
            if (components.length) payload.components = components;
        }`,
    );
  }

  return text;
});

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  const responseAnchor = `  state.componentRows = next;
  state.componentsDirty = true;
  await submitted.deferUpdate().catch(() => {});`;
  const responseReplacement = `  state.componentRows = next;
  state.componentRowsSourceMessageId = state.modifyTarget?.messageId
    ? String(state.modifyTarget.messageId)
    : 'new';
  state.componentsDirty = true;
  await submitted.deferUpdate().catch(() => {});`;
  if (text.includes(responseAnchor)) {
    text = text.replaceAll(responseAnchor, responseReplacement);
  }

  return text;
});

patchFile('src/services/embedManagerService.js', text => {
  if (!text.includes("getBuilderMessageComponents")) {
    const importAnchor = "import { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';";
    if (!text.includes(importAnchor)) {
      throw new Error('[BUILDER_BUTTON_FIX] button component import anchor missing');
    }
    text = text.replace(
      importAnchor,
      importAnchor + "\nimport { getBuilderMessageComponents } from './embedBuilderButtonEditorService.js';",
    );
  }

  const payloadAnchor = '    const payload = { embeds };';
  const componentLine = '    if (state.componentsDirty) payload.components = getBuilderMessageComponents(state);';
  if (text.includes(payloadAnchor) && !text.includes(componentLine)) {
    text = text.replace(payloadAnchor, payloadAnchor + '\n' + componentLine);
  }

  const editedAnchor = `    if (!edited) return { ok: false, reason: 'edit-failed' };`;
  if (text.includes(editedAnchor) && !text.includes("state.componentRowsSourceMessageId = String(edited.id);")) {
    text = text.replace(
      editedAnchor,
      editedAnchor + `
    if (state.componentsDirty) {
        state.componentRows = getBuilderMessageComponents(state);
        state.componentRowsSourceMessageId = String(edited.id);
        state.componentsDirty = false;
    }`,
    );
  }

  return text;
});

console.log('[BUILDER_BUTTON_FIX] Add buttons and clickable safe delete enabled.');
