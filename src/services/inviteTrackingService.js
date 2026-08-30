import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { decorateEmbedWithSavedTemplate } from './embedTemplateService.js';
import { registerCloudyEmbedMessage } from './embedRegistryService.js';
import { logger } from '../utils/logger.js';

const INVITE_LOG_CHANNEL_ID = '1539371572442435646';
const DELETED_INVITE_TTL_MS = 20_000;
const inviteCache = new Map();
const recentlyDeletedInvites = new Map();
const inviteQueues = new Map();

function snapshotInvite(invite) {
  return {
    code: invite.code,
    uses: invite.uses || 0,
    inviterId: invite.inviter?.id || invite.inviterId || null,
    channelId: invite.channelId || invite.channel?.id || null,
    maxUses: invite.maxUses || 0,
    maxAge: invite.maxAge || 0,
    temporary: Boolean(invite.temporary),
    createdTimestamp: invite.createdTimestamp || Date.now(),
    expiresTimestamp: invite.expiresTimestamp || null,
  };
}

async function withInviteLock(guildId, task) {
  const key = String(guildId);
  const previous = inviteQueues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(task);

  inviteQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (inviteQueues.get(key) === current) inviteQueues.delete(key);
  }
}

function deletedInviteMap(guildId) {
  const key = String(guildId);
  let deleted = recentlyDeletedInvites.get(key);
  if (!deleted) {
    deleted = new Map();
    recentlyDeletedInvites.set(key, deleted);
  }
  return deleted;
}

function pruneDeletedInvites(guildId, now = Date.now()) {
  const key = String(guildId);
  const deleted = recentlyDeletedInvites.get(key);
  if (!deleted) return;

  for (const [code, invite] of deleted) {
    if (now - Number(invite.deletedAt || 0) > DELETED_INVITE_TTL_MS) deleted.delete(code);
  }
  if (!deleted.size) recentlyDeletedInvites.delete(key);
}

function formatExpiry(invite) {
  if (!invite.expiresTimestamp) return 'Never';
  return `<t:${Math.floor(invite.expiresTimestamp / 1000)}:F> (<t:${Math.floor(invite.expiresTimestamp / 1000)}:R>)`;
}

async function getLogChannel(guild) {
  const channel = guild.channels.cache.get(INVITE_LOG_CHANNEL_ID)
    || await guild.channels.fetch(INVITE_LOG_CHANNEL_ID).catch(() => null);

  if (!channel?.isTextBased?.()) {
    logger.warn(`Invite log channel not found: ${INVITE_LOG_CHANNEL_ID}`);
    return null;
  }

  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) {
    logger.warn(`Missing permissions in invite log channel: ${INVITE_LOG_CHANNEL_ID}`);
    return null;
  }

  return channel;
}

async function sendInviteLog(guild, embed) {
  const channel = await getLogChannel(guild);
  if (!channel) return null;

  let finalEmbed = embed;
  try {
    const decorated = await decorateEmbedWithSavedTemplate(guild.id, channel.id, embed);
    finalEmbed = decorated.embed || embed;
  } catch (error) {
    logger.error('Failed to apply saved invite log template:', error);
  }

  const sent = await channel.send({
    embeds: [finalEmbed],
    allowedMentions: { parse: [] },
  }).catch(error => {
    logger.error('Failed to send invite log:', error);
    return null;
  });

  if (sent) {
    await registerCloudyEmbedMessage(sent, 'invite-tracking').catch(error => {
      logger.error('Failed to register invite log embed:', error);
    });
  }
  return sent;
}

export async function cacheGuildInvites(guild) {
  let invites;
  try {
    invites = await guild.invites.fetch();
  } catch (error) {
    logger.warn(`Could not cache invites for guild ${guild.id}: ${error.message}`);
    return false;
  }

  await withInviteLock(guild.id, async () => {
    inviteCache.set(
      guild.id,
      new Map([...invites.values()].map(invite => [invite.code, snapshotInvite(invite)])),
    );
    recentlyDeletedInvites.delete(String(guild.id));
  });
  return true;
}

export async function initializeInviteTracking(client) {
  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
  }
  logger.info(`Invite tracking initialized for ${inviteCache.size} guild(s)`);
}

export async function recordInviteCreated(invite) {
  const guild = invite.guild;
  if (!guild) return;

  await withInviteLock(guild.id, async () => {
    let cached = inviteCache.get(guild.id);
    if (!cached) {
      cached = new Map();
      inviteCache.set(guild.id, cached);
    }

    cached.set(invite.code, snapshotInvite(invite));
    deletedInviteMap(guild.id).delete(invite.code);
    pruneDeletedInvites(guild.id);
  });

  const inviter = invite.inviter;
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('Invite created')
    .addFields(
      {
        name: 'Created by',
        value: inviter ? `${inviter} (${inviter.tag})\nID: \`${inviter.id}\`` : 'Unknown',
        inline: false,
      },
      {
        name: 'Invite',
        value: `https://discord.gg/${invite.code}`,
        inline: false,
      },
      {
        name: 'Channel',
        value: invite.channel ? `${invite.channel}` : (invite.channelId ? `<#${invite.channelId}>` : 'Unknown'),
        inline: false,
      },
      {
        name: 'Maximum uses',
        value: invite.maxUses ? String(invite.maxUses) : 'Unlimited',
        inline: false,
      },
      {
        name: 'Expires',
        value: formatExpiry(invite),
        inline: false,
      },
      {
        name: 'Created',
        value: `<t:${Math.floor((invite.createdTimestamp || Date.now()) / 1000)}:F>`,
        inline: false,
      },
    )
    .setFooter({ text: 'Cloudy Invite Tracking' })
    .setTimestamp();

  if (inviter) embed.setThumbnail(inviter.displayAvatarURL({ size: 256 }));
  await sendInviteLog(guild, embed);
}

