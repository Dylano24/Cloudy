import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

const INVITE_LOG_CHANNEL_ID = '1539371572442435646';
const inviteCache = new Map();

function snapshotInvite(invite) {
  return {
    code: invite.code,
    uses: invite.uses || 0,
    inviterId: invite.inviter?.id || null,
    channelId: invite.channelId || invite.channel?.id || null,
    maxUses: invite.maxUses || 0,
    maxAge: invite.maxAge || 0,
    temporary: Boolean(invite.temporary),
    createdTimestamp: invite.createdTimestamp || Date.now(),
    expiresTimestamp: invite.expiresTimestamp || null,
  };
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

  return channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  }).catch(error => {
    logger.error('Failed to send invite log:', error);
    return null;
  });
}

export async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(
      guild.id,
      new Map(invites.map(invite => [invite.code, snapshotInvite(invite)])),
    );
    return true;
  } catch (error) {
    logger.warn(`Could not cache invites for guild ${guild.id}: ${error.message}`);
    return false;
  }
}

export async function initializeInviteTracking(client) {
  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
  }
  logger.info(`Invite tracking initialized for ${inviteCache.size} guild(s)`);
}

let inviteMonitor = null;

async function checkForNewInvites(client) {
  for (const guild of client.guilds.cache.values()) {
    const previous = inviteCache.get(guild.id);
    if (!previous) {
      await cacheGuildInvites(guild);
      continue;
    }

    let invites;
    try {
      invites = await guild.invites.fetch();
    } catch (error) {
      logger.warn(`Could not poll invites for guild ${guild.id}: ${error.message}`);
      continue;
    }

    for (const invite of invites.values()) {
      if (!previous.has(invite.code)) {
        await recordInviteCreated(invite);
      }
    }

    inviteCache.set(
      guild.id,
      new Map(invites.map(invite => [invite.code, snapshotInvite(invite)])),
    );
  }
}

export async function startInviteTracking(client) {
  await initializeInviteTracking(client);

  if (inviteMonitor) return;

  inviteMonitor = setInterval(() => {
    void checkForNewInvites(client);
  }, 10_000);
  inviteMonitor.unref?.();

  logger.info('Invite creation monitor started');
}

export async function recordInviteCreated(invite) {
  const guild = invite.guild;
  if (!guild) return;

  let cached = inviteCache.get(guild.id);
  if (!cached) {
    cached = new Map();
    inviteCache.set(guild.id, cached);
  }
  cached.set(invite.code, snapshotInvite(invite));

  const inviter = invite.inviter;
  const embed = new EmbedBuilder()
    .setColor(0x5DADE2)
    .setTitle('Invite Created')
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

  if (inviter) {
    embed.setThumbnail(inviter.displayAvatarURL({ size: 256 }));
  }

  await sendInviteLog(guild, embed);
}

export async function recordInviteDeleted(invite) {
  const cached = inviteCache.get(invite.guild?.id);
  cached?.delete(invite.code);
}

export async function trackMemberInvite(member) {
  const guild = member.guild;
  const previous = inviteCache.get(guild.id) || new Map();

  let currentInvites;
  try {
    currentInvites = await guild.invites.fetch();
  } catch (error) {
    logger.warn(`Could not fetch invites after member join in ${guild.id}: ${error.message}`);
    return;
  }

  const current = new Map(
    currentInvites.map(invite => [invite.code, snapshotInvite(invite)]),
  );

  const usedInvite = currentInvites.find(invite => {
    const oldUses = previous.get(invite.code)?.uses || 0;
    return (invite.uses || 0) > oldUses;
  });

  inviteCache.set(guild.id, current);

  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  const accountAgeDays = Math.max(0, Math.floor(accountAgeMs / 86_400_000));
  const riskLabel = accountAgeDays < 7
    ? '🔴 Very new account'
    : accountAgeDays < 30
      ? '🟡 New account'
      : '🟢 Established account';

  const inviter = usedInvite?.inviter;
  const embed = new EmbedBuilder()
    .setColor(accountAgeDays < 7 ? 0xED4245 : accountAgeDays < 30 ? 0xFEE75C : 0x57F287)
    .setTitle('Member Joined Using Invite')
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
        name: 'Invite code',
        value: usedInvite ? `\`${usedInvite.code}\`` : 'Unknown',
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
