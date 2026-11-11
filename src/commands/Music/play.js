import { SlashCommandBuilder } from 'discord.js';
import { playQuery, replyMusicSuccess } from '../../services/music/musicActions.js';
import { deferMusicPublic } from '../../services/music/prefixSupport.js';

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
        await deferMusicPublic(interaction);
        const result = await playQuery(client, interaction, interaction.options.getString('query'));
        await replyMusicSuccess(interaction, result.embed);
    },
};
