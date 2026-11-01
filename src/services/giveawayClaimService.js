// Private, per-winner giveaway claim channels. The existing ticket system is untouched.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { getGuildConfig } from './config/guildConfig.js';
import { canManageGiveawaysAsOwner, loadGiveaway } from './giveawayActions.js';
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { DEFAULT_CLAIM_ICONS, getGiveawayClaimIcons } from './giveawayClaimIcons.js';
import { buildPrivateClaimEmbed } from './giveawayClaimPreview.js';

export const GIVEAWAY_CLAIM_PREFIX = 'gclaim:';
export const CLAIM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const WHITE = 0xFFFFFF;
const CODE_KEY_ENV = 'GIVEAWAY_CLAIM_ENCRYPTION_KEY';
const registryKey = guildId => 'guild:' + guildId + ':giveaway-claim:records';
const claimId = (messageId, userId) => messageId + ':' + userId;
const claimLink = (guildId, channelId) => 'https://discord.com/channels/' + guildId + '/' + channelId;
const notice = (interaction, text) => interaction.editReply({ content: text, allowedMentions: { parse: [] } });

function secretKey() {
  const text = process.env[CODE_KEY_ENV] || '';
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return null;
  return Buffer.from(text, 'hex');
}

function protect(code) {
  const key = secretKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: ciphertext.toString('base64') };
}

function reveal(encrypted) {
  const key = secretKey();
  if (!key || !encrypted?.iv || !encrypted?.tag || !encrypted?.body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.body, 'base64')), decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

async function registry(client, guildId) {
  const value = unwrapReplitData(await client.db.get(registryKey(guildId), {}));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function findClaim(client, guildId, messageId, userId) {
  const records = await registry(client, guildId);
  return records[claimId(messageId, userId)] || null;
}

async function saveClaim(client, guildId, record) {
  // One write queue per guild prevents two winners from overwriting each other.
  return Mutex.runExclusive('gclaim-registry:' + guildId, async () => {
    const records = await registry(client, guildId);
    records[claimId(record.messageId, record.userId)] = record;
    if (await client.db.set(registryKey(guildId), records) === false) {
      throw new Error('Could not save giveaway claim state');
    }
  });
}

export function claimPanel(giveaway, userId, icons = DEFAULT_CLAIM_ICONS) {
  // The visible code is a demo-only placeholder. No real activation code is
  // exposed and no 24-hour timer starts merely by displaying it.
  return {
    content: '<@' + userId + '>',
    embeds: [buildPrivateClaimEmbed(giveaway, userId, icons)],
    components: [],
    allowedMentions: { parse: [], users: [userId] },
  };
}

async function openClaim(interaction, client, messageId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
  if (!giveaway || !giveaway.ended || !giveaway.winnerIds?.includes(interaction.user.id)) {
    return notice(interaction, 'Only a current winner can claim this prize.');
  }
  const guild = interaction.guild;
  const userId = interaction.user.id;
  return Mutex.runExclusive('gclaim-open:' + guild.id + ':' + messageId + ':' + userId, async () => {
    const prior = await findClaim(client, guild.id, messageId, userId);
    if (prior?.closedAt) return notice(interaction, 'This prize claim has already closed.');
    if (prior?.channelId) {
      const current = await guild.channels.fetch(prior.channelId).catch(() => null);
      if (current) return notice(interaction, 'Your private claim channel: ' + claimLink(guild.id, current.id));
    }

    const config = await getGuildConfig(client, guild.id).catch(() => ({}));
    const configuredCategory = config.ticketCategoryId || config.ticketsCategoryId || null;
    const category = configuredCategory
      ? await guild.channels.fetch(configuredCategory).catch(() => null)
      : guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory
        && channel.name.toLowerCase().includes('tickets'));
    const staffRoleId = config.ticketStaffRoleId;
    const channel = await guild.channels.create({
      name: 'giveaway-claim-' + userId.slice(-6),
      type: ChannelType.GuildText,
      parent: category?.type === ChannelType.GuildCategory ? category.id : undefined,
      topic: 'Cloudy giveaway claim ' + messageId + ' ' + userId,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: userId, allow: [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles,
        ] },
        ...(staffRoleId ? [{ id: staffRoleId, allow: [
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages,
        ] }] : []),
      ],
    });
    const record = {
      messageId, userId, channelId: channel.id, createdAt: new Date().toISOString(),
      revealedAt: null, expiresAt: null, encryptedCode: null, closedAt: null,
    };
    try {
      await saveClaim(client, guild.id, record);
      const panelMessage = await channel.send(claimPanel(giveaway, userId,
        await getGiveawayClaimIcons(client)));
      await saveClaim(client, guild.id, { ...record, panelMessageId: panelMessage.id });
    } catch (error) {
      await channel.delete('Failed to initialize giveaway claim').catch(() => {});
      throw error;
    }
    return notice(interaction, 'Your private claim channel is ready: ' + claimLink(guild.id, channel.id));
  });
}

