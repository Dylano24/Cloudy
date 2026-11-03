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
import { cleanupDeletedGiveaways } from './giveawayDeletedMessageSync.js';

export const GIVEAWAY_MANAGE_PAGE_SIZE = 25;
const canUse = interaction => interaction.inGuild?.()
  && canManageGiveawaysAsOwner(interaction.member, interaction.guild);

// A giveaway belongs in Manage only while it is active and has not expired.
// Ended records are kept in storage for winner claims/rerolls but never appear.
export function isActiveManageableGiveaway(giveaway, now = Date.now()) {
  return /^\d{17,20}$/.test(String(giveaway?.messageId || ''))
    && Boolean(giveaway?.channelId)
    && !isGiveawayFinished(giveaway)
    && giveawayEndTime(giveaway) > now;
}

function isMissingOnDiscord(error) {
  return error?.code === 10008 || error?.code === 10003;
}

// Fetch the original giveaway post. Deletion events normally update the DB
// instantly; this also catches posts deleted while Cloudy was offline.
async function originalGiveawayExists(client, guildId, giveaway) {
  const guild = client.guilds?.cache?.get?.(guildId);
  if (!guild) throw new Error('Giveaway server is unavailable');
  let channel = guild.channels?.cache?.get?.(giveaway.channelId);
  if (!channel) {
    if (!guild.channels?.fetch) throw new Error('Cannot verify giveaway channel');
    try { channel = await guild.channels.fetch(giveaway.channelId); }
    catch (error) {
      if (isMissingOnDiscord(error)) return false;
      throw error;
    }
  }
  if (!channel) return false;
  if (!channel.messages?.fetch) throw new Error('Cannot verify giveaway message');
  try {
    const message = await channel.messages.fetch(giveaway.messageId);
    return Boolean(message && (!client.user?.id || !message.author?.id
      || message.author.id === client.user.id));
  } catch (error) {
    if (isMissingOnDiscord(error)) return false;
    throw error;
  }
}

export async function listManageableGiveaways(client, guildId) {
  const records = await getGuildGiveaways(client, guildId, { strict: true });
  const current = records.filter(item => isActiveManageableGiveaway(item));
  const verified = [];
  // Bound concurrent Discord fetches; never scan the many old/ended giveaways.
  let cursor = 0;
  async function worker() {
    while (cursor < current.length) {
      const giveaway = current[cursor++];
      const exists = await originalGiveawayExists(client, guildId, giveaway);
      if (exists) verified.push(giveaway);
      else await cleanupDeletedGiveaways(client, guildId, {
        entries: [{ messageId: giveaway.messageId, channelId: giveaway.channelId }],
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, current.length) }, () => worker()));
  return verified.sort((a, b) =>
    (Number(Date.parse(b.createdAt) || giveawayEndTime(b)) || 0)
      - (Number(Date.parse(a.createdAt) || giveawayEndTime(a)) || 0));
}

export function buildGiveawayManagePicker(giveaways, guild, requesterId, requestedPage = 0) {
  const pageCount = Math.max(1, Math.ceil(giveaways.length / GIVEAWAY_MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  const available = giveaways.slice(page * GIVEAWAY_MANAGE_PAGE_SIZE, (page + 1) * GIVEAWAY_MANAGE_PAGE_SIZE);
  const embed = {
    title: 'Manage giveaway',
    description: giveaways.length
      ? `Select an active giveaway to manage.\n\n${giveaways.length} active giveaway${giveaways.length === 1 ? '' : 's'} · Page ${page + 1}/${pageCount}`
      : 'There are no active giveaways to manage in this server.',
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
      const channel = guild?.channels?.cache?.get?.(giveaway.channelId);
      const channelLabel = channel?.name ? '#' + channel.name : 'Channel ' + (giveaway.channelId || 'unknown');
      const endsAt = giveawayEndTime(giveaway);
      return {
        label: String(giveaway.prize || 'Giveaway').slice(0, 100),
        description: `Active · ${channelLabel} · ${endsAt ? new Date(endsAt).toLocaleDateString('en-GB') : 'No end date'} · ID ${String(giveaway.messageId).slice(-6)}`.slice(0, 100),
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
    if (!isActiveManageableGiveaway(giveaway)
      || !await originalGiveawayExists(client, interaction.guildId, giveaway)) {
      if (giveaway && isActiveManageableGiveaway(giveaway)) {
        await cleanupDeletedGiveaways(client, interaction.guildId, {
          entries: [{ messageId: giveaway.messageId, channelId: giveaway.channelId }],
        });
      }
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
