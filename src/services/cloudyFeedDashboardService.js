import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { readFeeds, applyAction } from './cloudyFeedService.js';
import { formatStartTime } from './cloudyFeedStartTime.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_LOGO_URL } from './cloudyLogoService.js';
import { CLOUDY_BRANDING } from './cloudyBrandingService.js';

const PREFIX = 'cloudyfeed:';
const IDLE_MS = 5 * 60_000;
const MODAL_HOLD_MS = 15 * 60_000;
const sessions = new Map();

function makeId() {
  return randomUUID().slice(0, 12);
}

function closeSession(session, removeMessage = true) {
  clearTimeout(session.timer);
  sessions.delete(session.id);
  if (removeMessage) {
    void session.root.deleteReply().catch(() => {});
  }
}

function keepSessionAlive(session, modalOpen = false) {
  clearTimeout(session.timer);
  session.modalOpen = modalOpen;
  session.timer = setTimeout(() => closeSession(session), modalOpen ? MODAL_HOLD_MS : IDLE_MS);
  session.timer.unref?.();
}

export function formatAutoMessage(minutes) {
  const value = Number(minutes);
  if (!Number.isSafeInteger(value) || value < 1) return 'Unknown';
  if (value % 60 === 0) return `${value / 60}h`;
  return `${value}m`;
}

export function readableFeedName(feed) {
  if (feed.name) return String(feed.name).slice(0, 64);
  try {
    const hostname = new URL(feed.source).hostname.replace(/^(?:www|nl)\./i, '');
    const base = hostname.split('.')[0] || 'Website';
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch { return 'Website'; }
}

function feedStatusLine(feed) {
  if (feed.lastError) {
    const detail = String(feed.lastError).replace(/No USA-tagged (?:media|photos or videos) found/gi, 'No matching media found');
    return '**Source check:** ' + detail.slice(0, 180);
  }
  return '**Source check:** ' + (feed.lastUsCheck ? 'Media available' : 'Not checked');
}

export function feedEmbedBase() {
  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setThumbnail(CLOUDY_LOGO_URL)
    .setFooter({ text: CLOUDY_BRANDING });
}

export function buildCloudyFeedDashboard(guildId, feeds) {
  const embed = feedEmbedBase()
    .setTitle('Cloudy feed')
    .setDescription('Configure automatic posts from websites. Cloudy will randomly select new content and post it to your chosen channel.\n\u200B');


  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'add:' + guildId).setLabel('Add feed').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'manage:' + guildId).setLabel('Manage feed').setStyle(ButtonStyle.Secondary)
      .setDisabled(!feeds.length),
  );

  // Replace stable placeholder IDs with this user's per-dashboard session IDs.
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function dashboardForSession(session, feeds) {
  const payload = buildCloudyFeedDashboard(session.guildId, feeds);
  const buttons = payload.components[0].components;
  ['add', 'manage'].forEach((action, index) => {
    buttons[index].setCustomId(PREFIX + 'button:' + session.id + ':' + action);
  });
  return payload;
}

function choiceEmbed(description) {
  return [feedEmbedBase().setTitle('Cloudy feed').setDescription(description)];
}

function selectedMediaLabel(mediaType) {
  if (mediaType === 'video') return 'Videos only';
  if (mediaType === 'picture') return 'Pictures only';
  return null;
}

export function feedDetail(session, feed) {
  const embed = feedEmbedBase()
    .setTitle('Cloudy feed')
    .setDescription('Manage your selected feed.')
    .addFields({
      name: readableFeedName(feed),
      value: '**Source:** ' + feed.source.slice(0, 250)
        + '\n**Channel:** <#' + feed.channelId + '>'
        + '\n**Auto message:** ' + formatAutoMessage(feed.minutes)
        + (feed.startAt > Date.now() ? '\n**Starts:** <t:' + Math.floor(feed.startAt / 1000) + ':f>' : '')
        + (selectedMediaLabel(feed.mediaType) ? '\n**Media type:** ' + selectedMediaLabel(feed.mediaType) : '')
        + '\n**Status:** ' + (feed.active ? 'Active' : 'Paused')
        + '\n' + feedStatusLine(feed),
    });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':edit')
      .setLabel('Edit feed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':pause')
      .setLabel(feed.active ? 'Pause feed' : 'Resume feed')
      .setStyle(feed.active ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'button:' + session.id + ':delete')
      .setLabel('Delete feed').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id)
      .setLabel('Back').setStyle(ButtonStyle.Secondary),
  );
  // Media type is chosen outside the Edit feed form (it holds five fields).
  return {
    embeds: [embed],
    components: [row, new ActionRowBuilder().addComponents(mediaTypeMenu(session, feed.mediaType))],
    allowedMentions: { parse: [] },
  };
}

