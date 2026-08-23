import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { warningEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Browse the economy shop.'),

    async execute(interaction) {
        return InteractionHelper.safeReply(interaction, {
            embeds: [warningEmbed(
                'Shop unavailable',
                'The Cloudy shop is not available yet. It will be enabled when the store is ready.',
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
