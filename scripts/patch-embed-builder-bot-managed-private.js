import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'EMBED_BUILDER_BOT_MANAGED_PRIVATE_V1';

let source = fs.readFileSync(path, 'utf8');

if (!source.includes(marker)) {
  const importMarker = `import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';`;
  const importReplacement = `${importMarker}\nimport { touchBuilderSessionMessage } from '../../utils/builderSessionCleanup.js';`;
  if (!source.includes(importMarker)) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] import marker not found');
    process.exit(1);
  }
  source = source.replace(importMarker, importReplacement);

  const deferBefore = `            const deferred = await InteractionHelper.safeDefer(interaction, {\n                flags: MessageFlags.Ephemeral,\n            });\n            if (!deferred) return;\n\n            const state = {`;
  const deferAfter = `            // ${marker}: in a private/admin channel the Builder is a normal\n            // bot-managed temporary message, so Discord mobile cannot lose it\n            // merely because the user switches to Safari/the editor. Public\n            // channels keep the existing ephemeral behavior to avoid exposing\n            // an admin's draft content.\n            const builderBotManaged = Boolean(\n                interaction.guild\n                && interaction.channel\n                && !isPublicToEveryone(interaction.guild, interaction.channel)\n            );\n            const deferred = await InteractionHelper.safeDefer(\n                interaction,\n                builderBotManaged ? {} : { flags: MessageFlags.Ephemeral },\n            );\n            if (!deferred) return;\n\n            const state = {\n                builderBotManaged,`;
  if (!source.includes(deferBefore)) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] defer marker not found');
    process.exit(1);
  }
  source = source.replace(deferBefore, deferAfter);

  const editStart = source.indexOf('export async function editBuilderPreviewMessage(state, interaction, payload) {');
  const editEndMarker = '\n\nasync function refreshBuilder(interaction, state) {';
  const editEnd = source.indexOf(editEndMarker, editStart);
  if (editStart === -1 || editEnd === -1) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] single preview delivery function not found');
    process.exit(1);
  }

  const editReplacement = `export async function editBuilderPreviewMessage(state, interaction, payload) {\n    if (state.builderPreviewUnavailable) return false;\n\n    // ${marker}: bot-managed Builders are edited through the Message object,\n    // not the short-lived interaction webhook. Touching the message here also\n    // lets the existing AsyncLocalStorage editor hold own the same Builder.\n    if (state.builderBotManaged && state.builderMessage?.edit) {\n        try {\n            touchBuilderSessionMessage(state.builderMessage);\n            await state.builderMessage.edit(payload);\n            return true;\n        } catch (error) {\n            if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {\n                return markBuilderPreviewUnavailable(state);\n            }\n            throw error;\n        }\n    }\n\n    // Public channels deliberately keep the current ephemeral single-target\n    // path so private draft content is never exposed by this durability fix.\n    if (state.builderMessageId && state.builderWebhook?.editMessage) {\n        try {\n            await state.builderWebhook.editMessage(state.builderMessageId, payload);\n            return true;\n        } catch (error) {\n            if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {\n                return markBuilderPreviewUnavailable(state);\n            }\n            throw error;\n        }\n    }\n\n    if (typeof interaction?.editReply !== 'function') return false;\n    try {\n        await interaction.editReply(payload);\n        return true;\n    } catch (error) {\n        if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {\n            return markBuilderPreviewUnavailable(state);\n        }\n        throw error;\n    }\n}`;
  source = `${source.slice(0, editStart)}${editReplacement}${source.slice(editEnd)}`;

  const dashboardBefore = `            const dashboardMessage = await interaction.fetchReply();\n            state.builderMessageId = dashboardMessage.id;\n            state.builderWebhook = interaction.webhook;\n            state.builderPreviewUnavailable = false;`;
  const dashboardAfter = `            const dashboardMessage = await interaction.fetchReply();\n            state.builderMessage = dashboardMessage;\n            state.builderMessageId = dashboardMessage.id;\n            state.builderWebhook = interaction.webhook;\n            state.builderPreviewUnavailable = false;`;
  if (!source.includes(dashboardBefore)) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] dashboard target marker not found');
    process.exit(1);
  }
  source = source.replace(dashboardBefore, dashboardAfter);

  fs.writeFileSync(path, source, 'utf8');
}

console.log('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] private-channel Builder uses bot-managed Message lifetime; public channels stay ephemeral');
