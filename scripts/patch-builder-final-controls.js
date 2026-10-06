import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'BUILDER_FINAL_CONTROLS_V1';
let text = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

// Always enforce the final control layout. Earlier ordered migrations may
// legitimately rewrite buildControls after a previous run while leaving this
// marker behind, so marker presence alone is not proof that the buttons remain.
const start = text.indexOf('function buildControls(state) {');
const end = text.indexOf('\n}\n\nfunction getPreviewUpdateQueue', start);
if (start < 0 || end < 0) {
  throw new Error('[BUILDER_FINAL_CONTROLS] buildControls block missing');
}

const replacement = `function buildControls(state) {
    // ${marker}: final user-requested five-row layout.
    const sourceHasLogo = Boolean(state.modifyTarget?.sourceEmbedData?.thumbnail?.url);
    const hasLogo = !state.removeExistingLogo && (state.showLogo || sourceHasLogo);

    const titleButton = new ButtonBuilder()
        .setLabel('Edit title & message')
        .setEmoji('✍🏼');
    if (state.contentEditorUrl) {
        titleButton.setURL(state.contentEditorUrl).setStyle(ButtonStyle.Link);
    } else {
        titleButton
            .setCustomId('simple_embed_content')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);
    }

    const titleRow = new ActionRowBuilder().addComponents(titleButton);

    const logoRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_logo')
            .setLabel('Add logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('☁️')
            .setDisabled(state.showLogo && !state.removeExistingLogo),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_logo')
            .setLabel('Remove logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️')
            .setDisabled(!hasLogo),
    );

    const contentRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_media')
            .setLabel('Add media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📷'),
        new ButtonBuilder()
            .setCustomId('simple_embed_clear_media')
            .setLabel('Remove media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('❌')
            .setDisabled(!hasMedia(state)),
        new ButtonBuilder()
            .setCustomId('simple_embed_footer')
            .setLabel('Edit footer')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝'),
        (() => {
            const button = new ButtonBuilder()
                .setLabel('Set side color')
                .setEmoji('🎨');
            if (state.colorPickerUrl) {
                return button.setURL(state.colorPickerUrl).setStyle(ButtonStyle.Link);
            }
            return button
                .setCustomId('simple_embed_color_unavailable')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true);
        })(),
    );

    const editRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_buttons')
            .setLabel('Add buttons')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔘'),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_buttons')
            .setLabel('Remove button')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⛔'),
        new ButtonBuilder()
            .setCustomId('simple_embed_modify')
            .setLabel('Modify embed')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛠️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_reappear')
            .setLabel(state.reappearAfter ? \`Reappear: \${state.reappearAfter}\` : 'Reappear')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔁'),
    );

    const saveRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_post')
            .setLabel(state.pendingBuilderDelete
                ? 'Save deletion'
                : (state.modifyTarget ? 'Save changes' : 'Post message'))
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Danger : ButtonStyle.Success)
            .setEmoji(state.pendingBuilderDelete ? '🗑️' : (state.modifyTarget ? '💾' : '📤')),
        new ButtonBuilder()
            .setCustomId('simple_embed_close')
            .setLabel('Close message')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('✖️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_reset')
            .setLabel('Reset')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('♻️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_delete_from_builder')
            // Delete from builder action; keep the visible label compact beside Reset.
            .setLabel(state.pendingBuilderDelete ? 'Cancel' : 'Delete')
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Secondary : ButtonStyle.Danger)
            .setEmoji(state.pendingBuilderDelete ? '↩️' : '🗑️')
            .setDisabled(!state.modifyTarget),
    );

    return [titleRow, logoRow, contentRow, editRow, saveRow];
}`;

text = text.slice(0, start) + replacement + text.slice(end + 2);
fs.writeFileSync(path, text, 'utf8');
console.log('[BUILDER_FINAL_CONTROLS] Add/Remove buttons, Reappear, Post/Close and Reset/Delete restored in final live layout.');


const previewLifetimeMarker = 'BUILDER_PREVIEW_LIFETIME_V2_FINAL_GUARD';

