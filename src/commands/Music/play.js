import { SlashCommandBuilder } from 'discord.js';
import { playQuery } from '../../services/music/musicActions.js';
import { deferMusicCommand } from '../../services/music/prefixSupport.js';
import { refreshPlayerMessage } from '../../services/music/playerHandler.js';
import { removeOldMusicAnnouncements } from '../../services/music/musicRequestMessages.js';

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
        // Only the persistent Now playing panel with its seven buttons is public.
        // Defer privately while the music loads; delete the acknowledgement
        // after a successful request so no second embed remains in the channel.
        await deferMusicCommand(interaction);
        await playQuery(client, interaction, interaction.options.getString('query'));
        await refreshPlayerMessage(client, interaction.guild.id);
        if (!interaction._isPrefixCommand) {
            await interaction.deleteReply?.().catch(() => {});
        }

        // Remove old bot-owned /play announcements from this channel once.
        // The live player and every other message remain untouched.
        void removeOldMusicAnnouncements(client, interaction.channel).catch(() => {});
    },
};
