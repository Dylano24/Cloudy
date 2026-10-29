import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { setResponseLifetime } from '../../utils/responseLifetime.js';
import {
  canGrantCurrency,
  grantCurrency,
  grantCurrencyToMembers,
  parseCurrencyAmount,
} from '../../services/currencyGrantService.js';

const amountOption = (description = 'Amount of money to give') => option => option.setName('amount')
  .setDescription(description)
  .setRequired(true).setMinValue(1);

export default {
  slashOnly: true,
  category: 'Economy',
  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Staff only: give money to a user, yourself, or everyone')
    // Visible to staff (Timeout Members); canGrantCurrency decides who may use it.
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addSubcommandGroup(group => group.setName('money')
      .setDescription('Add money to a user, yourself, or everyone')
      .addSubcommand(sub => sub.setName('user')
        .setDescription('Give cash to a selected member')
        .addUserOption(option => option.setName('user')
          .setDescription('Member who receives the cash').setRequired(true))
        .addIntegerOption(amountOption()))
      .addSubcommand(sub => sub.setName('me')
        .setDescription('Add cash to your own balance')
        .addIntegerOption(amountOption()))
      .addSubcommand(sub => sub.setName('everyone')
        .setDescription('Give the same cash amount to every non-bot member')
        .addIntegerOption(amountOption('Amount of money to give to each user')))),

  async execute(interaction, config, client) {
    // All /give money responses, including validation errors, are private
    // and follow the normal ten-second acknowledgement lifetime. Staff may
    // use it in any channel.
    setResponseLifetime(interaction, 10_000);
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    if (!canGrantCurrency(interaction, config)) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
          title: 'Permission denied',
          description: 'Only Cloudy staff can give money.',
          color: 'error',
        })],
      });
      return;
    }

    try {
      const scope = interaction.options.getSubcommand();
      const amount = parseCurrencyAmount(interaction.options.getInteger('amount'));
      const guildId = interaction.guildId;
      const format = value => '$' + value.toLocaleString('en-US');

      if (scope === 'me' || scope === 'user') {
        const recipient = scope === 'me' ? interaction.user : interaction.options.getUser('user');
        if (!recipient || recipient.bot) {
          throw new Error('Select a real member, not a bot.');
        }
        if (scope === 'user') {
          const member = await interaction.guild.members.fetch(recipient.id).catch(() => null);
          if (!member) throw new Error('That user is not a member of this server.');
        }
        const newCash = await grantCurrency(client, guildId, recipient.id, amount);
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [successEmbed('Money added',
            `Added **${format(amount)}** to **${recipient.username}**.\nNew cash balance: **${format(newCash)}**.`)],
        });
        logger.info('[CURRENCY] Owner granted currency', {
          guildId, actorId: interaction.user.id, recipientId: recipient.id, amount,
        });
        return;
      }

      if (scope !== 'everyone') throw new Error('Unknown currency command.');

      // A complete guild fetch is required: using a partial cache would
      // silently exclude offline members from an "everyone" grant.
      const members = await interaction.guild.members.fetch();
      if (interaction.guild.memberCount && members.size !== interaction.guild.memberCount) {
        throw new Error('The full member list could not be verified. No currency was added.');
      }
      const memberIds = [...members.values()].filter(member => !member.user?.bot).map(member => member.id);
      if (!memberIds.length) throw new Error('No eligible members were found.');
      const results = await grantCurrencyToMembers(client, guildId, memberIds, amount);
      const failed = results.failed.length;
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
          title: failed ? 'Money partially added' : 'Money added',
          description: `Added **${format(amount)}** to **${results.granted}** ${results.granted === 1 ? 'user' : 'users'}.`
            + (failed ? `\n**${failed}** failed. Do not repeat the command blindly; some members already received their cash.` : ''),
          color: failed ? 'warning' : 'success',
        })],
      });
      logger.info('[CURRENCY] Owner server-wide grant', {
        guildId, actorId: interaction.user.id, amount, total: results.total,
        granted: results.granted, failed: failed,
      });
    } catch (error) {
      logger.warn('[CURRENCY] Grant failed', {
        guildId: interaction.guildId, actorId: interaction.user.id, error: error.message,
      });
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
          title: 'Something went wrong',
          description: error.message || 'Currency could not be added.',
          color: 'error',
        })],
      });
    }
  },
};
