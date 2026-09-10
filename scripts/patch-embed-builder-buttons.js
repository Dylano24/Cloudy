import fs from 'node:fs';

function patchFile(path, replacements, marker) {
  const before = fs.readFileSync(path, 'utf8');
  let text = before;

  if (text.includes(marker)) {
    console.log(`[EMBED_BUILDER_BUTTONS] ${path}: already current`);
    return;
  }

  for (const { find, replace, label } of replacements) {
    if (!text.includes(find)) {
      console.error(`[EMBED_BUILDER_BUTTONS] ${path}: marker not found (${label})`);
      process.exit(1);
    }
    text = text.replace(find, replace);
  }

  if (!text.includes(marker)) {
    console.error(`[EMBED_BUILDER_BUTTONS] ${path}: final marker missing`);
    process.exit(1);
  }

  fs.writeFileSync(path, text, 'utf8');
  console.log(`[EMBED_BUILDER_BUTTONS] ${path}: patched`);
}

const builderPath = 'src/commands/Tools/embedbuilder.js';
patchFile(builderPath, [
  {
    label: 'button editor import',
    find: "import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';\n",
    replace: "import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';\nimport {\n    countBuilderButtons,\n    getBuilderMessageComponents,\n    openEmbedButtonEditor,\n} from '../../services/embedBuilderButtonEditorService.js';\n",
  },
  {
    label: 'post components',
    find: "        const payload = { embeds: [embeds[index]] };\n\n        if (isLast && state.mediaBuffer && state.mediaName) {",
    replace: "        const payload = { embeds: [embeds[index]] };\n        if (isLast) {\n            const components = getBuilderMessageComponents(state);\n            if (components.length) payload.components = components;\n        }\n\n        if (isLast && state.mediaBuffer && state.mediaName) {",
  },
  {
    label: 'button count',
    find: "            `**Media** › ${mediaLabel}`,\n",
    replace: "            `**Media** › ${mediaLabel}`,\n            `**Buttons** › ${countBuilderButtons(state)}`,\n",
  },
  {
    label: 'control layout',
    find: "    const contentRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setURL(state.contentEditorUrl)\n            .setLabel('Edit title and message')\n            .setStyle(ButtonStyle.Link)\n            .setEmoji('✍🏼'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_logo')\n            .setLabel('Add Cloudy logo')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('☁️')\n            .setDisabled(state.showLogo && !state.removeExistingLogo),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_remove_logo')\n            .setLabel('Remove logo')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('🗑️')\n            .setDisabled(!hasLogo),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_footer')\n            .setLabel('Edit footer')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('📝'),\n        new ButtonBuilder()\n            .setURL(state.colorPickerUrl)\n            .setLabel('Set side color')\n            .setStyle(ButtonStyle.Link)\n            .setEmoji('🎨'),\n    );\n\n    const actionRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setCustomId('simple_embed_media')\n            .setLabel('Set picture/video GIF')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('📷'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_clear_media')\n            .setLabel('Remove media')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('🗑️')\n            .setDisabled(!hasMedia(state)),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_post')\n            .setLabel(state.modifyTarget ? 'Save changes' : 'Post message')\n            .setStyle(ButtonStyle.Success)\n            .setEmoji(state.modifyTarget ? '💾' : '📤'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_reset')\n            .setLabel('Reset everything')\n            .setStyle(ButtonStyle.Danger)\n            .setEmoji('♻️'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_modify')\n            .setLabel('Modify embed')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('🛠️'),\n    );\n\n    return [contentRow, actionRow];\n}",
    replace: "    const titleRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setURL(state.contentEditorUrl)\n            .setLabel('Edit title & message')\n            .setStyle(ButtonStyle.Link)\n            .setEmoji('✍🏼'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_modify')\n            .setLabel('Modify embed')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('🛠️'),\n    );\n\n    const logoRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setCustomId('simple_embed_logo')\n            .setLabel('Add logo')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('☁️')\n            .setDisabled(state.showLogo && !state.removeExistingLogo),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_remove_logo')\n            .setLabel('Remove logo')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('🗑️')\n            .setDisabled(!hasLogo),\n    );\n\n    const mediaRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setCustomId('simple_embed_media')\n            .setLabel('Add media')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('📷'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_clear_media')\n            .setLabel('Remove media')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('❌')\n            .setDisabled(!hasMedia(state)),\n    );\n\n    const styleRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setCustomId('simple_embed_footer')\n            .setLabel('Edit footer')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('📝'),\n        new ButtonBuilder()\n            .setURL(state.colorPickerUrl)\n            .setLabel('Set side color')\n            .setStyle(ButtonStyle.Link)\n            .setEmoji('🎨'),\n    );\n\n    const actionRow = new ActionRowBuilder().addComponents(\n        new ButtonBuilder()\n            .setCustomId('simple_embed_buttons')\n            .setLabel('Edit buttons')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('🔘'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_remove_buttons')\n            .setLabel('Remove buttons')\n            .setStyle(ButtonStyle.Secondary)\n            .setEmoji('⛔'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_reset')\n            .setLabel('Reset')\n            .setStyle(ButtonStyle.Danger)\n            .setEmoji('♻️'),\n        new ButtonBuilder()\n            .setCustomId('simple_embed_post')\n            .setLabel(state.modifyTarget ? 'Save change' : 'Post message')\n            .setStyle(ButtonStyle.Success)\n            .setEmoji(state.modifyTarget ? '💾' : '📤'),\n    );\n\n    return [titleRow, logoRow, mediaRow, styleRow, actionRow];\n}",
  },
  {
    label: 'state component fields',
    find: "                modifyTarget: null,\n                colorSessionToken: null,",
    replace: "                modifyTarget: null,\n                componentRows: [],\n                componentRowsSourceMessageId: 'new',\n                componentsDirty: false,\n                colorSessionToken: null,",
  },
  {
    label: 'button collector actions',
    find: "                        case 'simple_embed_modify':\n                            await openEmbedManager(",
    replace: "                        case 'simple_embed_buttons':\n                            await openEmbedButtonEditor(\n                                buttonInteraction,\n                                state,\n                                (editorInteraction, editorState) => refreshBuilder(editorInteraction, editorState),\n                            );\n                            break;\n                        case 'simple_embed_remove_buttons':\n                            state.componentRows = [];\n                            state.componentRowsSourceMessageId = state.modifyTarget?.messageId\n                                ? String(state.modifyTarget.messageId)\n                                : 'new';\n                            state.componentsDirty = true;\n                            await buttonInteraction.deferUpdate();\n                            await refreshBuilder(buttonInteraction, state);\n                            break;\n                        case 'simple_embed_modify':\n                            await openEmbedManager(",
  },
  {
    label: 'reset components',
    find: "                            state.mediaConvertedFromVideo = false;\n                            state.modifyTarget = null;\n                            await buttonInteraction.deferUpdate();",
    replace: "                            state.mediaConvertedFromVideo = false;\n                            state.modifyTarget = null;\n                            state.componentRows = [];\n                            state.componentRowsSourceMessageId = 'new';\n                            state.componentsDirty = false;\n                            await buttonInteraction.deferUpdate();",
  },
], "setCustomId('simple_embed_buttons')");

const managerPath = 'src/services/embedManagerService.js';
patchFile(managerPath, [
  {
    label: 'component helper import',
    find: "import { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';\n",
    replace: "import { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';\nimport { getBuilderMessageComponents } from './embedBuilderButtonEditorService.js';\n",
  },
  {
    label: 'save edited components',
    find: "    const payload = { embeds };\n    if (state.mediaBuffer && state.mediaName) payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];",
    replace: "    const payload = { embeds };\n    if (state.componentsDirty) payload.components = getBuilderMessageComponents(state);\n    if (state.mediaBuffer && state.mediaName) payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];",
  },
  {
    label: 'component save state',
    find: "    if (!edited) return { ok: false, reason: 'edit-failed' };\n\n    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);",
    replace: "    if (!edited) return { ok: false, reason: 'edit-failed' };\n    if (state.componentsDirty) {\n        state.componentRows = getBuilderMessageComponents(state);\n        state.componentRowsSourceMessageId = String(edited.id);\n        state.componentsDirty = false;\n    }\n\n    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);",
  },
], "state.componentsDirty) payload.components");

console.log('[EMBED_BUILDER_BUTTONS] complete');
