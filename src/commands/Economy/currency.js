import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import {
  canGrantCurrency,
  grantCurrency,
  grantCurrencyToMembers,
  parseCurrencyAmount,
} from '../../services/currencyGrantService.js';

const amountOption = option => option.setName('amount')
  .setDescription('Amount of cash to create for each recipient')
  .setRequired(true).setMinValue(1);

export default {
  slashOnly: true,
  category: 'Economy',
  data: new SlashCommandBuilder()
    .setName('currency')
    .setDescription('Owner only: create Cloudy currency without spending your cash')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('user')
      .setDescription('Give cash to a selected member')
      .addUserOption(option => option.setName('user')
        .setDescription('Member who receives the cash').setRequired(true))
      .addIntegerOption(amountOption))
    .addSubcommand(sub => sub.setName('me')
      .setDescription('Add cash to your own balance')
      .addIntegerOption(amountOption))
    .addSubcommand(sub => sub.setName('everyone')
      .setDescription('Give the same cash amount to every non-bot member')
      .addIntegerOption(amountOption)
      .addBooleanOption(option => option.setName('confirm')
        .setDescription('Confirm this server-wide currency grant').setRequired(true))),

  async execute(interaction, config, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    if (!canGrantCurrency(interaction)) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [createEmbed({
          title: 'Permission denied',
          description: 'Only Cloudy owners can give currency.',
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
          embeds: [successEmbed('Currency added',
            `Added **${format(amount)}** to **${recipient.username}**.\nNew cash balance: **${format(newCash)}**.\nYour balance was not deducted.`)],
        });
        logger.info('[CURRENCY] Owner granted currency', {
          guildId, actorId: interaction.user.id, recipientId: recipient.id, amount,
        });
        return;
      }

      if (scope !== 'everyone') throw new Error('Unknown currency command.');
      if (interaction.options.getBoolean('confirm') !== true) {
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [createEmbed({
            title: 'Confirmation required',
            description: 'No currency was created. Set confirm to True to give every member the selected amount.',
            color: 'warning',
          })],
        });
        return;
      }

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
          title: failed ? 'Currency partially added' : 'Currency added',
          description: `Added **${format(amount)}** to **${results.granted}** member(s).`
            + (failed ? `\n**${failed}** failed. Do not repeat the command blindly; some members already received their cash.` : '')
            + '\nYour balance was not deducted.',
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
