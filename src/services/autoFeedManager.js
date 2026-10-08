import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
} from 'discord.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import {
  addAutoFeed, deleteAutoFeed, listAutoFeeds, loadSourceItems,
  updateAutoFeed, validateFeedUrl,
} from './autoFeedService.js';
import { logger } from '../utils/logger.js';

const BASE = 'cloudy-autofeed';
const DENIED = 'Only members with the Owner role can manage Auto feed.';

async function owner(interaction) {
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  return Boolean(member && hasCloudyOwnerMember(member));
}

function panel(feeds) {
  const embed = new EmbedBuilder().setColor(0xFFFFFF).setTitle('Auto feed manager')
    .setDescription('Configure automatic posts from your favorite websites. Cloudy will randomly select new content and post it to your chosen channel.');
  if (!feeds.length) embed.addFields({ name: 'Feeds', value: 'No feeds configured. Select Add feed to create one.' });
  for (const [i, feed] of feeds.slice(0, 12).entries()) {
    embed.addFields({
      name: String(i + 1) + '. ' + new URL(feed.url).hostname,
      value: '**Source:** ' + feed.url.slice(0, 200) +
        '\n**Channel:** <#' + feed.channelId + '>' +
        '\n**Interval:** Every ' + feed.intervalMinutes + ' minutes' +
        '\n**Random posts:** Enabled' +
        '\n**Duplicates:** Prevented' +
        '\n**18+ content:** ' + (feed.adult ? 'Enabled' : 'Disabled') +
        '\n**Status:** ' + (feed.paused ? 'Paused' : 'Active'),
    });
  }
  return embed.setFooter({ text: feeds.filter(f => !f.paused).length + ' active · ' + feeds.length + ' total' });
}

function buttons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BASE + ':add').setLabel('Add feed').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(BASE + ':edit').setLabel('Edit feed').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BASE + ':pause').setLabel('Pause feed').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BASE + ':delete').setLabel('Delete feed').setStyle(ButtonStyle.Danger),
  )];
}

function chooser(feeds, action) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(BASE + ':choose:' + action)
    .setPlaceholder('Choose a feed to ' + action)
    .addOptions(feeds.slice(0, 20).map(f => ({
      label: (new URL(f.url).hostname + ' · #' + f.channelId).slice(0, 100),
      description: (f.paused ? 'Paused' : 'Active') + ' · Every ' + f.intervalMinutes + ' minutes',
      value: f.id,
    })));
  return [new ActionRowBuilder().addComponents(menu), ...buttons()];
}

function input(id, label, current, placeholder) {
  const item = new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(id === 'source' ? 1024 : 100)
    .setPlaceholder(placeholder);
  if (current != null && String(current).length) item.setValue(String(current));
  return new ActionRowBuilder().addComponents(item);
}

function modalFor(feed) {
  return new ModalBuilder().setCustomId(BASE + ':modal:' + (feed?.id || 'new'))
    .setTitle(feed ? 'Edit Auto feed' : 'Add Auto feed').addComponents(
      input('source', 'Website URL', feed?.url, 'https://website.com'),
      input('channel', 'Discord channel ID', feed?.channelId, 'Copy channel ID from Discord'),
      input('interval', 'Timer in minutes', feed?.intervalMinutes || '30', '30'),
      input('adult', '18+ content? yes or no', feed?.adult ? 'yes' : 'no', 'no'),
    );
}

function fieldsFrom(modal) {
  const url = validateFeedUrl(modal.fields.getTextInputValue('source'));
  const entered = modal.fields.getTextInputValue('channel').trim();
  const channelId = entered.match(/^<#(\d{17,20})>$/)?.[1] || entered;
  if (!/^\d{17,20}$/.test(channelId)) throw new Error('Enter a valid Discord channel ID.');
  const intervalMinutes = Number(modal.fields.getTextInputValue('interval').trim());
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new Error('The timer must be between 5 and 1440 minutes.');
  }
  const adult = modal.fields.getTextInputValue('adult').trim().toLowerCase();
  if (!['yes', 'no'].includes(adult)) throw new Error('For 18+ content, enter yes or no.');
  return { url, channelId, intervalMinutes, adult: adult === 'yes' };
}

