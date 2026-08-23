import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  buildTicketDashboardValuePrompt,
  deleteTicketSystem,
  getCurrentTicketDashboardConfig,
  refreshTicketDashboardCache,
  repostTicketPanel,
  saveTicketDashboardSetting,
  validateTicketDashboardValue,
} from '../../../services/ticketDashboardService.js';
import { updateGuildConfig } from '../../../services/config/guildConfig.js';
import {
  brandTicketDashboardPayload,
  buildTicketDashboardPayload,
} from '../../../services/ticketDashboardViewService.js';
import {
  buildAllChannelTicketPrompt,
  isAllChannelTicketSetting,
  refreshAllTicketChannels,
} from '../../../services/ticketChannelBrowserService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const CLEARABLE_FIELDS = new Set([
  'ticketCategoryId',
  'ticketClosedCategoryId',
  'ticketStaffRoleId',
  'ticketLogsChannelId',
  'ticketTranscriptChannelId',
]);

const OPENABLE_SETTINGS = new Set([
  'panel_channel',
  'open_category',
  'closed_category',
  'staff_role',
  'max_tickets',
  'logs_channel',
  'transcript_channel',
]);

const TEXT_SETTINGS = new Set(['panel_message', 'button_label']);
const CONFIG_READ_TIMEOUT_MS = 1500;

function canManageTickets(interaction) {
  return Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
}

async function rejectUnauthorized(interaction) {
  const payload = {
    content: 'You need the `Manage Channels` permission to change ticket-system settings.',
    embeds: [],
    components: [],
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.deferred || interaction.replied) {
    await InteractionHelper.safeEditReply(interaction, payload);
  } else {
    await InteractionHelper.safeReply(interaction, payload);
  }
}