function patchPreviewLifetimeFile(filePath, patcher) {
  const before = fs.readFileSync(filePath, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_PREVIEW_LIFETIME] ${filePath}: already current`);
    return;
  }
  fs.writeFileSync(filePath, after, 'utf8');
  console.log(`[BUILDER_PREVIEW_LIFETIME] ${filePath}: patched`);
}

patchPreviewLifetimeFile('src/utils/interactionMessageLifecycle.js', lifecycle => {
  let next = lifecycle;
  const oldSignature = 'export function shouldUseTransientTimer(payload, message) {';
  const finalSignature = 'export function shouldUseTransientTimer(payload, message, interaction = null) {';

  if (next.includes(oldSignature)) {
    next = next.replace(oldSignature, finalSignature);
  }
  if (!next.includes(finalSignature)) {
    throw new Error('[BUILDER_PREVIEW_LIFETIME] transient timer signature missing');
  }

  const guard = `  // ${previewLifetimeMarker}: split live preview belongs to /embedbuilder.\n  if (String(interaction?.commandName || '').trim().toLowerCase() === 'embedbuilder') return false;\n`;
  if (!next.includes(previewLifetimeMarker)) {
    next = next.replace(finalSignature + '\n', finalSignature + '\n' + guard);
  }

  next = next.replaceAll(
    'shouldUseTransientTimer(payload, message)',
    'shouldUseTransientTimer(payload, message, interaction)',
  );

  if (!next.includes('shouldUseTransientTimer(payload, message, interaction)')) {
    throw new Error('[BUILDER_PREVIEW_LIFETIME] interaction-aware transient call missing');
  }
  return next;
});

patchPreviewLifetimeFile('src/utils/transientResponse.js', transient => {
  let next = transient;
  const signature = 'export async function scheduleTransientInteractionReplyDeletion(interaction) {';
  if (!next.includes(signature)) {
    throw new Error('[BUILDER_PREVIEW_LIFETIME] fallback cleanup function missing');
  }

  const guard = `  // ${previewLifetimeMarker}: /embedbuilder owns its original preview lifetime.\n  if (String(interaction?.commandName || '').trim().toLowerCase() === 'embedbuilder') return false;\n`;
  if (!next.includes(previewLifetimeMarker)) {
    next = next.replace(signature + '\n', signature + '\n' + guard);
  }
  return next;
});

console.log('[BUILDER_PREVIEW_LIFETIME] Search/editor live preview excluded from every generic 10-second cleanup path.');


const searchEditorMarker = 'BUILDER_SEARCH_EDITOR_STATE_V2';
const previewOwnershipMarker = 'BUILDER_SPLIT_PREVIEW_OWNERSHIP_V1';
const previewHelperMarker = 'BUILDER_PREVIEW_HELPER_FINAL_GUARD';

patchPreviewLifetimeFile('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', searchPatch => {
  let next = searchPatch;

  if (!next.includes(searchEditorMarker) && !next.includes('interaction.__cloudyInitialBuilderSelection = initialSelection')) {
    const setterStart = next.indexOf('pendingSelections.set(selectionKey(interaction), {');
    if (setterStart >= 0) {
      const setterEndToken = '});';
      const setterEnd = next.indexOf(setterEndToken, setterStart);
      if (setterEnd >= 0) {
        const original = next.slice(setterStart, setterEnd + setterEndToken.length);
        const objectStart = original.indexOf('{');
        const objectEnd = original.lastIndexOf('});');
        if (objectStart >= 0 && objectEnd > objectStart) {
          const body = original.slice(objectStart + 1, objectEnd).trim();
          const replacement = `const initialSelection = {
                    ${body}
                };
                pendingSelections.set(selectionKey(interaction), initialSelection);
                // ${searchEditorMarker}: Search state is available before the
                // Builder/editor starts, not only after a later Modify action.
                interaction.__cloudyInitialBuilderSelection = initialSelection;`;
          next = next.slice(0, setterStart) + replacement + next.slice(setterEnd + setterEndToken.length);
        }
      }
    }
  }

  if (!next.includes('interaction.__cloudyInitialBuilderSelection = initialSelection')) {
    console.warn('[BUILDER_SEARCH_EDITOR_STATE] current Search implementation has no compatible pending selection setter; preserving runtime instead of crashing startup');
  }
  return next;
});

