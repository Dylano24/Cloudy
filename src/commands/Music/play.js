import { SlashCommandBuilder } from 'discord.js';
import { playQuery } from '../../services/music/musicActions.js';
import { deferMusicCommand } from '../../services/music/prefixSupport.js';
import { refreshPlayerMessage } from '../../services/music/playerHandler.js';

export default {
    slashOnly: true,
    category: 'Music',
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song or add it to the queue')
        .addStringOption((opt) =>
            opt.setName('query').setDescription('Song name or a link (YouTube, Spotify, Apple Music, ...)').setRequired(true),
        ),

    async execute(interaction, config, client) {
        // Keep /play's acknowledgement private and temporary. The public
        // Now playing panel below is the only music message with controls.
        await deferMusicCommand(interaction);
        await playQuery(client, interaction, interaction.options.getString('query'));
        await refreshPlayerMessage(client, interaction.guild.id);
        if (!interaction._isPrefixCommand) {
            await interaction.deleteReply?.().catch(() => {});
        }
    },
};
