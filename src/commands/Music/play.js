import { SlashCommandBuilder } from 'discord.js';
import { playQuery, replyMusicSuccess } from '../../services/music/musicActions.js';
import { deferMusicCommand } from '../../services/music/prefixSupport.js';

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
        // Only the persistent music player is public; a private acknowledgement
        // prevents the second "Now playing" embed from cluttering #music.
        await deferMusicCommand(interaction);
        const result = await playQuery(client, interaction, interaction.options.getString('query'));
        await replyMusicSuccess(interaction, result.embed);

    },
};