patchPreviewLifetimeFile('src/commands/Tools/embedbuilder.js', builder => {
  let next = builder;

  if (!next.includes("registerBuilderPreviewMessage")) {
    const importAnchor = "import { InteractionHelper } from '../../utils/interactionHelper.js';";
    if (next.includes(importAnchor)) {
      next = next.replace(
        importAnchor,
        importAnchor + "\nimport { registerBuilderPreviewMessage, unregisterBuilderPreviewMessage } from '../../utils/builderSessionCleanup.js';",
      );
    }
  }

  if (!next.includes('applyInitialSearchSelectionToState,')) {
    const importNeedle = "import { openEmbedManager, saveModifiedEmbed } from '../../services/embedManagerService.js';";
    const importReplacement = `import {
    applyInitialSearchSelectionToState,
    openEmbedManager,
    saveModifiedEmbed,
} from '../../services/embedManagerService.js';`;
    if (next.includes(importNeedle)) {
      next = next.replace(importNeedle, importReplacement);
    }
  }

  if (!next.includes(searchEditorMarker) && next.includes('applyInitialSearchSelectionToState')) {
    const stateEndNeedle = `                builderChildMessages: new Map(),
            };`;
    const stateEndReplacement = `                builderChildMessages: new Map(),
            };

            // ${searchEditorMarker}: hydrate slash Search before any editor/update path.
            applyInitialSearchSelectionToState(interaction, state);`;
    if (next.includes(stateEndNeedle)) {
      next = next.replace(stateEndNeedle, stateEndReplacement);
    }
  }

  if (!next.includes(previewOwnershipMarker)) {
    const previewAssignment = '            state.builderMessage = previewMessage;';
    if (next.includes(previewAssignment)) {
      next = next.replace(
        previewAssignment,
        previewAssignment + `\n            // ${previewOwnershipMarker}: the top split preview belongs to this Builder session.\n            registerBuilderPreviewMessage(previewMessage);`,
      );
    }

    const cleanupAnchor = '    const webhook = state.builderWebhook || null;';
    if (next.includes(cleanupAnchor) && next.includes('async function deleteBuilderPreviewMessage(state)')) {
      next = next.replace(
        cleanupAnchor,
        cleanupAnchor + `\n    unregisterBuilderPreviewMessage(message || id);`,
      );
    }
  }

  const previewOnlyCall = 'refreshBuilderPreviewOnly(';
  const previewOnlyDefinition = 'function refreshBuilderPreviewOnly(';
  const asyncPreviewOnlyDefinition = 'async function refreshBuilderPreviewOnly(';
  if (
    next.includes(previewOnlyCall)
    && !next.includes(previewOnlyDefinition)
    && !next.includes(asyncPreviewOnlyDefinition)
  ) {
    const editContentAnchor = '\n\nasync function editContent(';
    const anchorIndex = next.indexOf(editContentAnchor);
    if (anchorIndex >= 0) {
      const helper = `\n\nasync function refreshBuilderPreviewOnly(interaction, state) {
    // ${previewHelperMarker}: safe final fallback. If an earlier migration
    // rewrote editor callbacks but lost the optimized preview-only helper,
    // use the canonical refresh instead of throwing at runtime.
    return refreshBuilder(interaction, state);
}`;
      next = next.slice(0, anchorIndex) + helper + next.slice(anchorIndex);
    }
  }

  return next;
});

patchPreviewLifetimeFile('src/services/embedManagerService.js', manager => {
  let next = manager;
  const anchor = 'function loadEmbedIntoState(state, resolved) {';
  if (!next.includes('export function applyInitialSearchSelectionToState(') && next.includes(anchor)) {
    const helper = `export function applyInitialSearchSelectionToState(interaction, state) {
    const initialSelection = interaction?.__cloudyInitialBuilderSelection;
    const record = initialSelection?.record;
    if (!record || !state || !interaction?.guild) return false;

    const selectedRecord = {
        ...record,
        previewRecord: initialSelection.previewRecord || record.previewRecord || null,
        sourceRecord: initialSelection.sourceRecord || record.sourceRecord || null,
    };
    const loaded = loadRecordSnapshotIntoState(state, interaction.guild, selectedRecord);
    if (loaded) delete interaction.__cloudyInitialBuilderSelection;
    return loaded;
}

`;
    next = next.replace(anchor, helper + anchor);
  }
  return next;
});

