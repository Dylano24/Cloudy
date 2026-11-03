// Owner-only, ephemeral giveaway picker. All pages are loaded from current
// guild giveaway records, so pagination never relies on a stale in-memory list.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder,
} from 'discord.js';
import { getGuildGiveaways } from '../utils/giveaways.js';
import { CLOUDY_C_LOGO_URL, giveawayEndTime, isGiveawayFinished } from './giveawayService.js';
import { canManageGiveawaysAsOwner, loadGiveaway } from './giveawayActions.js';
import { createGiveawayManagePanel, participantsEmoji } from './giveawayService.js';
import { giveawayWarning } from '../handlers/giveawayButtons.js';

export const GIVEAWAY_MANAGE_PAGE_SIZE = 25;
const canUse = interaction => interaction.inGuild?.()
  && canManageGiveawaysAsOwner(interaction.member, interaction.guild);

export async function listManageableGiveaways(client, guildId) {
  const records = await getGuildGiveaways(client, guildId, { strict: true });
  return records.filter(item => /^\d{17,20}$/.test(String(item?.messageId || '')))
    .sort((a, b) => {
      const status = Number(isGiveawayFinished(a)) - Number(isGiveawayFinished(b));
      return status || (Number(b.createdAt ? Date.parse(b.createdAt) : giveawayEndTime(b)) || 0)
        - (Number(a.createdAt ? Date.parse(a.createdAt) : giveawayEndTime(a)) || 0);
    });
}

export function buildGiveawayManagePicker(giveaways, guild, requesterId, requestedPage = 0) {
  const pageCount = Math.max(1, Math.ceil(giveaways.length / GIVEAWAY_MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  const available = giveaways.slice(page * GIVEAWAY_MANAGE_PAGE_SIZE, (page + 1) * GIVEAWAY_MANAGE_PAGE_SIZE);
  const embed = {
    title: 'Manage giveaway',
    description: giveaways.length
      ? `Select the giveaway you want to manage.\n\n${giveaways.length} giveaways · Page ${page + 1}/${pageCount}`
      : 'There are no giveaways to manage in this server.',
    color: 0xFFFFFF,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
  };
  if (!available.length) return { embeds: [embed], components: [] };
  const picker = new StringSelectMenuBuilder()
    .setCustomId(`gmanage_select:${requesterId}`)
    .setPlaceholder('Choose a giveaway')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(available.map(giveaway => {
      const ended = isGiveawayFinished(giveaway);
      const channel = guild?.channels?.cache?.get?.(giveaway.channelId);
      const channelLabel = channel?.name ? '#' + channel.name : 'Channel ' + (giveaway.channelId || 'unknown');
      const endsAt = giveawayEndTime(giveaway);
      return {
        label: String(giveaway.prize || 'Giveaway').slice(0, 100),
        description: `${ended ? 'Ended' : 'Active'} · ${channelLabel} · ${endsAt ? new Date(endsAt).toLocaleDateString('en-GB') : 'No end date'}`.slice(0, 100),
        value: String(giveaway.messageId),
      };
    }));
  const components = [new ActionRowBuilder().addComponents(picker)];
  if (pageCount > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gmanage_page:${requesterId}:${page - 1}`)
        .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`gmanage_page:${requesterId}:${page + 1}`)
        .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1),
    ));
  }
  return { embeds: [embed], components };
}

async function reject(interaction) {
  const payload = { embeds: [giveawayWarning('Only the Owner role can manage giveaways.')], components: [] };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

export async function showGiveawayManagePicker(interaction, client, page = 0, requesterId = interaction.user.id) {
  if (!canUse(interaction) || interaction.user.id !== requesterId) return reject(interaction);
  const fromComponent = interaction.isButton?.() || interaction.isStringSelectMenu?.();
  if (fromComponent) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const giveaways = await listManageableGiveaways(client, interaction.guildId);
    return interaction.editReply(buildGiveawayManagePicker(giveaways, interaction.guild, requesterId, page));
  } catch {
    return interaction.editReply({
      embeds: [giveawayWarning('Giveaways could not be loaded. Please try again.')],
      components: [],
    });
  }
}

export async function selectGiveawayToManage(interaction, client, requesterId) {
  if (!canUse(interaction) || interaction.user.id !== requesterId) return reject(interaction);
  await interaction.deferUpdate();
  try {
    const messageId = String(interaction.values?.[0] || '');
    if (!/^\d{17,20}$/.test(messageId)) {
      return interaction.editReply({ embeds: [giveawayWarning('Select a valid giveaway.')], components: [] });
    }
    const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
    if (!giveaway) {
      const giveaways = await listManageableGiveaways(client, interaction.guildId);
      return interaction.editReply(buildGiveawayManagePicker(giveaways, interaction.guild, requesterId));
    }
    return interaction.editReply(createGiveawayManagePanel(giveaway, { participantsIcon: participantsEmoji(client) }));
  } catch {
    return interaction.editReply({
      embeds: [giveawayWarning('The giveaway could not be opened. Please try again.')],
      components: [],
    });
  }
}
