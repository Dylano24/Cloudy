// /creator-notify dashboard, built like the /auto feed dashboard: a private
// panel with Add / Manage, a channel step, a link form and a manage screen.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  addCreatorNotification, deleteCreatorNotification, listCreatorNotifications, updateCreatorNotification,
} from './creatorNotificationService.js';
import { creatorProviderReady } from './creatorNotificationProviders.js';
import { CLOUDY_LOGO_URL } from './cloudyLogoService.js';
import { CLOUDY_BRANDING } from './cloudyBrandingService.js';
import { errorEmbed } from '../utils/embeds.js';
import { CLOUDY_RED_COLOR } from '../utils/embedColorPolicy.js';
import { withCreatorErrorColor } from '../utils/cloudyFooter.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'creatornotify:';
const IDLE_MS = 5 * 60_000;
const MODAL_HOLD_MS = 15 * 60_000;
const PLATFORM_NAMES = { youtube: 'YouTube', twitch: 'Twitch', tiktok: 'TikTok' };
const sessions = new Map();

const makeId = () => randomUUID().slice(0, 12);
const platformName = platform => PLATFORM_NAMES[platform] || platform;
const canManage = interaction => Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));

function closeSession(session, removeMessage = true) {
  clearTimeout(session.timer);
  sessions.delete(session.id);
  if (removeMessage) void Promise.resolve().then(() => session.root.deleteReply()).catch(() => {});
}

function keepSessionAlive(session, modalOpen = false) {
  clearTimeout(session.timer);
  session.modalOpen = modalOpen;
  session.timer = setTimeout(() => closeSession(session), modalOpen ? MODAL_HOLD_MS : IDLE_MS);
  session.timer.unref?.();
}

function baseEmbed(description) {
  const embed = new EmbedBuilder().setColor(0xFFFFFF).setThumbnail(CLOUDY_LOGO_URL)
    .setFooter({ text: CLOUDY_BRANDING }).setTitle('Creator notifications');
  return description ? embed.setDescription(description) : embed;
}

// Readable name for a saved creator (YouTube stores the UC channel ID).
export function creatorName(creator) {
  if (creator.name) return String(creator.name);
  if (creator.platform !== 'youtube') return creator.account;
  const source = String(creator.source || '').trim();
  const match = /youtube\.com\/(@[^/?#\s]+|(?:user|c)\/[^/?#\s]+)/i.exec(source) || /^(@[^/?#\s]+)$/.exec(source);
  if (match) {
    const name = match[1].replace(/^(?:user|c)\//i, '');
    try { return decodeURIComponent(name); } catch { return name; }
  }
  return creator.account.slice(0, 6) + '…' + creator.account.slice(-4);
}

function profileUrl(creator) {
  if (creator.platform === 'youtube') return 'https://www.youtube.com/channel/' + creator.account;
  if (creator.platform === 'twitch') return 'https://www.twitch.tv/' + creator.account;
  return 'https://www.tiktok.com/@' + creator.account;
}

function statusText(creator) {
  if (!creator.enabled) return 'Paused';
  if (!creatorProviderReady(creator.platform)) {
    return creator.platform === 'tiktok'
      ? 'Needs a TikTok feed bridge (operator setup)'
      : 'Needs Twitch API credentials (operator setup)';
  }
  return creator.initialized ? 'Active' : 'Active, waiting for the first check';
}

function destinationText(creator) {
  return creator.channelId ? '<#' + creator.channelId + '>' : 'the #' + creator.platform + ' channel';
}

export function buildCreatorDashboard(session, creators) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':add')
      .setLabel('Add creator').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':manage')
      .setLabel('Manage creator').setStyle(ButtonStyle.Secondary).setDisabled(!creators.length),
  );
  return {
    embeds: [baseEmbed('Paste a YouTube, Twitch or TikTok profile link. Cloudy posts new videos and livestreams from that creator in your chosen channel.\n​')],
    components: [row],
    allowedMentions: { parse: [] },
  };
}

function platformMenu(session) {
  return new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'platform:' + session.id)
    .setPlaceholder('Platform (only for usernames)')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Object.entries(PLATFORM_NAMES).map(([value, label]) => ({
      label, value, default: session.platform === value,
    })));
}

export function creatorChannelChooser(session, editing = false) {
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(PREFIX + 'channel:' + session.id)
    .setPlaceholder('Select a channel')
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const rows = [];
  if (!editing) rows.push(new ActionRowBuilder().addComponents(platformMenu(session)));
  rows.push(new ActionRowBuilder().addComponents(picker));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id)
      .setLabel('Back').setStyle(ButtonStyle.Secondary),
  ));
  return {
    embeds: [baseEmbed(editing
      ? 'Select the channel where Cloudy should post this creator.'
      : 'Select the channel where Cloudy should post. Choose a platform only when you will enter a username instead of a profile link.')],
    components: rows,
    allowedMentions: { parse: [] },
  };
}