console.log('[BUILDER_SEARCH_EDITOR_STATE] Search hydration is deploy-safe and non-fatal.');
console.log('[BUILDER_SPLIT_PREVIEW_OWNERSHIP] top Search preview is Builder-owned until the Builder session ends.');
console.log('[BUILDER_PREVIEW_HELPER] editor preview helper invariant enforced.');


const existingReappearSaveMarker = 'BUILDER_EXISTING_REAPPEAR_SAVE_V1';

patchPreviewLifetimeFile('src/commands/Tools/embedbuilder.js', builder => {
  let next = builder;

  if (!next.includes("import { syncExistingEmbedReappearRule } from '../../services/embedReappearService.js';")) {
    const importAnchor = "import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';";
    if (!next.includes(importAnchor)) {
      throw new Error('[BUILDER_EXISTING_REAPPEAR] registry import anchor missing');
    }
    next = next.replace(
      importAnchor,
      importAnchor + "\nimport { syncExistingEmbedReappearRule } from '../../services/embedReappearService.js';",
    );
  }

  if (!next.includes('reappearTouched: false')) {
    const stateAnchor = '                reappearAfter: null,';
    if (!next.includes(stateAnchor)) {
      throw new Error('[BUILDER_EXISTING_REAPPEAR] Reappear state anchor missing');
    }
    next = next.replace(
      stateAnchor,
      stateAnchor + '\n                reappearTouched: false,',
    );
  }

  if (!next.includes('state.reappearTouched = true;')) {
    const modalAnchor = '                            state.reappearAfter = count;';
    if (!next.includes(modalAnchor)) {
      throw new Error('[BUILDER_EXISTING_REAPPEAR] Reappear modal anchor missing');
    }
    next = next.replace(
      modalAnchor,
      modalAnchor + '\n                            state.reappearTouched = true;',
    );
  }

  const saveStart = next.indexOf('async function finishExistingEmbedSave(') >= 0
    ? next.indexOf('async function finishExistingEmbedSave(')
    : next.indexOf('async function saveExistingEmbed(');
  if (saveStart < 0) {
    throw new Error('[BUILDER_EXISTING_REAPPEAR] existing embed save function missing');
  }

  const candidates = [
    next.indexOf('\nasync function ', saveStart + 20),
    next.indexOf('\nexport async function ', saveStart + 20),
    next.indexOf('\nfunction ', saveStart + 20),
    next.indexOf('\nexport function ', saveStart + 20),
  ].filter(index => index > saveStart);
  const saveEnd = candidates.length ? Math.min(...candidates) : next.length;
  let saveBlock = next.slice(saveStart, saveEnd);

  if (!saveBlock.includes('syncExistingEmbedReappearRule({')) {
    const refreshAnchor = '    void refreshBuilder(buttonInteraction, state).catch(() => {});';
    if (!saveBlock.includes(refreshAnchor)) {
      throw new Error('[BUILDER_EXISTING_REAPPEAR] post-save refresh anchor missing');
    }

    const persistence = `    // ${existingReappearSaveMarker}: Save Reappear for the existing canonical
    // embed too. Previously this only happened when posting a brand-new embed.
    if (state.reappearTouched) {
        const targetIndex = Math.max(0, Number(state.modifyTarget?.embedIndex) || 0);
        const activeEmbed = saved.message?.embeds?.[targetIndex]?.toJSON?.() || null;
        const activeComponents = (saved.message?.components || []).map(row =>
            row?.toJSON ? row.toJSON() : row
        );

        const reappear = await syncExistingEmbedReappearRule({
            guildId: guild.id,
            channelId: saved.message?.channelId
                || state.modifyTarget?.backingChannelId
                || state.modifyTarget?.channelId,
            messageId: saved.message?.id || state.modifyTarget?.messageId,
            embedIndex: targetIndex,
            every: state.reappearAfter,
            embed: activeEmbed,
            components: activeComponents,
        });

        if (!reappear.ok) {
            const failure = await buttonInteraction.followUp({
                content: 'The embed was saved, but the Reappear setting could not be saved. Try Save changes again.',
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            }).catch(() => null);
            if (failure) removeTransientMessage(buttonInteraction, failure);
            return { ...saved, ok: false, reason: 'reappear-persistence-failed' };
        }

        state.reappearTouched = false;
    }

`;

    saveBlock = saveBlock.replace(refreshAnchor, persistence + refreshAnchor);
    next = next.slice(0, saveStart) + saveBlock + next.slice(saveEnd);
  }

  return next;
});