function mediaTypeMenu(session, value) {
  return new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'media:' + session.id)
    .setPlaceholder('Choose media type')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: 'Videos only', value: 'video', default: value === 'video' },
      { label: 'Pictures only', value: 'picture', default: value === 'picture' },
    );
}

export function channelChooser(session, edit = false) {
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(PREFIX + 'channel:' + session.id)
    .setPlaceholder('Select a channel')
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (!edit && session.channelId) picker.setDefaultChannels(session.channelId);
  const buttons = [];
  if (edit) {
    buttons.push(new ButtonBuilder().setCustomId(PREFIX + 'keep:' + session.id)
      .setLabel('Keep current channel').setStyle(ButtonStyle.Secondary));
  }
  buttons.push(new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id)
    .setLabel('Back').setStyle(ButtonStyle.Secondary));
  const components = [
    ...(edit ? [] : [new ActionRowBuilder().addComponents(mediaTypeMenu(session, session.mediaType))]),
    new ActionRowBuilder().addComponents(picker),
    new ActionRowBuilder().addComponents(buttons),
  ];
  return {
    embeds: choiceEmbed(edit
      ? 'Select the channel where Cloudy should post.'
      : 'Select the media type and the channel where Cloudy should post.'),
    components,
    allowedMentions: { parse: [] },
  };
}

