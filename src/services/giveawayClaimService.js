// Private, per-winner giveaway claim channels. The existing ticket system is untouched.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags,
  ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_RED_COLOR } from '../utils/embedColorPolicy.js';
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { getGuildConfig } from './config/guildConfig.js';
import { canManageGiveawaysAsOwner, checkUnclaimedGiveawayWinners, loadGiveaway } from './giveawayActions.js';
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { DEFAULT_CLAIM_ICONS, getGiveawayClaimIcons } from './giveawayClaimIcons.js';
import { buildPrivateClaimEmbed, displayDemoClaimCode } from './giveawayClaimPreview.js';
import { sendGiveawayClaimLog, updateClosedClaimChannelLogs } from './giveawayClaimLogService.js';
import {
  generateGiveawayCode, givesGeneratedCode, hasGiveawayCodeKey, protectGiveawayCode, requiresCountry,
  revealGiveawayCode, sealGiveawayCode, takeAddedCode, usesAddedCodes,
} from './giveawayCodeService.js';
import { saveGiveaway } from '../utils/giveaways.js';
import { getOrCreateGiveawayNumber } from './giveawayNumberService.js';

// One-time, targeted spacing correction for still-open private claim panels.
// Edit the same message; leave mentions, buttons, other embed text, logo,
// footer and 24-hour claim lifetime untouched.
export async function refreshPrivateGiveawayClaimNoteSpacing(client) {
  if (!client?.db?.get) return;
  for (const guild of client.guilds?.cache?.values?.() || []) {
    try {
      const raw = unwrapReplitData(await client.db.get(registryKey(guild.id), {}));
      const records = raw && typeof raw === 'object' ? Object.values(raw) : [];
      for (const record of records) {
        if (record?.closedAt || !record?.channelId || !record?.panelMessageId) continue;
        try {
          const channel = guild.channels?.cache?.get?.(record.channelId)
            || await guild.channels?.fetch?.(record.channelId);
          if (!channel?.messages?.fetch) continue;
          const message = await channel.messages.fetch(record.panelMessageId).catch(() => null);
          if (!message?.edit || !message.embeds?.length
            || (message.author?.id && message.author.id !== client.user?.id)) continue;
          let changed = false;
          const embeds = message.embeds.map(embed => {
            const data = embed.toJSON?.() || { ...embed };
            const description = data.description;
            if (typeof description !== 'string') return data;
            // Match exactly the redundant newline before the white warning
            // emoji, without modifying custom Please note copy.
            const next = description.replace(
              /\n\n\n(<:W97warningwhite:1543290138707230730> \*\*Please note\*\*)/,
              '\n\n$1',
            );
            if (next === description) return data;
            changed = true;
            return { ...data, description: next };
          });
          if (changed) await message.edit({ embeds });
        } catch (error) {
          logger.warn('Could not adjust spacing of giveaway claim panel ' + record.panelMessageId, error);
        }
      }
    } catch (error) {
      logger.warn('Could not load giveaway claim panels for spacing correction in ' + guild.id, error);
    }
  }
}

export const GIVEAWAY_CLAIM_PREFIX = 'gclaim:';
export const CLAIM_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const CLAIM_DENIED_NOTICE_MS = 20_000;
export const GIVEAWAY_CLAIM_CATEGORY_ID = '1566382220904763443';
const WHITE = 0xFFFFFF;
const registryKey = guildId => 'guild:' + guildId + ':giveaway-claim:records';
const claimId = (messageId, userId) => messageId + ':' + userId;
const notice = (interaction, text) => interaction.editReply({ content: text, allowedMentions: { parse: [] } });

// Send audits in claim order: on Close/expiry, rewrite all earlier Claim and
// Reveal logs only after their sends have completed. No audit failure may
// prevent the Claim, Reveal, or Close interaction from succeeding.
function logClaimAction(client, guild, detail) {
  // Capture the action's actual time before the asynchronous audit queue.
  detail = { ...detail, occurredAt: detail.occurredAt || new Date().toISOString() };
  const auditLock = 'gclaim-audit:' + guild.id + ':' + detail.messageId + ':' + detail.userId;
  void Mutex.runExclusive(auditLock, async () => {
    try {
      await sendGiveawayClaimLog(client, guild, detail);
    } catch (error) {
      logger.warn('Could not send giveaway claim audit log: ' + (error?.message || error));
    }
    if ((detail.event === 'closed' || detail.event === 'expired') && detail.claimChannelId) {
      await updateClosedClaimChannelLogs(client, guild, new Set([detail.claimChannelId]));
    }
  }).catch(error =>
    logger.warn('Could not update closed giveaway claim audit references: ' + (error?.message || error)));
}