console.log('[BUILDER_EXISTING_REAPPEAR] existing embed Save now persists Reappear after every startup migration.');


const commercialComponentsMarker = 'BUILDER_COMMERCIAL_COMPONENTS_V1';

patchPreviewLifetimeFile('src/commands/Tools/embedbuilder.js', builder => {
  let next = builder;

  // The top live preview must render safe copies of existing/custom buttons.
  next = next.replaceAll(
    'components: getBuilderMessageComponents(state),',
    'components: getBuilderPreviewComponents(state),',
  );

  // Earlier startup migrations may rewrite this import. Re-add the helpers
  // needed by the final commercial behavior without touching unrelated imports.
  const importMatch = next.match(/import \{([\s\S]*?)\} from '\.\.\/\.\.\/services\/embedBuilderButtonEditorService\.js';/);
  if (importMatch) {
    const names = importMatch[1]
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    for (const name of [
      'getBuilderPreviewComponents',
      'hydrateBuilderMessageComponents',
      'removeRightmostBuilderButton',
    ]) {
      if (!names.includes(name)) names.push(name);
    }
    const replacement = `import {
    ${names.join(',\n    ')},
} from '../../services/embedBuilderButtonEditorService.js';`;
    next = next.replace(importMatch[0], replacement);
  } else {
    throw new Error('[BUILDER_COMMERCIAL_COMPONENTS] Builder button import missing');
  }

  const removeStart = next.indexOf("case 'simple_embed_clear_buttons':");
  if (removeStart >= 0) {
    const removeEnd = next.indexOf("\n                        case '", removeStart + 8);
    const end = removeEnd >= 0 ? removeEnd : next.length;
    const block = next.slice(removeStart, end);
    if (!block.includes('removeRightmostBuilderButton(state.componentRows)')) {
      const replacement = `case 'simple_embed_clear_buttons':
                        case 'simple_embed_remove_buttons': {
                            if (state.modifyTarget && !state.componentsDirty) {
                                await hydrateBuilderMessageComponents(buttonInteraction.guild, state).catch(() => false);
                            }
                            const beforeCount = countBuilderButtons(state);
                            const nextRows = removeRightmostBuilderButton(state.componentRows);
                            const afterCount = nextRows.reduce(
                                (total, row) => total + (row.components || []).filter(component => Number(component?.type) === 2).length,
                                0,
                            );
                            if (afterCount < beforeCount) {
                                state.componentRows = nextRows;
                                state.componentRowsSourceMessageId = state.modifyTarget?.messageId
                                    ? String(state.modifyTarget.messageId)
                                    : 'new';
                                state.componentsDirty = true;
                            }
                            await buttonInteraction.deferUpdate().catch(() => {});
                            await refreshBuilder(buttonInteraction, state);
                            break;
                        }`;
      next = next.slice(0, removeStart) + replacement + next.slice(end);
    }
  }

  return next;
});

patchPreviewLifetimeFile('src/services/embedManagerService.js', manager => {
  let next = manager;

  const importMatch = next.match(/import \{([\s\S]*?)\} from '\.\/embedBuilderButtonEditorService\.js';/);
  if (importMatch) {
    const names = importMatch[1]
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    for (const name of [
      'hydrateBuilderMessageComponents',
      'loadBuilderComponentsFromMessage',
      'loadBuilderComponentsFromRecord',
    ]) {
      if (!names.includes(name)) names.push(name);
    }
    const replacement = `import {
    ${names.join(',\n    ')},
} from './embedBuilderButtonEditorService.js';`;
    next = next.replace(importMatch[0], replacement);
  } else {
    throw new Error('[BUILDER_COMMERCIAL_COMPONENTS] manager button import missing');
  }

  const loaderStart = next.indexOf('function loadRecordSnapshotIntoState(');
  const loaderEnd = next.indexOf('\nfunction loadEmbedIntoState', loaderStart);
  if (loaderStart >= 0 && loaderEnd > loaderStart) {
    let block = next.slice(loaderStart, loaderEnd);
    if (!block.includes('loadBuilderComponentsFromRecord(')) {
      block = block.replace(
        /\n {4}return true;\n}\s*$/,
        "\n    loadBuilderComponentsFromRecord(state, previewRecord || record);\n    return true;\n}\n",
      );
      next = next.slice(0, loaderStart) + block + next.slice(loaderEnd);
    }
  }

  const embedStart = next.indexOf('function loadEmbedIntoState(');
  const embedEnd = next.indexOf('\nfunction ', embedStart + 20);
  if (embedStart >= 0 && embedEnd > embedStart) {
    let block = next.slice(embedStart, embedEnd);
    if (!block.includes('loadBuilderComponentsFromMessage(state, message);')) {
      block = block.replace(
        /\n}\s*$/,
        "\n    loadBuilderComponentsFromMessage(state, message);\n}\n",
      );
      next = next.slice(0, embedStart) + block + next.slice(embedEnd);
    }
  }

  return next;
});

