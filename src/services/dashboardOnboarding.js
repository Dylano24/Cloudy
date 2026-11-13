// First-time setup message when Cloudy joins a customer's server: one embed
// with a link to that server's page on the Cloudy Store dashboard. Off until
// CLOUDY_DASHBOARD_URL is set; never sent in Cloudy's own server (GUILD_ID);
// sent once per server (a re-invite does not repeat it).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';

const onboardingKey = guildId => `guild:${guildId}:dashboard:onboarding`;
const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

/** The dashboard page for a server, or null when the website address is not configured. */
export function dashboardSetupUrl(guildId, env = process.env) {
  const raw = String(env.CLOUDY_DASHBOARD_URL || '').trim();
  if (!raw || !/^\d{17,20}$/.test(String(guildId))) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return `${url.origin}/bot/${guildId}`;
  } catch {
    return null;
  }
}

function canPost(channel, me) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const permissions = channel.permissionsFor?.(me);
  return Boolean(permissions && NEEDED.every(flag => permissions.has(flag)));
}

/** The server's system channel when Cloudy may post there, else the first text channel it may post in. */
export function pickSetupChannel(guild) {
  const me = guild.members?.me;
  if (!me) return null;
  if (canPost(guild.systemChannel, me)) return guild.systemChannel;
  const channels = [...(guild.channels?.cache?.values?.() || [])]
    .filter(channel => canPost(channel, me))
    .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));
  return channels[0] || null;
}

export function setupMessage(guild, url) {
  const embed = createEmbed({
    title: 'Thanks for adding Cloudy',
    description: [
      `Set Cloudy up for **${guild.name}** on the website: log channels, welcome messages, tickets, verification and more. Every change applies in Discord right away.`,
      '',
      'Only the server owner, Administrators and members with Manage Server can open it. The 7-day free trial starts with your first saved change.',
    ].join('\n'),
  });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open the dashboard').setStyle(ButtonStyle.Link).setURL(url));
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

export async function sendSetupWelcome(guild, client, { env = process.env } = {}) {
  const homeGuild = String(env.GUILD_ID || '').trim();
  if (!guild?.id || (homeGuild && guild.id === homeGuild)) return { sent: false, reason: 'home_guild' };
  const url = dashboardSetupUrl(guild.id, env);
  if (!url) return { sent: false, reason: 'not_configured' };
  const previous = await client.db?.get?.(onboardingKey(guild.id), null);
  if (previous?.sentAt) return { sent: false, reason: 'already_sent' };
  const channel = pickSetupChannel(guild);
  if (!channel) return { sent: false, reason: 'no_channel' };
  const message = await channel.send(setupMessage(guild, url));
  await client.db?.set?.(onboardingKey(guild.id), { sentAt: new Date().toISOString(), channelId: channel.id, messageId: message?.id || null });
  logger.info(`[ONBOARDING] Setup message sent in ${guild.id}`);
  return { sent: true, channelId: channel.id };
}
