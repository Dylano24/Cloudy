import fs from 'node:fs';

const path = 'src/commands/Tools/embedbuilder.js';
const marker = 'EMBED_BUILDER_BOT_MANAGED_ALL_GUILD_V2';

let source = fs.readFileSync(path, 'utf8');

if (!source.includes(marker)) {
  const importMarker = `import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';`;
  const importReplacement = `${importMarker}\nimport { touchBuilderSessionMessage } from '../../utils/builderSessionCleanup.js';`;
  if (!source.includes(importMarker)) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] import marker not found');
    process.exit(1);
  }
  source = source.replace(importMarker, importReplacement);

  // UI_LATENCY runs earlier and deliberately replaces defer+edit with one
  // direct safeReply. Patch that final source shape rather than restoring a
  // second Discord round-trip.
  const stateBefore = `            // Do not spend a Discord round-trip on a defer before rendering a\n            // panel that can be built locally. The first panel is sent directly.\n\n            const state = {`;
  const stateAfter = `            // Do not spend a Discord round-trip on a defer before rendering a\n            // panel that can be built locally. The first panel is sent directly.\n\n            // ${marker}: every guild Builder is a normal bot-managed temporary\n            // message. Discord explicitly allows ephemeral responses to disappear\n            // client-side after a while, so public-channel Builders must not depend\n            // on an ephemeral interaction response for their lifetime. The existing\n            // collector still restricts controls to the invoking user and the same\n            // five-minute inactivity cleanup still owns deletion.\n            const builderBotManaged = Boolean(interaction.guild && interaction.channel);\n\n            const state = {\n                builderBotManaged,`;
  if (!source.includes(stateBefore)) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] final Builder startup marker not found');
    process.exit(1);
  }
  source = source.replace(stateBefore, stateAfter);

  const initialBefore = `            const initialShown = await InteractionHelper.safeReply(interaction, {\n                embeds: [buildPreviewEmbed(state), buildControlEmbed(state)],\n                components: buildControls(state),\n                flags: MessageFlags.Ephemeral,\n            });`;
  const initialAfter = `            const initialShown = await InteractionHelper.safeReply(interaction, {\n                embeds: [buildPreviewEmbed(state), buildControlEmbed(state)],\n                components: buildControls(state),\n                ...(builderBotManaged ? {} : { flags: MessageFlags.Ephemeral }),\n            });`;
  if (!source.includes(initialBefore)) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] final initial reply marker not found');
    process.exit(1);
  }
  source = source.replace(initialBefore, initialAfter);

  const editStart = source.indexOf('export async function editBuilderPreviewMessage(state, interaction, payload) {');
  const editEndMarker = '\n\nasync function refreshBuilder(interaction, state) {';
  const editEnd = source.indexOf(editEndMarker, editStart);
  if (editStart === -1 || editEnd === -1) {
    console.error('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] single preview delivery function not found');
    process.exit(1);
  }

  const editReplacement = `export async function editBuilderPreviewMessage(state, interaction, payload) {\n    if (state.builderPreviewUnavailable) return false;\n\n    // ${marker}: guild Builders are edited through the bot-managed Message object,\n    // not the short-lived interaction webhook. Touching the message here also\n    // lets the existing AsyncLocalStorage editor hold own the same Builder.\n    if (state.builderBotManaged && state.builderMessage?.edit) {\n        try {\n            touchBuilderSessionMessage(state.builderMessage);\n            await state.builderMessage.edit(payload);\n            return true;\n        } catch (error) {\n            if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {\n                return markBuilderPreviewUnavailable(state);\n            }\n            throw error;\n        }\n    }\n\n    // Non-guild contexts keep the interaction-response fallback.\n    if (state.builderMessageId && state.builderWebhook?.editMessage) {\n        try {\n            await state.builderWebhook.editMessage(state.builderMessageId, payload);\n            return true;\n        } catch (error) {\n            if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {\n                return markBuilderPreviewUnavailable(state);\n            }\n            throw error;\n        }\n    }\n\n    if (typeof interaction?.editReply !== 'function') return false;\n    try {\n        await interaction.editReply(payload);\n        return true;\n    } catch (error) {\n        if (BUILDER_PREVIEW_UNAVAILABLE_CODES.has(error?.code)) {\n            return markBuilderPreviewUnavailable(state);\n        }\n        throw error;\n    }\n}`;
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

console.log('[EMBED_BUILDER_BOT_MANAGED_PRIVATE] every guild Builder now uses bot-managed Message lifetime; 5m inactivity cleanup unchanged');
