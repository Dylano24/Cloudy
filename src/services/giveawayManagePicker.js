// Owner-only, ephemeral giveaway picker. All pages are loaded from current
// guild giveaway records, so pagination never relies on a stale in-memory list.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder,
} from 'discord.js';
import { getGuildGiveaways } from '../utils/giveaways.js';
import { CLOUDY_C_LOGO_URL, giveawayEndTime, isGiveawayFinished } from './giveawayService.js';
import { canManageGiveawaysAsOwner, loadGiveaway } from './giveawayActions.js';
import { createGiveawayManagePanel, participantsEmoji } from './giveawayService.js';
import { giveawayWarning, removeAfterTenSeconds } from '../handlers/giveawayButtons.js';
import { cleanupDeletedGiveaways } from './giveawayDeletedMessageSync.js';

export const GIVEAWAY_MANAGE_PAGE_SIZE = 25;
const canUse = interaction => interaction.inGuild?.()
  && canManageGiveawaysAsOwner(interaction.member, interaction.guild);

// Keep both active and ended giveaways manageable while their original
// public message still exists. Ending does not delete that Discord message.
export function isManageableGiveaway(giveaway) {
  return /^\d{17,20}$/.test(String(giveaway?.messageId || ''))
    && Boolean(giveaway?.channelId);
}

export function isActiveManageableGiveaway(giveaway, now = Date.now()) {
  return isManageableGiveaway(giveaway)
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
  const current = records.filter(isManageableGiveaway);
  const verified = [];
  // Bound concurrent Discord fetches; verify active AND ended posts before listing.
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
  // Active first; within each status newest giveaways first. Do not hide
  // ended giveaways, which can still be rerolled or deleted from Manage.
  return verified.sort((a, b) =>
    Number(isActiveManageableGiveaway(b)) - Number(isActiveManageableGiveaway(a))
    || (Number(Date.parse(b.createdAt) || giveawayEndTime(b)) || 0)
      - (Number(Date.parse(a.createdAt) || giveawayEndTime(a)) || 0));
}

export function buildGiveawayManagePicker(giveaways, guild, requesterId, requestedPage = 0) {
  const pageCount = Math.max(1, Math.ceil(giveaways.length / GIVEAWAY_MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  const available = giveaways.slice(page * GIVEAWAY_MANAGE_PAGE_SIZE, (page + 1) * GIVEAWAY_MANAGE_PAGE_SIZE);
  const embed = {
    title: 'Manage giveaway',
    description: giveaways.length
      ? `Select a giveaway to manage.\n\n${giveaways.length} giveaway${giveaways.length === 1 ? '' : 's'} · Page ${page + 1}/${pageCount}`
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
      const channel = guild?.channels?.cache?.get?.(giveaway.channelId);
      const channelLabel = channel?.name ? '#' + channel.name : 'Channel ' + (giveaway.channelId || 'unknown');
      const endsAt = giveawayEndTime(giveaway);
      return {
        label: String(giveaway.prize || 'Giveaway').slice(0, 100),
        description: `${isActiveManageableGiveaway(giveaway) ? 'Active' : 'Ended'} · ${channelLabel} · ${endsAt ? new Date(endsAt).toLocaleDateString('en-GB') : 'No end date'} · ID ${String(giveaway.messageId).slice(-6)}`.slice(0, 100),
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

// A short private state (empty list, warning, error) is not an interactive
// panel: it follows Cloudy's normal 10-second notice lifetime. Never auto-
// delete a picker or management panel while it contains usable controls.
async function editManageReply(interaction, payload) {
  const result = await interaction.editReply(payload);
  if (!payload.components?.length) removeAfterTenSeconds(interaction);
  return result;
}

async function reject(interaction) {
  const payload = { embeds: [giveawayWarning('Only the Owner role can manage giveaways.')], components: [] };
  const result = interaction.deferred || interaction.replied
    ? await interaction.editReply(payload)
    : await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  removeAfterTenSeconds(interaction);
  return result;
}

export async function showGiveawayManagePicker(interaction, client, page = 0, requesterId = interaction.user.id) {
  if (!canUse(interaction) || interaction.user.id !== requesterId) return reject(interaction);
  const fromComponent = interaction.isButton?.() || interaction.isStringSelectMenu?.();
  if (fromComponent) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const giveaways = await listManageableGiveaways(client, interaction.guildId);
    return editManageReply(interaction, buildGiveawayManagePicker(giveaways, interaction.guild, requesterId, page));
  } catch {
    return editManageReply(interaction, {
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
      return editManageReply(interaction, { embeds: [giveawayWarning('Select a valid giveaway.')], components: [] });
    }
    const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
    if (!isManageableGiveaway(giveaway)
      || !await originalGiveawayExists(client, interaction.guildId, giveaway)) {
      if (isManageableGiveaway(giveaway)) {
        await cleanupDeletedGiveaways(client, interaction.guildId, {
          entries: [{ messageId: giveaway.messageId, channelId: giveaway.channelId }],
        });
      }
      const giveaways = await listManageableGiveaways(client, interaction.guildId);
      return editManageReply(interaction, buildGiveawayManagePicker(giveaways, interaction.guild, requesterId));
    }
    return interaction.editReply(createGiveawayManagePanel(giveaway, { participantsIcon: participantsEmoji(client) }));
  } catch {
    return editManageReply(interaction, {
      embeds: [giveawayWarning('The giveaway could not be opened. Please try again.')],
      components: [],
    });
  }
}
