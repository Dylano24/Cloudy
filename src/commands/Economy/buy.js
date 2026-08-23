import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { warningEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('buy')
        .setDescription('Buy an item from the shop')
        .addStringOption(option =>
            option
                .setName('item_id')
                .setDescription('ID of the item to buy')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('quantity')
                .setDescription('Quantity to buy (default: 1)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10)
        ),

    async execute(interaction) {
        return InteractionHelper.safeReply(interaction, {
            embeds: [warningEmbed(
                'Shop unavailable',
                'Purchases are not available yet. The `/buy` command will be enabled when the Cloudy store is ready.',
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
