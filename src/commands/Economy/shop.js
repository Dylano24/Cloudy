import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Browse the economy shop.'),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle('Shop unavailable')
            .setDescription('The Cloudy shop is not available yet. It will be enabled when the store is ready.');

        return InteractionHelper.safeReply(interaction, {
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    },
};