export function creatorChooser(session, creators) {
  const options = creators.slice(0, 25).map(creator => {
    const channel = creator.channelId ? session.guild?.channels?.cache?.get(creator.channelId) : null;
    const destination = creator.channelId ? '#' + (channel?.name || 'channel') : '#' + creator.platform;
    return {
      label: (platformName(creator.platform) + ' • ' + creatorName(creator)).slice(0, 100),
      description: (destination + ' • ' + (creator.enabled ? 'Active' : 'Paused')).slice(0, 100),
      value: creator.id,
    };
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'creator:' + session.id)
    .setPlaceholder('Select a creator')
    .addOptions(options);
  return {
    embeds: [baseEmbed('Select the creator you want to manage.')],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id).setLabel('Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

export function creatorDetail(session, creator) {
  const embed = baseEmbed('Manage your selected creator.').addFields({
    name: platformName(creator.platform) + ' • ' + creatorName(creator),
    value: '**Profile:** ' + profileUrl(creator)
      + '\n**Channel:** ' + destinationText(creator)
      + '\n**Status:** ' + statusText(creator)
      + '\n\nExisting posts are skipped; only new videos and livestreams are announced.',
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':channel')
      .setLabel('Change channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':pause')
      .setLabel(creator.enabled ? 'Pause creator' : 'Resume creator')
      .setStyle(creator.enabled ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':delete')
      .setLabel('Delete creator').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id)
      .setLabel('Back').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function addModal(session) {
  const field = new TextInputBuilder().setCustomId('link').setLabel('Creator link')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)
    .setPlaceholder('https://www.youtube.com/@');
  return new ModalBuilder().setCustomId(PREFIX + 'submit:' + session.id).setTitle('Add creator')
    .addComponents(new ActionRowBuilder().addComponents(field));
}

async function silentAck(interaction) {
  if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
    if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      await interaction.deleteReply().catch(() => {});
    } else {
      await interaction.deferUpdate().catch(() => {});
    }
  }
}

function removeLater(remove) {
  const timer = setTimeout(() => { void Promise.resolve().then(remove).catch(() => {}); }, 10_000);
  timer.unref?.();
}

function redEmbed(title, message) {
  const embed = errorEmbed(title, message, { showDetails: false });
  embed.data.color = CLOUDY_RED_COLOR;
  return embed;
}

// Errors are red and remove themselves after exactly 10 seconds.
async function errorNotice(interaction, error) {
  logger.warn('[CREATOR_NOTIFY] Dashboard operation failed: ' + (error?.message || error));
  const embed = redEmbed('Creator notification error', error?.message || 'Could not update creator notifications.');
  const notice = await withCreatorErrorColor(() => interaction.followUp({
    embeds: [embed], flags: MessageFlags.Ephemeral,
  })).catch(() => null);
  if (notice) removeLater(() => interaction.webhook.deleteMessage(notice.id));
}

export async function openCreatorDashboard(interaction, client) {
  if (!interaction.guildId || !canManage(interaction)) {
    const embed = redEmbed('Access denied', 'Manage Server permission is required.');
    await withCreatorErrorColor(() => interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })).catch(() => {});
    removeLater(() => interaction.deleteReply());
    return;
  }
  for (const session of sessions.values()) {
    if (session.guildId === interaction.guildId && session.userId === interaction.user.id) closeSession(session);
  }
  const session = {
    id: makeId(), guildId: interaction.guildId, userId: interaction.user.id, root: interaction,
    guild: interaction.guild || client.guilds.cache.get(interaction.guildId) || null,
    timer: null, action: null, creator: null, channelId: null, platform: null, modalOpen: false, view: 'dashboard',
  };
  sessions.set(session.id, session);
  try {
    const creators = await listCreatorNotifications(client, session.guildId);
    await interaction.reply({ ...buildCreatorDashboard(session, creators), flags: MessageFlags.Ephemeral });
    keepSessionAlive(session);
  } catch (error) {
    closeSession(session, false);
    throw error;
  }
}

async function showAddForm(interaction, session) {
  session.view = 'modal';
  await interaction.showModal(addModal(session));
  keepSessionAlive(session, true);
}

async function currentCreator(client, session) {
  const creators = await listCreatorNotifications(client, session.guildId);
  return { creators, creator: session.creator ? creators.find(item => item.id === session.creator.id) || null : null };
}

async function showDashboard(interaction, client, session, method = 'update') {
  const creators = await listCreatorNotifications(client, session.guildId);
  Object.assign(session, { view: 'dashboard', action: null, creator: null, channelId: null, platform: null });
  await interaction[method](buildCreatorDashboard(session, creators));
}