export async function recordInviteDeleted(invite) {
  const guildId = invite.guild?.id;
  if (!guildId || !invite.code) return;

  await withInviteLock(guildId, async () => {
    const cached = inviteCache.get(guildId);
    const prior = cached?.get(invite.code) || snapshotInvite(invite);
    deletedInviteMap(guildId).set(invite.code, {
      ...prior,
      deletedAt: Date.now(),
    });
    cached?.delete(invite.code);
    pruneDeletedInvites(guildId);
  });
}

function detectIncreasedInvite(previous, currentInvites) {
  let best = null;
  let bestIncrease = 0;

  for (const invite of currentInvites.values()) {
    const oldUses = Number(previous.get(invite.code)?.uses || 0);
    const increase = Number(invite.uses || 0) - oldUses;
    if (increase > bestIncrease) {
      best = snapshotInvite(invite);
      bestIncrease = increase;
    }
  }
  return best;
}

function detectDeletedLastUse(guildId, previous, current, now = Date.now()) {
  pruneDeletedInvites(guildId, now);
  const candidates = new Map();
  const deleted = recentlyDeletedInvites.get(String(guildId));

  for (const invite of deleted?.values() || []) {
    if (now - Number(invite.deletedAt || 0) > DELETED_INVITE_TTL_MS) continue;
    if (invite.maxUses > 0 && Number(invite.uses || 0) >= Number(invite.maxUses) - 1) {
      candidates.set(invite.code, invite);
    }
  }

  for (const invite of previous.values()) {
    if (current.has(invite.code)) continue;
    if (invite.maxUses > 0 && Number(invite.uses || 0) >= Number(invite.maxUses) - 1) {
      candidates.set(invite.code, invite);
    }
  }

  if (candidates.size !== 1) return null;
  const invite = [...candidates.values()][0];
  return {
    ...invite,
    uses: Math.max(Number(invite.uses || 0) + 1, Number(invite.maxUses || 0)),
  };
}

async function resolveInviter(guild, inviterId) {
  if (!inviterId) return null;
  const cachedMember = guild.members.cache.get(inviterId);
  if (cachedMember?.user) return cachedMember.user;

  const fetchedMember = await guild.members.fetch(inviterId).catch(() => null);
  if (fetchedMember?.user) return fetchedMember.user;

  return guild.client.users?.cache?.get(inviterId)
    || await guild.client.users?.fetch?.(inviterId).catch(() => null)
    || null;
}

export async function trackMemberInvite(member) {
  const guild = member.guild;

  const detection = await withInviteLock(guild.id, async () => {
    const previous = new Map(inviteCache.get(guild.id) || []);

    let currentInvites;
    try {
      currentInvites = await guild.invites.fetch();
    } catch (error) {
      logger.warn(`Could not fetch invites after member join in ${guild.id}: ${error.message}`);
      return { usedInvite: null };
    }

    const current = new Map(
      [...currentInvites.values()].map(invite => [invite.code, snapshotInvite(invite)]),
    );

    const usedInvite = detectIncreasedInvite(previous, currentInvites)
      || detectDeletedLastUse(guild.id, previous, current);

    inviteCache.set(guild.id, current);
    if (usedInvite?.code) deletedInviteMap(guild.id).delete(usedInvite.code);
    pruneDeletedInvites(guild.id);
    return { usedInvite };
  });

  const usedInvite = detection?.usedInvite || null;
  const inviter = await resolveInviter(guild, usedInvite?.inviterId);
  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  const accountAgeDays = Math.max(0, Math.floor(accountAgeMs / 86_400_000));
  const riskLabel = accountAgeDays < 7
    ? '🔴 Very new account'
    : accountAgeDays < 30
      ? '🟡 New account'
      : '🟢 Established account';

  const embed = new EmbedBuilder()
    .setColor(accountAgeDays < 7 ? 0xED4245 : accountAgeDays < 30 ? 0xFEE75C : 0x57F287)
    .setTitle('Member joined using invite')
    .addFields(
      {
        name: 'Member',
        value: `${member.user} (${member.user.tag})\nID: \`${member.id}\``,
        inline: false,
      },
      {
        name: 'Invited by',
        value: inviter ? `${inviter} (${inviter.tag})\nID: \`${inviter.id}\`` : 'Unknown (vanity URL, expired invite, or missing permissions)',
        inline: false,
      },
      {
        name: 'Invite',
        value: usedInvite ? `https://discord.gg/${usedInvite.code}` : 'Unknown',
        inline: true,
      },
      {
        name: 'Invite uses',
        value: usedInvite ? String(usedInvite.uses || 0) : 'Unknown',
        inline: true,
      },
      {
        name: 'Account age',
        value: `${accountAgeDays} day${accountAgeDays === 1 ? '' : 's'}\n${riskLabel}`,
        inline: true,
      },
      {
        name: 'Account created',
        value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F> (<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>)`,
        inline: false,
      },
      {
        name: 'Joined server',
        value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
        inline: false,
      },
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Cloudy Invite Tracking • Members: ${guild.memberCount}` })
    .setTimestamp();

  await sendInviteLog(guild, embed);
}