// Keep private Claim successful replies associated with their claim channel.
// No bot-imposed timeout: remove them only when the claim channel is deleted.
// Discord ultimately controls the lifetime of ephemeral replies.
const pendingSuccessNotices = new WeakMap();
const noticeKey = (messageId, userId) => messageId + ':' + userId;
function pendingNotices(client, messageId, userId, create = false) {
  let byClaim = pendingSuccessNotices.get(client);
  if (!byClaim && create) {
    byClaim = new Map();
    pendingSuccessNotices.set(client, byClaim);
  }
  const key = noticeKey(messageId, userId);
  let notices = byClaim?.get(key);
  if (!notices && create) {
    notices = new Set();
    byClaim.set(key, notices);
  }
  return { byClaim, key, notices };
}
async function deleteClaimResultReply(interaction) {
  try {
    await interaction.deleteReply();
  } catch (error) {
    // Discord interaction tokens eventually expire, making old ephemeral
    // replies undeletable via the API. They may already be gone in the client.
    if (error?.code !== 10008 && error?.code !== 10015 && error?.code !== 50027) {
      logger.warn('Giveaway Claim notice could not be removed: ' + (error?.message || error));
    }
  }
}
async function deletePendingSuccessNotices(client, messageId, userId) {
  const { byClaim, key, notices } = pendingNotices(client, messageId, userId);
  if (!notices?.size) return;
  byClaim.delete(key);
  await Promise.all([...notices].map(entry => deleteClaimResultReply(entry.interaction)));
}

// Clean up success notices when a claim channel is deleted outside the bot
// (e.g., by staff). Unrelated channel deletion events do nothing.
export async function removeClaimSuccessNoticesForChannel(client, channelId) {
  const byClaim = pendingSuccessNotices.get(client);
  if (!byClaim || !channelId) return;
  const interactions = [];
  for (const [key, notices] of byClaim) {
    for (const entry of notices) {
      if (entry.channelId !== channelId) continue;
      notices.delete(entry);
      interactions.push(entry.interaction);
    }
    if (!notices.size) byClaim.delete(key);
  }
  await Promise.all(interactions.map(deleteClaimResultReply));
}

// Denied notices still disappear after 20 seconds. Successful notices have
// no bot timer; the separate 24-hour claim-channel expiry remains unchanged.
async function claimResultNotice(interaction, channelId = null, client = null, messageId = null) {
  const success = Boolean(channelId);
  await interaction.editReply({
    content: null,
    embeds: [{
      title: success ? 'Claim successful!' : 'Claim denied',
      description: success
        ? "You've been tagged in <#" + channelId + "> to collect your prize!"
        : 'This button is reserved for giveaway winners only. You are not eligible to claim this prize.',
      color: success ? 0x00C49D : CLOUDY_RED_COLOR,
      // Keep the Cloudy logo INSIDE the embed for both Claim outcomes.
      thumbnail: { url: CLOUDY_C_LOGO_URL },
    }],
    components: [],
    allowedMentions: { parse: [] },
  });
  if (success) {
    if (client && messageId) {
      pendingNotices(client, messageId, interaction.user.id, true)
        .notices.add({ interaction, channelId });
    }
    return;
  }
  const timer = setTimeout(() => {
    void deleteClaimResultReply(interaction);
  }, CLAIM_DENIED_NOTICE_MS);
  timer.unref?.();
}