async function validateDashboardInteraction(interaction, guildId) {
  if (!interaction.inGuild() || guildId !== interaction.guildId) {
    await InteractionHelper.safeReply(interaction, {
      content: 'This ticket dashboard is outdated. Run `/ticket dashboard` again.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (!canManageTickets(interaction)) {
    await rejectUnauthorized(interaction);
    return false;
  }
  return true;
}

async function readConfigFast(client, guildId) {
  let timer;
  try {
    return await Promise.race([
      getCurrentTicketDashboardConfig(client, guildId).catch(() => ({})),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({}), CONFIG_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dashboardFieldValue(interaction, fieldName) {
  const field = interaction.message?.embeds?.[0]?.fields?.find(item => item.name === fieldName);
  if (!field?.value) return '';
  const value = String(field.value);
  if (value === '`Not set`') return '';
  if (value.startsWith('`') && value.endsWith('`')) return value.slice(1, -1);
  return '';
}

function buildTextSettingModal(interaction, guildId, setting) {
  const isPanelMessage = setting === 'panel_message';
  const field = isPanelMessage ? 'ticketPanelMessage' : 'ticketButtonLabel';
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(isPanelMessage ? 'Panel message' : 'Button label')
    .setStyle(isPanelMessage ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(isPanelMessage ? 2000 : 80);

  if (isPanelMessage) {
    input.setPlaceholder('Enter the exact support panel message...');
  } else {
    const current = dashboardFieldValue(interaction, 'Button Label');
    if (current) input.setValue(current.slice(0, 80));
    input.setPlaceholder('Start Chat');
  }

  return new ModalBuilder()
    .setCustomId(`ticket_dashboard_modal:${guildId}:${field}:${interaction.message.id}`)
    .setTitle(isPanelMessage ? 'Edit Panel Message' : 'Edit Button Label')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function renderSetting(interaction, client, guildId, setting) {
  if (!OPENABLE_SETTINGS.has(setting)) {
    throw new Error(`Unknown ticket dashboard setting: ${setting}`);
  }

  const config = await readConfigFast(client, guildId);
  const prompt = isAllChannelTicketSetting(setting)
    ? buildAllChannelTicketPrompt(interaction.guild, setting, config, 0)
    : buildTicketDashboardValuePrompt(interaction.guild, setting, config, 0);
  const payload = brandTicketDashboardPayload(
    prompt || buildTicketDashboardPayload(interaction.guild, config),
  );

  // Use one component callback instead of deferUpdate + editReply. This avoids
  // Discord mobile getting stuck on "Cloudy Manager is thinking...".
  if (!interaction.deferred && !interaction.replied) {
    await interaction.update(payload);
  } else {
    await interaction.editReply(payload);
  }

  if (isAllChannelTicketSetting(setting)) {
    void refreshAllTicketChannels(interaction.guild).catch(() => {});
  } else if (setting === 'open_category' || setting === 'closed_category' || setting === 'staff_role') {
    void refreshTicketDashboardCache(interaction.guild).catch(() => {});
  }
}

const openSettingHandler = {
  name: 'ticket_dashboard_open',
  async execute(interaction, client, args = []) {
    const [guildId, setting] = args;
    if (!(await validateDashboardInteraction(interaction, guildId))) return;

    try {
      await renderSetting(interaction, client, guildId, setting);
    } catch (error) {
      logger.error('Ticket dashboard setting button failed', {
        guildId,
        setting,
        error: error.message,
      });
      const config = await readConfigFast(client, guildId);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not open that ticket setting. Please try again.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await InteractionHelper.safeReply(interaction, { content: payload.content, flags: MessageFlags.Ephemeral });
    }
  },
};

const textSettingHandler = {
  name: 'ticket_dashboard_text',
  async execute(interaction, _client, args = []) {
    const [guildId, setting] = args;
    if (!(await validateDashboardInteraction(interaction, guildId))) return;

    if (!TEXT_SETTINGS.has(setting)) {
      await InteractionHelper.safeReply(interaction, {
        content: 'That ticket text setting is not available.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (interaction.deferred || interaction.replied) {
        throw new Error('Ticket dashboard text interaction was acknowledged before the modal could open.');
      }
      await interaction.showModal(buildTextSettingModal(interaction, guildId, setting));
    } catch (error) {
      logger.error('Ticket dashboard text modal failed', {
        guildId,
        setting,
        error: error.message,
      });
      if (!interaction.replied && !interaction.deferred) {
        await InteractionHelper.safeReply(interaction, {
          content: 'Could not open that ticket setting. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

const backHandler = {
  name: 'ticket_dashboard_back',
  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;
    const config = await readConfigFast(client, guildId);
    const payload = buildTicketDashboardPayload(interaction.guild, config);
    if (!interaction.deferred && !interaction.replied) await interaction.update(payload);
    else await interaction.editReply(payload);
  },
};

const clearHandler = {
  name: 'ticket_dashboard_clear',
  async execute(interaction, client, args = []) {
    const [guildId, field] = args;
    if (!(await validateDashboardInteraction(interaction, guildId))) return;
    try {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      if (!CLEARABLE_FIELDS.has(field)) throw new Error(`Ticket dashboard field cannot be cleared: ${field}`);
      await validateTicketDashboardValue(client, interaction.guild, field, null);
      const config = await saveTicketDashboardSetting(client, interaction.guild, field, null);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = '✅ Ticket setting cleared.';
      await interaction.editReply(payload);
    } catch (error) {
      logger.error('Ticket dashboard clear failed', { guildId, field, error: error.message });
      const config = await readConfigFast(client, guildId);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not clear that ticket setting.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await InteractionHelper.safeReply(interaction, { content: payload.content, flags: MessageFlags.Ephemeral });
    }
  },
};

const staffHandler = {
  name: 'ticket_dashboard_staff',
  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;
    try {
      await renderSetting(interaction, client, guildId, 'staff_role');
    } catch (error) {
      logger.error('Ticket dashboard legacy staff button failed', { guildId, error: error.message });
      const config = await readConfigFast(client, guildId);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not open the staff role setting.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await InteractionHelper.safeReply(interaction, { content: payload.content, flags: MessageFlags.Ephemeral });
    }
  },
};

const maxTicketsHandler = {
  name: 'ticket_dashboard_max',
  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;
    try {
      await renderSetting(interaction, client, guildId, 'max_tickets');
    } catch (error) {
      logger.error('Ticket dashboard legacy max button failed', { guildId, error: error.message });
    }
  },
};

const repostHandler = {
  name: 'ticket_dashboard_repost',
  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;
    try {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      const { config: repostedConfig } = await repostTicketPanel(client, interaction.guild);
      const config = repostedConfig.ticketSystemDisabled === true
        ? await updateGuildConfig(client, guildId, { ticketSystemDisabled: false })
        : repostedConfig;
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = '✅ The ticket panel was reposted and the new message ID was saved.';
      await interaction.editReply(payload);
    } catch (error) {
      logger.error('Ticket dashboard repost failed', { guildId, error: error.message });
      const config = await readConfigFast(client, guildId);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not repost the ticket panel.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await InteractionHelper.safeReply(interaction, { content: payload.content, flags: MessageFlags.Ephemeral });
    }
  },
};

const deleteHandler = {
  name: 'ticket_dashboard_delete',
  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;
    let disabledSaved = false;
    try {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

      // Disable creation first so stale panel interactions cannot create a
      // ticket during the short window while the Discord panel is being removed.
      await updateGuildConfig(client, guildId, { ticketSystemDisabled: true });
      disabledSaved = true;

      await deleteTicketSystem(client, interaction.guild);
      await interaction.editReply({
        content: '✅ The live ticket panel has been removed. All saved ticket settings are preserved. Open `/ticket dashboard` and use `Repost Panel` to restore it with the same settings.',
        embeds: [],
        components: [],
      });
    } catch (error) {
      if (disabledSaved) {
        await updateGuildConfig(client, guildId, { ticketSystemDisabled: false }).catch(() => {});
      }
      logger.error('Ticket dashboard delete failed', { guildId, error: error.message });
      const config = await readConfigFast(client, guildId);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not delete the ticket system.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await InteractionHelper.safeReply(interaction, { content: payload.content, flags: MessageFlags.Ephemeral });
    }
  },
};

export default [
  openSettingHandler,
  textSettingHandler,
  backHandler,
  clearHandler,
  staffHandler,
  maxTicketsHandler,
  repostHandler,
  deleteHandler,
];