async function takeCode(interaction, client, messageId, userId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== userId) return notice(interaction, 'Only the winner can see their code.');
  return Mutex.runExclusive('gclaim-take:' + interaction.guildId + ':' + messageId + ':' + userId, async () => {
    const record = await findClaim(client, interaction.guildId, messageId, userId);
    if (!record || record.channelId !== interaction.channelId || record.closedAt) {
      return notice(interaction, 'This claim channel is no longer active.');
    }
    if (record.revealedAt) return notice(interaction,
      'Your code is already shown in this private channel. It will be removed <t:'
      + Math.floor(Date.parse(record.expiresAt) / 1000) + ':R>.');
    const code = reveal(record.encryptedCode);
    if (!code) return notice(interaction, 'Your code is not ready yet. Please contact the giveaway staff.');
    const shown = await interaction.channel.send({
      content: '<@' + userId + '>',
      embeds: [{
        title: 'Your prize code',
        description: '||' + code.replaceAll('|', '\\|') + '||\n\n'
          + 'Keep this code safe. This channel and all its messages will be deleted 24 hours after this reveal.',
        color: WHITE,
      }],
      allowedMentions: { parse: [], users: [userId] },
    });
    const now = Date.now();
    try {
      await saveClaim(client, interaction.guildId, {
        ...record, revealedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + CLAIM_LIFETIME_MS).toISOString(),
        encryptedCode: null, codeMessageId: shown.id,
      });
    } catch (error) {
      await shown.delete().catch(() => {});
      throw error;
    }
    return notice(interaction, 'Code revealed in your private channel. Automatic deletion: <t:'
      + Math.floor((now + CLAIM_LIFETIME_MS) / 1000) + ':F>.');
  });
}