async function saveChannel(interaction, client, session, channelId) {
  await interaction.deferUpdate();
  const updated = await updateCreatorNotification(client, session.guildId, session.creator.id, { channelId });
  if (!updated) throw new Error('This creator is no longer configured.');
  Object.assign(session, { creator: updated, action: null, view: 'detail' });
  await interaction.editReply(creatorDetail(session, updated));
}

export async function handleCreatorControls(interaction, client) {
  if (!interaction.customId?.startsWith(PREFIX)) return false;
  const [type, id, value] = interaction.customId.slice(PREFIX.length).split(':');
  const session = sessions.get(id);
  if (!session || session.userId !== interaction.user.id || !canManage(interaction)) {
    await silentAck(interaction);
    return true;
  }
  keepSessionAlive(session);

  try {
    if (type === 'back' && interaction.isButton()) {
      const creators = await listCreatorNotifications(client, session.guildId);
      if (session.view === 'channel' && session.creator) {
        Object.assign(session, { action: null, view: 'detail' });
        await interaction.update(creatorDetail(session, session.creator));
      } else if (session.view === 'detail' && creators.length) {
        Object.assign(session, { view: 'picker', creator: null, action: null });
        await interaction.update(creatorChooser(session, creators));
      } else {
        await showDashboard(interaction, client, session);
      }
      return true;
    }

    if (type === 'button' && interaction.isButton()) {
      if (value === 'add') {
        Object.assign(session, { action: 'add', creator: null, channelId: null, platform: null, view: 'channel' });
        await interaction.update(creatorChannelChooser(session));
        return true;
      }
      if (value === 'manage') {
        const creators = await listCreatorNotifications(client, session.guildId);
        if (!creators.length) return await showDashboard(interaction, client, session).then(() => true);
        session.view = 'picker';
        await interaction.update(creatorChooser(session, creators));
        return true;
      }
      if (!session.creator || session.view !== 'detail' || !['channel', 'pause', 'delete'].includes(value)) {
        await silentAck(interaction);
        return true;
      }
      if (value === 'channel') {
        Object.assign(session, { action: 'channel', view: 'channel' });
        await interaction.update(creatorChannelChooser(session, true));
        return true;
      }
      await interaction.deferUpdate();
      if (value === 'delete') {
        await deleteCreatorNotification(client, session.guildId, session.creator.id);
        await showDashboard(interaction, client, session, 'editReply');
        return true;
      }
      const { creator } = await currentCreator(client, session);
      if (!creator) throw new Error('This creator is no longer configured.');
      const updated = await updateCreatorNotification(client, session.guildId, creator.id, { enabled: !creator.enabled });
      if (!updated) throw new Error('This creator is no longer configured.');
      Object.assign(session, { creator: updated, view: 'detail' });
      await interaction.editReply(creatorDetail(session, updated));
      return true;
    }

    if (type === 'creator' && interaction.isStringSelectMenu()) {
      const creators = await listCreatorNotifications(client, session.guildId);
      const creator = creators.find(item => item.id === interaction.values[0]) || null;
      if (!creator) {
        if (!creators.length) return await showDashboard(interaction, client, session).then(() => true);
        session.view = 'picker';
        await interaction.update(creatorChooser(session, creators));
        return true;
      }
      Object.assign(session, { creator, view: 'detail', action: null });
      await interaction.update(creatorDetail(session, creator));
      return true;
    }

    if (type === 'platform' && interaction.isStringSelectMenu() && session.action === 'add') {
      session.platform = interaction.values[0];
      await interaction.update(creatorChannelChooser(session));
      return true;
    }

    if (type === 'channel' && interaction.isChannelSelectMenu()) {
      if (session.action === 'add') {
        session.channelId = interaction.values[0];
        await showAddForm(interaction, session);
        return true;
      }
      if (session.action === 'channel' && session.creator) {
        await saveChannel(interaction, client, session, interaction.values[0]);
        return true;
      }
      await silentAck(interaction);
      return true;
    }

    if (type === 'submit' && interaction.isModalSubmit() && session.action === 'add') {
      // Resolving a profile link can take a few seconds: acknowledge first.
      await interaction.deferUpdate();
      session.modalOpen = false;
      keepSessionAlive(session);
      const link = interaction.fields.getTextInputValue('link').trim();
      const creator = await addCreatorNotification(client, session.guildId, session.platform, link, session.channelId);
      Object.assign(session, { action: null, creator, channelId: null, platform: null, view: 'detail' });
      await interaction.editReply(creatorDetail(session, creator));
      return true;
    }

    await silentAck(interaction);
  } catch (error) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    await errorNotice(interaction, error);
    keepSessionAlive(session);
  }
  return true;
}
