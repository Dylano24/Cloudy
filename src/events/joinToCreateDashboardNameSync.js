import { Events } from 'discord.js';
import { getChannelConfiguration } from '../services/joinToCreateService.js';
import { logger } from '../utils/logger.js';

const NAME_MODAL_PREFIX = 'jtc_name_modal_';
const FIELD_NAME = 'Channel name template';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildUpdatedEmbed(message, newTemplate) {
  const existing = message?.embeds?.[0]?.toJSON?.();
  if (!existing) return null;

  const fields = Array.isArray(existing.fields)
    ? existing.fields.map(field => field.name === FIELD_NAME
      ? { ...field, value: `\`${newTemplate}\`` }
      : field)
    : [];

  if (!fields.some(field => field.name === FIELD_NAME)) return null;
  return { ...existing, fields };
}

export default {
  name: Events.InteractionCreate,

  async execute(interaction, client) {
    if (!interaction.isModalSubmit?.()) return;
    if (!String(interaction.customId || '').startsWith(NAME_MODAL_PREFIX)) return;
    if (!interaction.guildId || !interaction.message?.id) return;

    const triggerChannelId = String(interaction.customId).slice(NAME_MODAL_PREFIX.length);
    const newTemplate = String(interaction.fields.getTextInputValue('name_template') || '').trim();
    if (!triggerChannelId || !newTemplate) return;

    // The command handler owns the acknowledgement and database write. This listener
    // only mirrors the persisted value back into the exact ephemeral dashboard message.
    let persisted = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (attempt > 0) await sleep(50);
      const config = await getChannelConfiguration(client, interaction.guildId, triggerChannelId).catch(() => null);
      if (config?.channelConfig?.nameTemplate === newTemplate) {
        persisted = true;
        break;
      }
    }
    if (!persisted) return;

    const embed = buildUpdatedEmbed(interaction.message, newTemplate);
    if (!embed) return;
    const payload = { embeds: [embed] };

    let updated = false;
    if (interaction.webhook?.editMessage) {
      updated = await interaction.webhook.editMessage(interaction.message.id, payload)
        .then(() => true)
        .catch(() => false);
    }
    if (!updated && interaction.message?.edit) {
      updated = await interaction.message.edit(payload)
        .then(() => true)
        .catch(() => false);
    }
    if (!updated && (interaction.deferred || interaction.replied) && interaction.editReply) {
      updated = await interaction.editReply(payload)
        .then(() => true)
        .catch(() => false);
    }

    if (!updated) {
      logger.warn('Join to Create dashboard name was saved but the visible embed could not be refreshed.', {
        guildId: interaction.guildId,
        triggerChannelId,
      });
    }
  },
};