async function showCodeModal(interaction, client, messageId, userId) {
  if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
    return interaction.reply({ content: 'Only the Owner role can configure prize codes.', flags: MessageFlags.Ephemeral });
  }
  if (!secretKey()) {
    return interaction.reply({
      content: 'Set GIVEAWAY_CLAIM_ENCRYPTION_KEY to 64 hex characters in Railway before storing prize codes.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const record = await findClaim(client, interaction.guildId, messageId, userId);
  if (!record || record.channelId !== interaction.channelId || record.closedAt || record.revealedAt) {
    return interaction.reply({ content: 'This claim cannot be configured.', flags: MessageFlags.Ephemeral });
  }
  const input = new TextInputBuilder().setCustomId('code').setLabel('Private prize code')
    .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(200).setRequired(true);
  return interaction.showModal(new ModalBuilder().setCustomId('gclaim:save:' + messageId + ':' + userId)
    .setTitle('Set prize code').addComponents(new ActionRowBuilder().addComponents(input)));
}

async function storeCode(interaction, client, messageId, userId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
    return notice(interaction, 'Only the Owner role can configure prize codes.');
  }
  const encrypted = protect(interaction.fields.getTextInputValue('code').trim());
  if (!encrypted) return notice(interaction, 'Prize-code encryption is not configured.');
  return Mutex.runExclusive('gclaim-take:' + interaction.guildId + ':' + messageId + ':' + userId, async () => {
    const record = await findClaim(client, interaction.guildId, messageId, userId);
    if (!record || record.channelId !== interaction.channelId || record.closedAt || record.revealedAt) {
      return notice(interaction, 'This claim cannot be configured.');
    }
    await saveClaim(client, interaction.guildId, { ...record, encryptedCode: encrypted });
    return notice(interaction, 'The prize code is stored securely. The winner can now press Take code.');
  });
}

export async function handleGiveawayClaimInteraction(interaction, client) {
  if (!interaction.customId?.startsWith(GIVEAWAY_CLAIM_PREFIX)) return false;
  const [, action, messageId, userId] = interaction.customId.split(':');
  try {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'Prize claiming is available only in the server.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'open' && messageId) return await openClaim(interaction, client, messageId);
    if (action === 'take' && messageId && userId) return await takeCode(interaction, client, messageId, userId);
    if (action === 'setup' && messageId && userId) return await showCodeModal(interaction, client, messageId, userId);
    if (action === 'save' && messageId && userId && interaction.isModalSubmit()) {
      return await storeCode(interaction, client, messageId, userId);
    }
    return await interaction.reply({ content: 'This claim action is unavailable.', flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error('Giveaway claim action failed:', { action, guildId: interaction.guildId, messageId, error: error?.message });
    const reply = { content: 'The claim could not be completed. Please try again or contact staff.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content: reply.content }).catch(() => {});
    return interaction.reply(reply).catch(() => {});
  }
}

export async function cleanupExpiredGiveawayClaims(client) {
  if (!client.db?.get || !client.db?.set) return;
  for (const guild of client.guilds.cache.values()) {
    let records;
    try { records = await registry(client, guild.id); } catch (error) {
      logger.warn('Could not inspect giveaway claim expiry for guild ' + guild.id, error);
      continue;
    }
    for (const record of Object.values(records)) {
      if (!record?.channelId || !record.expiresAt || record.closedAt || Date.parse(record.expiresAt) > Date.now()) continue;
      await Mutex.runExclusive('gclaim-take:' + guild.id + ':' + record.messageId + ':' + record.userId, async () => {
        const current = await findClaim(client, guild.id, record.messageId, record.userId);
        if (!current?.expiresAt || current.closedAt || Date.parse(current.expiresAt) > Date.now()) return;
        const channel = await guild.channels.fetch(current.channelId).catch(() => null);
        if (channel) {
          try { await channel.delete('Giveaway prize code viewed; 24-hour claim period ended'); }
          catch (error) { logger.warn('Could not delete expired giveaway claim channel ' + current.channelId, error); return; }
        }
        await saveClaim(client, guild.id, { ...current, closedAt: new Date().toISOString(), encryptedCode: null });
      });
    }
  }
}

// Refresh already-open claim panels once after a restart/deployment. Never
// repost or delete a winner's message; only edit the bot's original panel.
// Older claims predate panelMessageId persistence, so locate the original
// by its unique Take code custom ID when necessary.
export async function refreshExistingClaimPanels(client) {
  if (!client?.db?.get || !client?.db?.set) return;
  for (const guild of client.guilds.cache.values()) {
    let records;
    try { records = await registry(client, guild.id); }
    catch (error) {
      logger.warn('Could not load claim panels for guild ' + guild.id, error);
      continue;
    }
    for (const record of Object.values(records)) {
      if (!record?.messageId || !record?.userId || !record?.channelId || record.closedAt) continue;
      try {
        const channel = await guild.channels.fetch(record.channelId).catch(() => null);
        if (!channel?.messages?.fetch) continue;
        const expectedId = 'gclaim:take:' + record.messageId + ':' + record.userId;
        const isPanel = message => Boolean(message?.author?.id === client.user?.id
          && (message.id === record.panelMessageId || message.components?.some(row =>
            row.components?.some(button =>
              (button.customId || button.custom_id || button.data?.custom_id) === expectedId))));
        let message = record.panelMessageId
          ? await channel.messages.fetch(record.panelMessageId).catch(() => null)
          : null;
        if (!isPanel(message)) {
          const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
          message = recent?.find?.(isPanel) || null;
        }
        if (!isPanel(message)) continue;
        const giveaway = await loadGiveaway(client, guild.id, record.messageId);
        if (!giveaway) continue;
        const panel = claimPanel(giveaway, record.userId, await getGiveawayClaimIcons(client));
        await message.edit({
          embeds: panel.embeds,
          components: panel.components,
          allowedMentions: { parse: [] },
        });
        if (record.panelMessageId !== message.id) {
          await saveClaim(client, guild.id, { ...record, panelMessageId: message.id });
        }
      } catch (error) {
        logger.warn('Could not update giveaway claim panel ' + record.channelId, error);
      }
    }
  }
}

let cleanupStarted = false;
export function startGiveawayClaimCleanup(client) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  void cleanupExpiredGiveawayClaims(client).catch(error => logger.warn('Initial giveaway claim cleanup failed', error));
  void getGiveawayClaimIcons(client).catch(error => logger.warn('Could not prewarm white claim icons', error));
  void refreshExistingClaimPanels(client).catch(error => logger.warn('Initial giveaway claim panel refresh failed', error));
  const timer = setInterval(() => {
    void cleanupExpiredGiveawayClaims(client).catch(error => logger.warn('Giveaway claim cleanup failed', error));
  }, 60_000);
  timer.unref?.();
}