async function checkChannel(guild, fields) {
  const channel = await guild.channels.fetch(fields.channelId).catch(() => null);
  if (!channel || ![0, 5].includes(channel.type)) throw new Error('Choose a text or announcement channel in this server.');
  if (fields.adult && !channel.nsfw) throw new Error('Adult feeds need an age restricted channel.');
  const me = guild.members.me || await guild.members.fetchMe();
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms.has(PermissionFlagsBits.SendMessages) ||
      !perms.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error('Cloudy needs View channel, Send messages and Embed links there.');
  }
}

async function collectModal(component, feed, updatePanel) {
  await component.showModal(modalFor(feed));
  const modal = await component.awaitModalSubmit({
    time: 120_000,
    filter: i => i.user.id === component.user.id && i.customId === BASE + ':modal:' + (feed?.id || 'new'),
  }).catch(() => null);
  if (!modal) return;
  if (!await owner(modal)) {
    await modal.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    return;
  }
  await modal.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const fields = fieldsFrom(modal);
    if (feed) {
      await checkChannel(modal.guild, fields);
      await loadSourceItems(fields.url);
      await updateAutoFeed(modal.client, modal.guildId, feed.id, {
        ...fields, seen: fields.url === feed.url ? feed.seen : [],
        nextRunAt: Date.now() + fields.intervalMinutes * 60_000,
      });
      await modal.editReply('Auto feed updated successfully.');
    } else {
      const result = await addAutoFeed(modal.client, modal.guild, fields);
      await modal.editReply('Auto feed added to <#' + fields.channelId + '>. ' +
        result.availablePosts + ' posts available. First post in ' + fields.intervalMinutes + ' minutes.');
    }
    await updatePanel();
  } catch (error) {
    await modal.editReply('Auto feed was not saved. ' + error.message).catch(() => {});
  }
}

export async function openAutoFeedManager(interaction) {
  if (!await owner(interaction)) {
    await interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const client = interaction.client;
  const refresh = async () => {
    const feeds = await listAutoFeeds(client, interaction.guildId);
    await interaction.editReply({ embeds: [panel(feeds)], components: buttons() });
  };
  try {
    await refresh();
    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({ idle: 300_000 });
    collector.on('collect', async component => {
      if (component.user.id !== interaction.user.id || !await owner(component)) {
        await component.reply({ content: DENIED, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      try {
        const parts = component.customId.split(':');
        const action = parts[1] === 'choose' ? parts[2] : parts[1];
        const feeds = await listAutoFeeds(client, interaction.guildId);
        if (action === 'add') {
          await collectModal(component, null, refresh);
          return;
        }
        if (parts[1] === 'choose') {
          const feed = feeds.find(f => f.id === component.values[0]);
          if (!feed) {
            await component.reply({ content: 'This feed no longer exists.', flags: MessageFlags.Ephemeral });
            await refresh();
            return;
          }
          if (action === 'edit') {
            await collectModal(component, feed, refresh);
            return;
          }
          await component.deferUpdate();
          if (action === 'pause') await updateAutoFeed(client, interaction.guildId, feed.id, { paused: !feed.paused });
          if (action === 'delete') await deleteAutoFeed(client, interaction.guildId, feed.id);
          await refresh();
          return;
        }
        if (!feeds.length) {
          await component.reply({ content: 'No feeds configured yet.', flags: MessageFlags.Ephemeral });
          return;
        }
        await component.update({ embeds: [panel(feeds)], components: chooser(feeds, action) });
      } catch (error) {
        logger.error('[AUTO_FEED] Manager error: ' + error.message);
        if (!component.replied && !component.deferred) {
          await component.reply({ content: 'Could not update Auto feed. ' + error.message, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    });
    collector.on('end', () => { void interaction.deleteReply().catch(() => {}); });
  } catch (error) {
    logger.error('[AUTO_FEED] Could not open manager: ' + error.message);
    await interaction.editReply({ content: 'Could not load Auto feed settings.', embeds: [], components: [] });
  }
}
