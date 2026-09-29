import {
  ChannelType,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const TARGET_GUILD_ID = '1532882647838228723';
const RESTORE_KEY = 'global:cloudy:server-structure-restore:2026-09-29:v1';

const CATEGORY_LAYOUT = [
  {
    name: '— Introduction —',
    mode: 'readOnly',
    channels: [
      ['👋│welcome', 'text'],
    ],
  },
  {
    name: '— Server informations —',
    mode: 'readOnly',
    channels: [
      ['📜│rules', 'text'],
      ['⚙️│settings', 'text'],
      ['🧴│wipes', 'text'],
      ['🔁│restart', 'text'],
      ['🌐│population', 'text'],
      ['❓│faq', 'text'],
      ['📄｜termes-of-services', 'text'],
      ['🔐｜privacy-policy', 'text'],
      ['📄│terms-of-sale', 'text'],
    ],
  },
  {
    name: '— Server notifications —',
    mode: 'readOnly',
    channels: [
      ['📢│announcements', 'text'],
      ['📌│next-wipe', 'text'],
      ['📡│server-status', 'text'],
      ['🗳️│votes', 'text'],
    ],
  },
  {
    name: '→ Shop & Abonnements ←',
    mode: 'readOnly',
    channels: [
      ['🏆｜vip', 'text'],
      ['🏎️｜queue-skip', 'text'],
      ['🎬｜content-creator', 'text'],
      ['🛍️｜cloudy-official-store', 'text'],
    ],
  },
  {
    name: '→ Rewards ←',
    mode: 'readOnly',
    channels: [
      ['🥇｜leaderboard', 'text'],
      ['🎉｜giveaway', 'text'],
      ['🔹｜boost', 'text'],
    ],
  },
  {
    name: '→ Love & Community support ←',
    mode: 'readOnly',
    channels: [
      ['🫙｜tip-jar', 'text'],
      ['✨｜staff-reviews', 'text'],
      ['⭐｜posted-reviews', 'text'],
    ],
  },
  {
    name: '→ Chats ←',
    mode: 'public',
    channels: [
      ['💬｜general', 'text'],
      ['🎲｜gambling', 'text'],
      ['🛒｜shop', 'text'],
      ['📷｜media', 'text'],
      ['👀｜team-up', 'voice'],
      ['💡｜suggestions', 'voice'],
    ],
  },
  {
    name: '→ Post your contents ←',
    mode: 'public',
    channels: [
      ['▶️｜youtube', 'text'],
      ['🟣｜twitch', 'text'],
      ['🎵｜tiktok', 'text'],
      ['ℹ️｜informations', 'text'],
    ],
  },
  {
    name: '→ Guides ←',
    mode: 'readOnly',
    channels: [
      ['🛡️｜zorp-off-raid-protection', 'text'],
    ],
  },
  {
    name: '→ Feeds ←',
    mode: 'readOnly',
    channels: [
      ['📰｜patch-notes', 'text'],
      ['🛰️｜nitrado-patch-notes', 'text'],
    ],
  },
  {
    name: '→ Vocals ←',
    mode: 'public',
    channels: [
      ['Duo', 'voice'],
      ['Trio', 'voice'],
      ['Squad', 'voice'],
      ['Join for create & set it up', 'voice'],
    ],
  },
  {
    name: '→ Support & help ←',
    mode: 'readOnly',
    channels: [
      ['📌｜staff-list', 'text'],
      ['✉️｜contact-support', 'text'],
      ['📮｜appeal-form', 'text'],
      ['🛡️｜security-information', 'text'],
    ],
  },
  {
    name: '→ Tickets ←',
    mode: 'privateStaff',
    channels: [],
  },
  {
    name: '→ Owner ←',
    mode: 'privateStaff',
    channels: [
      ['🤖｜bot-commands', 'text'],
      ['⛔｜ban-logs', 'text'],
      ['💢｜kick-logs', 'text'],
      ['⏱️｜timeout-logs', 'text'],
      ['📩｜invitation-logs', 'text'],
      ['📊｜reports', 'text'],
      ['📨｜ban-timeout-appeals', 'text'],
      ['🛠️｜FIX-GUIDE', 'text'],
      ['🧾｜botlog-commands', 'text'],
    ],
  },
  {
    name: '→ Tickets feed ←',
    mode: 'privateStaff',
    channels: [
      ['🧾｜ticket-logs', 'text'],
      ['📄｜ticket-transcripts', 'text'],
    ],
  },
];

function normalize(value = '') {
  const raw = String(value).trim().toLowerCase();
  const afterSeparator = raw.includes('│') ? raw.split('│').at(-1) : raw;
  return afterSeparator
    .normalize('NFKD')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findStaffRoles(guild) {
  const names = new Set(['founder', 'owner', 'staff', 'support', 'moderator', 'admin', 'administrator']);
  return [...guild.roles.cache.values()].filter(role => names.has(role.name.trim().toLowerCase()));
}

function categoryOverwrites(guild, mode) {
  const botId = guild.members.me?.id;
  const base = [];

  if (mode === 'readOnly') {
    base.push({
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.SendMessages],
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  if (mode === 'privateStaff') {
    base.push({
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    });
    for (const role of findStaffRoles(guild)) {
      base.push({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      });
    }
  }

  if (botId && mode !== 'public') {
    base.push({
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  return base;
}

function findCategory(guild, wantedName) {
  const wanted = normalize(wantedName);
  return [...guild.channels.cache.values()]
    .filter(channel => channel.type === ChannelType.GuildCategory)
    .find(channel => normalize(channel.name) === wanted) || null;
}

function findExistingChannel(guild, wantedName, type) {
  const wanted = normalize(wantedName);
  const expectedType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;

  return [...guild.channels.cache.values()]
    .filter(channel => channel.type === expectedType)
    .find(channel => normalize(channel.name) === wanted) || null;
}

async function ensureCategory(guild, spec, summary) {
  let category = findCategory(guild, spec.name);
  if (!category) {
    category = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: categoryOverwrites(guild, spec.mode),
      reason: 'Restore deleted Cloudy server structure',
    });
    summary.createdCategories.push(category.name);
  }

  for (const [name, kind] of spec.channels) {
    let channel = findExistingChannel(guild, name, kind);
    if (!channel) {
      channel = await guild.channels.create({
        name,
        type: kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: category.id,
        reason: 'Restore deleted Cloudy server channel',
      });
      summary.createdChannels.push(channel.name);
    } else if (channel.parentId !== category.id) {
      await channel.setParent(category.id, { lockPermissions: false, reason: 'Restore Cloudy channel placement' }).catch(() => null);
      summary.reparentedChannels.push(channel.name);
    }
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const guild = client.guilds.cache.get(TARGET_GUILD_ID)
      || await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
    if (!guild) {
      logger.warn('[CLOUDY_RESTORE] Target guild is unavailable.');
      return;
    }

    const alreadyCompleted = client.db?.get
      ? await client.db.get(RESTORE_KEY).catch(() => null)
      : null;
    if (alreadyCompleted) {
      logger.info('[CLOUDY_RESTORE] Server structure restore already completed.');
      return;
    }

    await guild.channels.fetch().catch(() => null);
    await guild.roles.fetch().catch(() => null);

    const summary = {
      createdCategories: [],
      createdChannels: [],
      reparentedChannels: [],
    };

    try {
      for (const spec of CATEGORY_LAYOUT) {
        await ensureCategory(guild, spec, summary);
      }

      if (client.db?.set) {
        await client.db.set(RESTORE_KEY, {
          completedAt: new Date().toISOString(),
          ...summary,
        }).catch(() => null);
      }

      logger.warn(
        `[CLOUDY_RESTORE] Restore complete: ${summary.createdCategories.length} categories, `
        + `${summary.createdChannels.length} channels, ${summary.reparentedChannels.length} moved.`,
      );
    } catch (error) {
      logger.error('[CLOUDY_RESTORE] Server structure restore failed before completion:', error);
    }
  },
};