console.log('[BUILDER_COMMERCIAL_COMPONENTS] live buttons, right-to-left removal and final component hydration enforced.');


const buttonCustomEmojiMarker = 'BUILDER_BUTTON_CUSTOM_EMOJI_V1';

patchPreviewLifetimeFile('src/services/embedBuilderButtonEditorService.js', source => {
  let next = source;

  if (!next.includes('export function buildBuilderButtonManagerPayload')) {
    const modalAnchor = '\nasync function showAddResponseModal(';
    if (!next.includes(modalAnchor)) {
      throw new Error('[BUILDER_BUTTON_CUSTOM_EMOJI] manager payload export anchor missing');
    }
    next = next.replace(
      modalAnchor,
      "\nexport function buildBuilderButtonManagerPayload(state) {\n  return managerPayload(state);\n}\n" + modalAnchor,
    );
  }

  const required = [
    'export function setBuilderButtonEmoji',
    'export function buildButtonEmojiPagePayload',
    'export function buildBuilderButtonManagerPayload',
    'async function openButtonEmojiBrowser',
    "setCustomId('embed_button_emoji_target')",
    "componentInteraction.customId === 'embed_button_emoji_target'",
  ];
  const missing = required.filter(value => !next.includes(value));
  if (missing.length) {
    throw new Error('[BUILDER_BUTTON_CUSTOM_EMOJI] final runtime invariant missing: ' + missing.join(', '));
  }
  return next;
});

console.log('[BUILDER_BUTTON_CUSTOM_EMOJI] ' + buttonCustomEmojiMarker + ': custom emoji browser preserved after all startup migrations.');


const finalRuntimeInvariantMarker = 'FINAL_RUNTIME_INVARIANTS_V3';

// Final ordered-migration guard: exactly one stale-record Delete handler may
// survive. Earlier migrations can independently restore the same control.
patchPreviewLifetimeFile('src/commands/Tools/embedbuilder.js', builder => {
  let next = builder;
  const needle = "case 'simple_embed_delete_from_builder':";
  const starts = [];
  let cursor = 0;
  while ((cursor = next.indexOf(needle, cursor)) >= 0) {
    starts.push(cursor);
    cursor += needle.length;
  }

  if (starts.length > 1) {
    const blocks = starts.map(start => {
      const nextCase = next.indexOf("\n                        case '", start + needle.length);
      return {
        start,
        end: nextCase >= 0 ? nextCase : next.length,
        body: next.slice(start, nextCase >= 0 ? nextCase : next.length),
      };
    });
    const keep = blocks.findIndex(block => block.body.includes('togglePendingBuilderDeletion'));
    const keepIndex = keep >= 0 ? keep : 0;

    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (index === keepIndex) continue;
      next = next.slice(0, blocks[index].start) + next.slice(blocks[index].end);
    }
  }

  const remaining = next.split(needle).length - 1;
  if (remaining !== 1) {
    throw new Error('[FINAL_RUNTIME_INVARIANTS] expected exactly one Builder delete handler, got ' + remaining);
  }
  return next;
});

