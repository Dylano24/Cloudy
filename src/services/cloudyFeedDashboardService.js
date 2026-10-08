import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { readFeeds, applyAction } from './cloudyFeedService.js';
import { logger } from '../utils/logger.js';

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

function labelHours(minutes) {
  const hours = minutes / 60;
  return hours === 1 ? 'Every 1 hour' : 'Every ' + hours + ' hours';
}

export function buildCloudyFeedDashboard(guildId, feeds) {
  const embed = new EmbedBuilder()
    .setTitle('Cloudy feed')
    .setDescription('Configure automatic posts from websites. Cloudy will randomly select new content and post it to your chosen channel.')
    .setColor(0xFFFFFF);

  if (!feeds.length) embed.addFields({ name: 'Feeds', value: 'No feeds configured.' });

  for (const feed of feeds.slice(0, 5)) {
    embed.addFields({
      name: 'Feed ' + feed.id,
      value: '**Source:** ' + feed.source.slice(0, 150)
        + '\n**Channel:** <#' + feed.channelId + '>'
        + '\n**Auto message:** ' + labelHours(feed.minutes)
        + '\n**Status:** ' + (feed.active ? 'Active' : 'Paused'),
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIX + 'add:' + guildId).setLabel('Add feed').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(PREFIX + 'edit:' + guildId).setLabel('Edit feed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PREFIX + 'pause:' + guildId).setLabel('Pause feed').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PREFIX + 'delete:' + guildId).setLabel('Delete feed').setStyle(ButtonStyle.Danger),
  );

  // Replace stable placeholder IDs with this user's per-dashboard session IDs.
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function dashboardForSession(session, feeds) {
  const payload = buildCloudyFeedDashboard(session.guildId, feeds);
  const buttons = payload.components[0].components;
  ['add', 'edit', 'pause', 'delete'].forEach((action, index) => {
    buttons[index].setCustomId(PREFIX + 'button:' + session.id + ':' + action);
  });
  return payload;
}

function choiceEmbed(description) {
  return [new EmbedBuilder().setTitle('Cloudy feed').setDescription(description).setColor(0xFFFFFF)];
}

function channelChooser(session, edit = false) {
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(PREFIX + 'channel:' + session.id)
    .setPlaceholder('Select a channel')
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const components = [new ActionRowBuilder().addComponents(picker)];
  if (edit) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(PREFIX + 'keep:' + session.id)
        .setLabel('Keep current channel').setStyle(ButtonStyle.Secondary),
    ));
  }
  return {
    embeds: choiceEmbed('Select the channel where Cloudy should post.'),
    components,
    allowedMentions: { parse: [] },
  };
}

function feedChooser(session, feeds) {
  const options = feeds.slice(0, 5).map(feed => ({
    label: 'Feed ' + feed.id,
    description: String(feed.source).slice(0, 95),
    value: feed.id,
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(PREFIX + 'feed:' + session.id)
    .setPlaceholder('Select a feed')
    .addOptions(options);
  return {
    embeds: choiceEmbed('Select the feed you want to manage.'),
    components: [new ActionRowBuilder().addComponents(menu)],
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

function feedModal(session) {
  const editing = session.action === 'edit';
  const modal = new ModalBuilder()
    .setCustomId(PREFIX + 'submit:' + session.id)
    .setTitle(editing ? 'Edit feed' : 'Add feed');
  return modal.addComponents(
    input('source', 'Website URL', !editing, 'https://example.com', editing ? session.feed?.source : ''),
    input('hours', 'Auto message (hours)', !editing, '2', editing ? String(session.feed.minutes / 60) : ''),
    input('adult', '18+ content', false, 'yes / no', editing ? (session.feed.adult ? 'yes' : 'no') : ''),
  );
}

function hoursToMinutes(value, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    if (fallback !== undefined) return fallback;
    throw new Error('Enter Auto message in hours.');
  }
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < 1 || number > 168) {
    throw new Error('Auto message must be between 1 and 168 hours.');
  }
  return number * 60;
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
    root: interaction, timer: null, action: null, feed: null,
    channelId: null, modalOpen: false,
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

export async function handleCloudyFeedControls(interaction, client) {
  if (!interaction.customId?.startsWith(PREFIX)) return false;
  const parts = interaction.customId.slice(PREFIX.length).split(':');
  const [type, id, value] = parts;
  const session = sessions.get(id);

  if (!session || session.userId !== interaction.user.id || !interaction.isFromMessage && type !== 'submit') {
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
    if (type === 'button' && interaction.isButton()) {
      if (!['add', 'edit', 'pause', 'delete'].includes(value)) {
        await silentAck(interaction);
        return true;
      }
      session.action = value;
      session.feed = null;
      session.channelId = null;
      if (value === 'add') {
        await interaction.update(channelChooser(session));
      } else {
        const feeds = await readFeeds(client, session.guildId);
        if (!feeds.length) {
          await interaction.update(dashboardForSession(session, feeds));
        } else {
          await interaction.update(feedChooser(session, feeds));
        }
      }
      return true;
    }

    if (type === 'feed' && interaction.isStringSelectMenu()) {
      const feeds = await readFeeds(client, session.guildId);
      session.feed = feeds.find(feed => feed.id === interaction.values[0]) || null;
      if (!session.feed) {
        await interaction.update(dashboardForSession(session, feeds));
      } else if (session.action === 'edit') {
        session.channelId = session.feed.channelId;
        await interaction.update(channelChooser(session, true));
      } else if (session.action === 'pause' || session.action === 'delete') {
        await interaction.deferUpdate();
        const result = await applyAction(interaction, guild, session.action, { feedId: session.feed.id });
        if (!result) throw new Error('Cloudy feed is busy. Please try again.');
        session.action = null;
        session.feed = null;
        await interaction.editReply(dashboardForSession(session, result));
      } else {
        await interaction.deferUpdate();
      }
      return true;
    }

    if (type === 'channel' && interaction.isChannelSelectMenu()) {
      if (!['add', 'edit'].includes(session.action)) {
        await silentAck(interaction);
        return true;
      }
      session.channelId = interaction.values[0];
      await interaction.showModal(feedModal(session));
      keepSessionAlive(session, true);
      return true;
    }

    if (type === 'keep' && interaction.isButton() && session.action === 'edit' && session.feed) {
      await interaction.showModal(feedModal(session));
      keepSessionAlive(session, true);
      return true;
    }

    if (type === 'submit' && interaction.isModalSubmit() && ['add', 'edit'].includes(session.action)) {
      // Defer before network/database reads; the button's ephemeral panel stays the reply target.
      await interaction.deferUpdate();
      session.modalOpen = false;
      keepSessionAlive(session);
      const source = interaction.fields.getTextInputValue('source').trim();
      const hours = interaction.fields.getTextInputValue('hours').trim();
      const adult = interaction.fields.getTextInputValue('adult').trim();
      const minutes = hoursToMinutes(hours, session.action === 'edit' ? session.feed?.minutes : undefined);
      const data = {
        source, minutes: String(minutes), adult,
        channel: session.channelId,
        ...(session.action === 'edit' ? { feedId: session.feed.id } : {}),
      };
      const feeds = await applyAction(interaction, guild, session.action, data);
      if (!feeds) throw new Error('Cloudy feed is busy. Please try again.');
      session.action = null;
      session.feed = null;
      session.channelId = null;
      await interaction.editReply(dashboardForSession(session, feeds));
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
