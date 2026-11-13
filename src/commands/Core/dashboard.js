import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { planState } from '../../web/dashboardApi.js';

const DEFAULT_SITE = 'https://cloudy-store-vert.vercel.app';

/** This server's page on the Cloudy Bot dashboard. */
export function dashboardLink(guildId, env = process.env) {
  let origin = DEFAULT_SITE;
  try {
    const url = new URL(String(env.CLOUDY_DASHBOARD_URL || DEFAULT_SITE));
    if (url.protocol === 'https:') origin = url.origin;
  } catch { /* keep the default */ }
  return `${origin}/bot/${guildId}`;
}

export function planLine(plan) {
  if (plan.status === 'premium') return `Premium is active until <t:${Math.floor(Date.parse(plan.until) / 1000)}:D>.`;
  if (plan.status === 'trial') return `Saving works until <t:${Math.floor(Date.parse(plan.until) / 1000)}:D>. After that saving needs Premium.`;
  if (plan.status === 'expired') return 'Premium has ended. You can view every setting; saving needs Premium (€13 per month per server).';
  return 'You can view every setting. Saving changes needs Cloudy Bot Premium (€13 per month per server).';
}

export default {
  data: new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Open the Cloudy Bot dashboard for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    try {
      const record = await interaction.client.db?.get?.(`guild:${interaction.guildId}:dashboard:plan`, null).catch?.(() => null) ?? null;
      const plan = planState(record, { nowMs: Date.now() });
      const button = new ButtonBuilder().setLabel('Open the dashboard').setStyle(ButtonStyle.Link).setURL(dashboardLink(interaction.guildId));
      await InteractionHelper.safeReply(interaction, {
        embeds: [createEmbed({
          title: 'Cloudy Bot dashboard',
          description: `Set Cloudy up for **${interaction.guild?.name || 'this server'}**: tickets, welcome messages, logs, verification and more. Log in with Discord; only the owner, Administrators and members with Manage Server can open it.\n\n${planLine(plan)}`,
        })],
        components: [new ActionRowBuilder().addComponents(button)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Dashboard command error:', error);
      await InteractionHelper.safeReply(interaction, {
        embeds: [createEmbed({ title: 'Error', description: 'The dashboard link could not be shown. Please try again.', color: 'error' })],
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
  },
};