// Search must hand its selected canonical record to the Builder before the web
// editor can emit any updates. Preserve whichever preview/source records the
// current Search implementation already selected.
patchPreviewLifetimeFile('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', searchPatch => {
  let next = searchPatch;
  if (next.includes('interaction.__cloudyInitialBuilderSelection = initialSelection')) return next;

  const executeStart = next.indexOf('embedBuilderCommand.execute = async function executeWithLiveSearch');
  const setterStart = executeStart >= 0
    ? next.indexOf('pendingSelections.set(selectionKey(interaction), {', executeStart)
    : -1;
  if (setterStart < 0) {
    throw new Error('[FINAL_RUNTIME_INVARIANTS] Search selection setter missing');
  }

  const openBrace = next.indexOf('{', setterStart);
  const setterEnd = next.indexOf('\n                });', openBrace);
  if (openBrace < 0 || setterEnd < 0) {
    throw new Error('[FINAL_RUNTIME_INVARIANTS] Search selection object boundary missing');
  }

  const body = next.slice(openBrace + 1, setterEnd).trim();
  const replacement = `const initialSelection = {
                    ${body}
                };
                pendingSelections.set(selectionKey(interaction), initialSelection);
                // ${finalRuntimeInvariantMarker}: hydrate Search before editor updates.
                interaction.__cloudyInitialBuilderSelection = initialSelection;`;

  return next.slice(0, setterStart) + replacement + next.slice(setterEnd + '\n                });'.length);
});

// Keep original status lifetime intent when saved templates rename a transient
// response, while permanently protecting mixed/panel/log/catalog messages.
patchPreviewLifetimeFile('src/utils/transientResponse.js', transient => {
  let next = transient;

  if (!next.includes('const transientPayloads = new WeakSet();')) {
    const ttl = 'const TRANSIENT_TTL_MS = 10_000;';
    if (!next.includes(ttl)) {
      throw new Error('[FINAL_RUNTIME_INVARIANTS] transient TTL anchor missing');
    }
    next = next.replace(
      ttl,
      ttl + `
const transientPayloads = new WeakSet();

export function rememberTransientPayloadIntent(original, outgoing) {
  if (outgoing && typeof outgoing === 'object' && isTransientStatusPayload(original)) {
    transientPayloads.add(outgoing);
  }
  return outgoing;
}`,
    );
  } else if (!next.includes('export function rememberTransientPayloadIntent(')) {
    const weakSet = 'const transientPayloads = new WeakSet();';
    next = next.replace(
      weakSet,
      weakSet + `

export function rememberTransientPayloadIntent(original, outgoing) {
  if (outgoing && typeof outgoing === 'object' && isTransientStatusPayload(original)) {
    transientPayloads.add(outgoing);
  }
  return outgoing;
}`,
    );
  }

  const fnStart = next.indexOf('export function isTransientStatusPayload(');
  const fnEnd = fnStart >= 0
    ? next.indexOf('\n}\n\nexport function isPersistentBotMessage', fnStart)
    : -1;
  if (fnStart < 0 || fnEnd < 0) {
    throw new Error('[FINAL_RUNTIME_INVARIANTS] transient payload function boundary missing');
  }

  const finalFn = `export function isTransientStatusPayload(payload = null, message = null) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const embeds = source.embeds || message?.embeds || [];
  const content = source.content ?? message?.content ?? '';

  if (isPersistentBotMessage(message)) return false;
  if (transientPayloads.has(source)) return true;
  if (embeds.length && !embeds.every(isTransientStatusEmbed)) return false;
  return embeds.some(isTransientStatusEmbed) || isTransientStatusContent(content);
}`;

  next = next.slice(0, fnStart) + finalFn + next.slice(fnEnd + 2);
  return next;
});

// Fail a build instead of starting with a half-applied Search/Builder migration.
{
  const searchRuntime = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const builderRuntime = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  if (!searchRuntime.includes('interaction.__cloudyInitialBuilderSelection = initialSelection')) {
    throw new Error('[FINAL_RUNTIME_INVARIANTS] Search-to-Builder handoff missing');
  }
  const hydrateAt = builderRuntime.indexOf('applyInitialSearchSelectionToState(interaction, state)');
  const editorAt = builderRuntime.indexOf('createEmbedColorPickerSession({');
  if (hydrateAt < 0 || editorAt < 0 || hydrateAt > editorAt) {
    throw new Error('[FINAL_RUNTIME_INVARIANTS] Search state is not hydrated before editor startup');
  }
}

console.log('[FINAL_RUNTIME_INVARIANTS] FINAL_RUNTIME_INVARIANTS_V3: final runtime guards verified.');
