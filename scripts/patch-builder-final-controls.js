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
            .setLabel('Remove buttons')
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


const searchEditorMarker = 'BUILDER_SEARCH_EDITOR_STATE_V1';

patchPreviewLifetimeFile('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', searchPatch => {
  let next = searchPatch;
  const pendingNeedle = `                pendingSelections.set(selectionKey(interaction), {
                    record,
                    previewRecord: record.previewRecord || record,
                    sourceRecord: record.sourceRecord || null,
                    expiresAt: Date.now() + PENDING_TTL,
                });`;
  const pendingReplacement = `                const initialSelection = {
                    record,
                    previewRecord: record.previewRecord || record,
                    sourceRecord: record.sourceRecord || null,
                    expiresAt: Date.now() + PENDING_TTL,
                };
                pendingSelections.set(selectionKey(interaction), initialSelection);
                // ${searchEditorMarker}: make Search state available before the Builder
                // creates its browser editor session. Modify routing may still consume
                // pendingSelections later, but live preview/editor state is immediate.
                interaction.__cloudyInitialBuilderSelection = initialSelection;`;

  if (!next.includes(searchEditorMarker)) {
    if (!next.includes(pendingNeedle)) {
      throw new Error('[BUILDER_SEARCH_EDITOR_STATE] Search pending selection block missing');
    }
    next = next.replace(pendingNeedle, pendingReplacement);
  }
  return next;
});

patchPreviewLifetimeFile('src/commands/Tools/embedbuilder.js', builder => {
  let next = builder;

  const importNeedle = `import { openEmbedManager, saveModifiedEmbed } from '../../services/embedManagerService.js';`;
  const importReplacement = `import {
    applyInitialSearchSelectionToState,
    openEmbedManager,
    saveModifiedEmbed,
} from '../../services/embedManagerService.js';`;
  if (!next.includes('applyInitialSearchSelectionToState,')) {
    if (!next.includes(importNeedle)) {
      throw new Error('[BUILDER_SEARCH_EDITOR_STATE] Embed Manager import block missing');
    }
    next = next.replace(importNeedle, importReplacement);
  }

  const stateEndNeedle = `                builderChildMessages: new Map(),
            };`;
  const stateEndReplacement = `                builderChildMessages: new Map(),
            };

            // ${searchEditorMarker}: Search must hydrate the exact same Builder state
            // as normal Modify before the browser editor can emit title/message edits.
            applyInitialSearchSelectionToState(interaction, state);`;
  if (!next.includes(searchEditorMarker)) {
    if (!next.includes(stateEndNeedle)) {
      throw new Error('[BUILDER_SEARCH_EDITOR_STATE] Builder state initialization block missing');
    }
    next = next.replace(stateEndNeedle, stateEndReplacement);
  }

  return next;
});

patchPreviewLifetimeFile('src/services/embedManagerService.js', manager => {
  let next = manager;
  const anchor = `function loadEmbedIntoState(state, resolved) {`;
  if (!next.includes('export function applyInitialSearchSelectionToState(')) {
    if (!next.includes(anchor)) {
      throw new Error('[BUILDER_SEARCH_EDITOR_STATE] state loader anchor missing');
    }
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
    if (loaded) {
        // ${searchEditorMarker}: consume once. All later editor updates mutate this
        // already-selected canonical state instead of the empty Builder defaults.
        delete interaction.__cloudyInitialBuilderSelection;
    }
    return loaded;
}

`;
    next = next.replace(anchor, helper + anchor);
  }
  return next;
});

console.log('[BUILDER_SEARCH_EDITOR_STATE] slash Search selection hydrates Builder state before editor startup.');