// Shared with the giveaway Code form (GIVEAWAY_CLAIM_ENCRYPTION_KEY).
const secretKey = hasGiveawayCodeKey;
const protect = protectGiveawayCode;
const reveal = revealGiveawayCode;

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
  // Button emoji IDs are the same white Cloudy artwork as the embed.
  const buttonEmoji = markup => {
    const match = /^<:([A-Za-z0-9_]+):([0-9]+)>$/.exec(markup || '');
    return match ? { name: match[1], id: match[2] } : null;
  };
  const revealButton = new ButtonBuilder()
    .setCustomId('gclaim:reveal:' + giveaway.messageId + ':' + userId)
    .setLabel('Reveal my code').setStyle(ButtonStyle.Secondary);
  const closeButton = new ButtonBuilder()
    .setCustomId('gclaim:done:' + giveaway.messageId + ':' + userId)
    .setLabel('Close').setStyle(ButtonStyle.Secondary);
  const key = buttonEmoji(icons.key);
  const check = buttonEmoji(icons.check);
  if (key) revealButton.setEmoji(key);
  if (check) closeButton.setEmoji(check);
  // A giveaway without a code (outside the website) has nothing to reveal.
  const buttons = requiresCountry(giveaway) ? [closeButton] : [revealButton, closeButton];

  return {
    content: '<@' + userId + '>',
    embeds: [buildPrivateClaimEmbed(giveaway, userId, icons)],
    components: [new ActionRowBuilder().addComponents(...buttons)],
    allowedMentions: { parse: [], users: [userId] },
  };
}

// Runs inside the giveaway's own lock (Claim or Reveal). The same winner
// always keeps the same added code.
async function takeAddedGiveawayCode(client, guildId, giveaway, userId) {
  const taken = takeAddedCode(giveaway, userId);
  if (taken.changed && !await saveGiveaway(client, guildId, taken.giveaway)) {
    throw new Error('Could not save the added giveaway code');
  }
  return taken.code;
}

