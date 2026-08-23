import { SlashCommandBuilder } from 'discord.js';
import shopBrowse from './modules/shop_browse.js';
import { enforceDedicatedCommandChannel } from '../../services/dedicatedChannelService.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Browse the economy shop.'),

    async execute(interaction, config, client) {
        await enforceDedicatedCommandChannel(interaction, 'shop');
        return shopBrowse.execute(interaction, config, client);
    },
};
