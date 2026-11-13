import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { buildRulesEmbed, rulesOf } from '../../services/serverRules.js';
import { dashboardLink } from '../Core/dashboard.js';

// /rules shows the server's own rules from the dashboard. Anyone can read them
// privately; members with Manage Server can post them in the channel.

export default {
  data: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Show the rules of this server')
    .addBooleanOption(option => option
      .setName('post')
      .setDescription('Post the rules in this channel for everyone (Manage Server)'))
    .setDMPermission(false),

  async execute(interaction) {
    try {
      const post = interaction.options.getBoolean('post') === true;
      if (post && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await InteractionHelper.safeReply(interaction, {
          embeds: [createEmbed({ title: 'Rules', description: 'Posting the rules for everyone needs the Manage Server permission. Leave `post` off to read them yourself.', color: 'error' })],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const config = await getGuildConfig(interaction.client, interaction.guildId);
      const embed = buildRulesEmbed({ rules: rulesOf(config), guild: interaction.guild });
      if (!embed) {
        const canEdit = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        await InteractionHelper.safeReply(interaction, {
          embeds: [createEmbed({
            title: 'Rules',
            description: canEdit
              ? `This server has no rules yet. Write them on the dashboard under **Server rules**: ${dashboardLink(interaction.guildId)}`
              : 'This server has no rules in Cloudy yet. Ask the server staff.',
          })],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await InteractionHelper.safeReply(interaction, {
        embeds: [embed],
        allowedMentions: { parse: [] },
        ...(post ? {} : { flags: MessageFlags.Ephemeral }),
      });
    } catch (error) {
      logger.error('Rules command error:', error);
      await InteractionHelper.safeReply(interaction, {
        embeds: [createEmbed({ title: 'Error', description: 'The rules could not be shown. Please try again.', color: 'error' })],
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
  },
};