async function openClaim(interaction, client, messageId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const userId = interaction.user.id;
  // Same lock as the 24-hour reroll: claiming and replacing a winner are
  // serialized, including clicks that arrive exactly at the deadline.
  return Mutex.runExclusive('giveaway:' + messageId, async () => {
    const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
    if (!giveaway || !giveaway.ended || !giveaway.winnerIds?.includes(userId)) {
      await claimResultNotice(interaction);
      return;
    }
    const prior = await findClaim(client, guild.id, messageId, userId);
    if (prior?.closedAt) return notice(interaction, 'This prize claim has already closed.');
    if (prior?.channelId) {
      const current = await guild.channels.fetch(prior.channelId).catch(() => null);
      if (current) {
        await claimResultNotice(interaction, current.id, client, messageId);
        return;
      }
    }
    const deadline = Date.parse(giveaway.claimDeadlineAt || '');
    if (Number.isFinite(deadline) && deadline <= Date.now()) {
      await claimResultNotice(interaction);
      return;
    }

    // The giveaway winner gets a new private text channel in this category,
    // not in the public ticket category and never inside a public text channel.
    const category = await guild.channels.fetch(GIVEAWAY_CLAIM_CATEGORY_ID).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      logger.warn('Giveaway claim category is missing or not a category', {
        guildId: guild.id, categoryId: GIVEAWAY_CLAIM_CATEGORY_ID,
      });
      return notice(interaction, 'The giveaway claim category is unavailable. Please contact staff.');
    }
    const config = await getGuildConfig(client, guild.id).catch(() => ({}));
    const staffRoleId = config.ticketStaffRoleId;
    // The channel carries the giveaway's own number (as in #giveaway-logs).
    const giveawayNumber = Number.isSafeInteger(giveaway.giveawayNumber) && giveaway.giveawayNumber > 0
      ? giveaway.giveawayNumber
      : await getOrCreateGiveawayNumber(client, guild.id, messageId).catch(() => null);
    const channel = await guild.channels.create({
      name: 'giveaway-claim-' + (giveawayNumber || userId.slice(-6)),
      type: ChannelType.GuildText,
      parent: category.id,
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
    // A website giveaway gives this winner a new CLOUDY- code, or the next
    // unused code staff added; stored encrypted when the key is configured.
    const prizeCode = givesGeneratedCode(giveaway) ? generateGiveawayCode(giveaway)
      : usesAddedCodes(giveaway) ? await takeAddedGiveawayCode(client, guild.id, giveaway, userId) : null;
    const sealed = prizeCode ? sealGiveawayCode(prizeCode) : { encryptedCode: null, code: null };
    const record = {
      messageId, userId, channelId: channel.id, createdAt: new Date().toISOString(),
      revealedAt: null, expiresAt: new Date(Date.now() + CLAIM_LIFETIME_MS).toISOString(),
      encryptedCode: sealed.encryptedCode, closedAt: null,
      ...(sealed.code ? { code: sealed.code } : {}),
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
    await claimResultNotice(interaction, channel.id, client, messageId);
    logClaimAction(client, guild, {
      event: 'opened', messageId, userId, claimChannelId: channel.id, giveaway,
    });
  });
}

async function finishClaim(interaction, client, messageId, userId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== userId) {
    return notice(interaction, 'Only the winner can close their prize claim.');
  }
  return Mutex.runExclusive('gclaim-take:' + interaction.guildId + ':' + messageId + ':' + userId, async () => {
    const record = await findClaim(client, interaction.guildId, messageId, userId);
    if (!record || record.channelId !== interaction.channelId || record.closedAt) {
      return notice(interaction, 'This claim channel is no longer active.');
    }
    if (!interaction.channel?.delete) {
      return notice(interaction, 'The claim channel could not be closed. Please contact staff.');
    }
    // Save state before deletion to prevent double processing if the interaction
    // is repeated. If Discord rejects the deletion, undo that state for retry.
    const closed = { ...record, closedAt: new Date().toISOString(), encryptedCode: null, code: null };
    await saveClaim(client, interaction.guildId, closed);
    try {
      await interaction.channel.delete('Winner selected Close on giveaway claim');
    } catch (error) {
      await saveClaim(client, interaction.guildId, record);
      throw error;
    }
    await deletePendingSuccessNotices(client, messageId, userId);
    logClaimAction(client, interaction.guild, {
      event: 'closed', messageId, userId, claimChannelId: record.channelId,
      giveaway: await loadGiveaway(client, interaction.guildId, messageId).catch(() => null),
    });
    return notice(interaction, 'Your prize claim has been closed. Thank you!').catch(() => {});
  });
}

// Discord does not expose spoiler taps. Reveal is an explicit button, so it
// can return only to the winner and never restarts the 24h channel deadline.
async function revealClaimCode(interaction, client, messageId, userId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== userId) {
    return notice(interaction, 'Only the winner can reveal this code.');
  }
  return Mutex.runExclusive('gclaim-take:' + interaction.guildId + ':' + messageId + ':' + userId, async () => {
    const record = await findClaim(client, interaction.guildId, messageId, userId);
    if (!record || record.channelId !== interaction.channelId || record.closedAt
      || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) {
      return notice(interaction, 'This claim channel is no longer active.');
    }

    // A configured real code stays encrypted in storage, and is shown only in
    // this winner's ephemeral response. Never silently replace an unavailable
    // encrypted prize code with a demo.
    if (record.encryptedCode) {
      const code = reveal(record.encryptedCode);
      if (!code) return notice(interaction,
        'Your prize code could not be decrypted. Please contact giveaway staff.');
      if (!record.revealedAt) {
        await saveClaim(client, interaction.guildId, { ...record, revealedAt: new Date().toISOString() });
      }
      await notice(interaction, code);
      logClaimAction(client, interaction.guild, {
        event: 'revealed', messageId, userId, claimChannelId: record.channelId,
        giveaway: await loadGiveaway(client, interaction.guildId, messageId).catch(() => null),
      });
      return;
    }

    const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
    if (!giveaway) return notice(interaction, 'The giveaway could not be found.');
    if (requiresCountry(giveaway)) {
      return notice(interaction, 'This prize has no code. Our team will contact you in this channel.');
    }
    // Without the encryption key the code is kept in the private claim record.
    let code = typeof record.code === 'string' && record.code ? record.code : null;
    // No added code was left when this winner opened the claim: staff may
    // have added more since.
    if (!code && usesAddedCodes(giveaway)) {
      code = await Mutex.runExclusive('giveaway:' + messageId, async () => {
        const current = await loadGiveaway(client, interaction.guildId, messageId);
        return current ? takeAddedGiveawayCode(client, interaction.guildId, current, userId) : null;
      });
      if (!code) return notice(interaction, 'Your code is not ready yet. Our team will add it soon.');
      await saveClaim(client, interaction.guildId, {
        ...record, ...sealGiveawayCode(code), revealedAt: record.revealedAt || new Date().toISOString(),
      });
    } else if (code && !record.revealedAt) {
      await saveClaim(client, interaction.guildId, { ...record, revealedAt: new Date().toISOString() });
    }
    if (code) {
      await notice(interaction, code);
      logClaimAction(client, interaction.guild, {
        event: 'revealed', messageId, userId, claimChannelId: record.channelId, giveaway,
      });
      return;
    }
    const demo = displayDemoClaimCode(giveaway, userId);
    await notice(interaction, demo);
    logClaimAction(client, interaction.guild, {
      event: 'revealed', messageId, userId, claimChannelId: record.channelId, giveaway,
    });
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
    await notice(interaction, 'Code revealed in your private channel. Automatic deletion: <t:'
      + Math.floor((now + CLAIM_LIFETIME_MS) / 1000) + ':F>.');
    logClaimAction(client, interaction.guild, {
      event: 'revealed', messageId, userId, claimChannelId: record.channelId,
      giveaway: await loadGiveaway(client, interaction.guildId, messageId).catch(() => null),
    });
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
    if (action === 'reveal' && messageId && userId) return await revealClaimCode(interaction, client, messageId, userId);
    if (action === 'done' && messageId && userId) return await finishClaim(interaction, client, messageId, userId);
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
        await saveClaim(client, guild.id, { ...current, closedAt: new Date().toISOString(), encryptedCode: null, code: null });
        await deletePendingSuccessNotices(client, current.messageId, current.userId);
        logClaimAction(client, guild, {
          event: 'expired', messageId: current.messageId, userId: current.userId,
          claimChannelId: current.channelId,
          giveaway: await loadGiveaway(client, guild.id, current.messageId).catch(() => null),
        });
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
        // Keep already-open claim channels under the dedicated giveaway-claim
        // category as well. lockPermissions:false preserves their private
        // winner/staff permission overwrites when moving.
        if (channel.parentId !== undefined && channel.parentId !== GIVEAWAY_CLAIM_CATEGORY_ID
          && typeof channel.setParent === 'function') {
          const category = await guild.channels.fetch(GIVEAWAY_CLAIM_CATEGORY_ID).catch(() => null);
          if (category?.type === ChannelType.GuildCategory) {
            await channel.setParent(category.id, { lockPermissions: false });
          }
        }
        const expectedIds = [
          'gclaim:take:' + record.messageId + ':' + record.userId,
          'gclaim:done:' + record.messageId + ':' + record.userId,
          'gclaim:reveal:' + record.messageId + ':' + record.userId,
        ];
        const isPanel = message => Boolean(message?.author?.id === client.user?.id
          && (message.id === record.panelMessageId || message.components?.some(row =>
            row.components?.some(button =>
              expectedIds.includes(button.customId || button.custom_id || button.data?.custom_id)))));
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
        // Existing channels created before the demo spoiler change must also
        // expire 24 hours after opening; never extend an existing deadline.
        let updatedRecord = record;
        if (!record.expiresAt) {
          const started = Date.parse(record.createdAt);
          const deadline = new Date((Number.isFinite(started) ? started : Date.now()) + CLAIM_LIFETIME_MS).toISOString();
          updatedRecord = { ...record, expiresAt: deadline };
          await saveClaim(client, guild.id, updatedRecord);
        }
        const panel = claimPanel({ ...giveaway, guildId: guild.id }, record.userId, await getGiveawayClaimIcons(client));
        await message.edit({
          embeds: panel.embeds,
          components: panel.components,
          allowedMentions: { parse: [] },
        });
        if (record.panelMessageId !== message.id) {
          await saveClaim(client, guild.id, { ...updatedRecord, panelMessageId: message.id });
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
  void checkUnclaimedGiveawayWinners(client).catch(error => logger.warn('Initial automatic giveaway claim reroll failed', error));
  void getGiveawayClaimIcons(client).catch(error => logger.warn('Could not prewarm white claim icons', error));
  void refreshExistingClaimPanels(client).catch(error => logger.warn('Initial giveaway claim panel refresh failed', error));
  const timer = setInterval(() => {
    void cleanupExpiredGiveawayClaims(client).catch(error => logger.warn('Giveaway claim cleanup failed', error));
    void checkUnclaimedGiveawayWinners(client).catch(error => logger.warn('Automatic giveaway claim reroll failed', error));
  }, 60_000);
  timer.unref?.();
}