export function feedChooser(session, feeds) {
  const options = feeds.slice(0, 5).map(feed => {
    const channel = session.guild?.channels?.cache?.get(feed.channelId);
    const channelName = channel?.name || feed.channelName || 'channel';
    return {
      label: (readableFeedName(feed) + ' • #' + channelName).slice(0, 100),
      description: (formatAutoMessage(feed.minutes) + ' • '
        + (feed.active ? 'Active' : 'Paused') + ' • ' + String(feed.source)).slice(0, 100),
      value: feed.id,
    };
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'feed:' + session.id)
    .setPlaceholder('Select a feed')
    .addOptions(options);
  return {
    embeds: choiceEmbed('Select the feed you want to manage.'),
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(PREFIX + 'back:' + session.id)
          .setLabel('Back').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function input(id, label, required, placeholder, defaultValue) {
  const field = new TextInputBuilder()
    .setCustomId(id).setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(500);
  if (placeholder) field.setPlaceholder(placeholder);
  if (defaultValue) field.setValue(defaultValue);
  return new ActionRowBuilder().addComponents(field);
}

function textLabel(id, label, required, placeholder, defaultValue) {
  const field = new TextInputBuilder().setCustomId(id)
    .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(500);
  if (placeholder) field.setPlaceholder(placeholder);
  if (defaultValue) field.setValue(defaultValue);
  return new LabelBuilder().setLabel(label).setTextInputComponent(field);
}

// Netherlands time. Empty: the feed starts after its Auto message time, as before.
const START_PLACEHOLDER = '00:00';

export function feedModal(session) {
  const editing = session.action === 'edit';
  const modal = new ModalBuilder()
    .setCustomId(PREFIX + 'submit:' + session.id)
    .setTitle(editing ? 'Edit feed' : 'Add feed');
  if (!editing) {
    modal.addComponents(
      input('name', 'Feed name', false, 'Enter name', ''),
      input('source', 'Website URL', true, 'https://example.com', ''),
      input('duration', 'Auto message', true, '1m or 1h', ''),
      input('start', 'Start time', false, START_PLACEHOLDER, ''),
      input('adult', '18+ content', false, 'yes / no', ''),
    );
    return modal;
  }
  const startAt = session.feed.startAt > Date.now() ? formatStartTime(session.feed.startAt) : '';
  return modal.addLabelComponents(
    textLabel('name', 'Feed name', false, 'Enter name', readableFeedName(session.feed)),
    textLabel('source', 'Website URL', false, 'https://example.com', session.feed?.source),
    textLabel('duration', 'Auto message', false, '1m or 1h', formatAutoMessage(session.feed.minutes)),
    textLabel('start', 'Start time', false, START_PLACEHOLDER, startAt),
    textLabel('adult', '18+ content', false, 'yes / no', session.feed.adult ? 'yes' : 'no'),
  );
}

export function parseAutoMessageTime(value, fallback) {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed) {
    if (fallback !== undefined) return fallback;
    throw new Error('Enter Auto message, for example 1m or 1h.');
  }
  const match = /^(\d+)(m|h)$/.exec(trimmed);
  if (!match) throw new Error('Use 1m for minutes or 1h for hours.');
  const number = Number(match[1]);
  const minutes = match[2] === 'h' ? number * 60 : number;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080) {
    throw new Error('Auto message must be between 1m and 168h.');
  }
  return minutes;
}

async function findOwnerGuild(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  return hasCloudyOwnerMember(member) ? guild : null;
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

async function errorNotice(interaction, error) {
  logger.warn('[CLOUDY_FEED] Dashboard operation failed:', error);
  const content = error?.message || 'Could not update Cloudy feed.';
  const message = await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
  if (message) {
    const timer = setTimeout(() => interaction.webhook.deleteMessage(message.id).catch(() => {}), 10_000);
    timer.unref?.();
  }
}

export async function openCloudyFeedDashboard(interaction, client) {
  const guild = await findOwnerGuild(client, interaction.guildId, interaction.user.id);
  if (!guild) {
    // A successful silent acknowledgement avoids a Discord "application did not respond" error.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    await interaction.deleteReply().catch(() => {});
    return;
  }

  for (const session of sessions.values()) {
    if (session.guildId === guild.id && session.userId === interaction.user.id) {
      closeSession(session);
    }
  }
  const session = {
    id: makeId(), guildId: guild.id, userId: interaction.user.id,
    root: interaction, guild, timer: null, action: null, feed: null,
    channelId: null, mediaType: null, modalOpen: false, view: 'dashboard',
  };
  sessions.set(session.id, session);
  try {
    const feeds = await readFeeds(client, guild.id);
    await interaction.reply({ ...dashboardForSession(session, feeds), flags: MessageFlags.Ephemeral });
    keepSessionAlive(session);
  } catch (error) {
    closeSession(session, false);
    throw error;
  }
}

// Add feed: the form opens once both the media type and the channel are chosen.
async function openAddFormWhenReady(interaction, session) {
  if (session.mediaType && session.channelId) {
    session.view = 'modal';
    await interaction.showModal(feedModal(session));
    keepSessionAlive(session, true);
    return;
  }
  session.view = 'channel';
  await interaction.update(channelChooser(session));
}

export async function handleCloudyFeedControls(interaction, client) {
  if (!interaction.customId?.startsWith(PREFIX)) return false;
  const parts = interaction.customId.slice(PREFIX.length).split(':');
  const [type, id, value] = parts;
  const session = sessions.get(id);

  if (!session || session.userId !== interaction.user.id) {
    await silentAck(interaction);
    return true;
  }

  const guild = await findOwnerGuild(client, session.guildId, interaction.user.id);
  if (!guild) {
    await silentAck(interaction);
    return true;
  }

  // Every actual interaction resets inactivity. Modal editing cannot emit typing events,
  // so keep the session open while Discord's modal is awaiting submission.
  keepSessionAlive(session);

  try {
    if (type === 'back' && interaction.isButton()) {
      const feeds = await readFeeds(client, session.guildId);
      if (session.view === 'channel' && session.feed) {
        session.action = null;
        session.view = 'detail';
        await interaction.update(feedDetail(session, session.feed));
      } else if (session.view === 'detail') {
        session.view = 'picker';
        session.feed = null;
        session.action = null;
        await interaction.update(feedChooser(session, feeds));
      } else {
        session.view = 'dashboard';
        session.action = null;
        session.feed = null;
        session.channelId = null;
        await interaction.update(dashboardForSession(session, feeds));
      }
      return true;
    }

    if (type === 'button' && interaction.isButton()) {
      if (value === 'add') {
        session.action = 'add';
        session.feed = null;
        session.channelId = null;
        session.mediaType = null;
        session.view = 'channel';
        await interaction.update(channelChooser(session));
        return true;
      }
      if (value === 'manage') {
        const feeds = await readFeeds(client, session.guildId);
        session.view = feeds.length ? 'picker' : 'dashboard';
        await interaction.update(feeds.length ? feedChooser(session, feeds) : dashboardForSession(session, feeds));
        return true;
      }
      if (!session.feed || session.view !== 'detail' || !['edit', 'pause', 'delete'].includes(value)) {
        await silentAck(interaction);
        return true;
      }
      if (value === 'edit') {
        // Open the modal immediately from the selected feed inside the same channel.
        session.action = 'edit';
        session.channelId = session.feed.channelId;
        session.view = 'modal';
        await interaction.showModal(feedModal(session));
        keepSessionAlive(session, true);
        return true;
      }
      await interaction.deferUpdate();
      const feeds = await applyAction(interaction, guild, value, { feedId: session.feed.id });
      if (!feeds) throw new Error('Cloudy feed is busy. Please try again.');
      if (value === 'delete') {
        session.feed = null;
        session.view = 'dashboard';
        await interaction.editReply(dashboardForSession(session, feeds));
      } else {
        session.feed = feeds.find(feed => feed.id === session.feed.id) || null;
        session.view = 'detail';
        await interaction.editReply(feedDetail(session, session.feed));
      }
      return true;
    }

    if (type === 'feed' && interaction.isStringSelectMenu()) {
      const feeds = await readFeeds(client, session.guildId);
      session.feed = feeds.find(feed => feed.id === interaction.values[0]) || null;
      if (!session.feed) {
        session.view = 'picker';
        await interaction.update(feedChooser(session, feeds));
      } else {
        session.view = 'detail';
        session.action = null;
        session.channelId = session.feed.channelId;
        await interaction.update(feedDetail(session, session.feed));
      }
      return true;
    }

    if (type === 'channel' && interaction.isChannelSelectMenu()) {
      if (session.action !== 'add') {
        await silentAck(interaction);
        return true;
      }
      session.channelId = interaction.values[0];
      await openAddFormWhenReady(interaction, session);
      return true;
    }

    if (type === 'media' && interaction.isStringSelectMenu()) {
      const mediaType = interaction.values[0];
      if (session.action === 'add') {
        session.mediaType = mediaType;
        await openAddFormWhenReady(interaction, session);
        return true;
      }
      if (!session.feed || session.view !== 'detail') {
        await silentAck(interaction);
        return true;
      }
      // Manage feed: a new media type is saved straight away.
      const feedId = session.feed.id;
      await interaction.deferUpdate();
      const feeds = await applyAction(interaction, guild, 'edit', { feedId, mediaType });
      if (!feeds) throw new Error('Cloudy feed is busy. Please try again.');
      const saved = feeds.find(feed => feed.id === feedId) || null;
      Object.assign(session, { feed: saved, view: saved ? 'detail' : 'dashboard' });
      await interaction.editReply(saved ? feedDetail(session, saved) : dashboardForSession(session, feeds));
      return true;
    }

    if (type === 'keep' && interaction.isButton() && session.action === 'edit' && session.feed) {
      session.view = 'modal';
      await interaction.showModal(feedModal(session));
      keepSessionAlive(session, true);
      return true;
    }

    if (type === 'submit' && interaction.isModalSubmit() && ['add', 'edit'].includes(session.action)) {
      // Defer before network/database reads; the button's ephemeral panel stays the reply target.
      await interaction.deferUpdate();
      session.modalOpen = false;
      keepSessionAlive(session);
      const name = interaction.fields.getTextInputValue('name').trim();
      const source = interaction.fields.getTextInputValue('source').trim();
      const duration = interaction.fields.getTextInputValue('duration').trim();
      const adult = interaction.fields.getTextInputValue('adult').trim();
      const start = interaction.fields.getTextInputValue('start').trim();
      const minutes = parseAutoMessageTime(duration, session.action === 'edit' ? session.feed?.minutes : undefined);
      const data = {
        name, source, minutes: String(minutes), adult, start,
        channel: session.channelId,
        ...(session.action === 'edit' ? { feedId: session.feed.id } : { mediaType: session.mediaType }),
      };
      const feeds = await applyAction(interaction, guild, session.action, data);
      if (!feeds) throw new Error('Cloudy feed is busy. Please try again.');
      const saved = session.action === 'add'
        ? feeds[feeds.length - 1]
        : feeds.find(feed => feed.id === session.feed?.id);
      session.action = null;
      session.feed = saved || null;
      session.channelId = saved?.channelId || null;
      session.view = saved ? 'detail' : 'dashboard';
      await interaction.editReply(saved ? feedDetail(session, saved) : dashboardForSession(session, feeds));
      return true;
    }

    await silentAck(interaction);
  } catch (error) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    await errorNotice(interaction, error);
    keepSessionAlive(session);
  }
  return true;
}
