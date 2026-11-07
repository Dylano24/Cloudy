import { SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { buildNowPlayingReply } from '../../services/music/musicActions.js';

// Natural-language slash form of /nowplaying. Keep the original for
// existing users and prefix aliases; both display the same public music card.
export default {
    slashOnly: true,
    category: 'Music',
    data: new SlashCommandBuilder()
        .setName('now')
        .setDescription('Show the current music session')
        .addSubcommand(sub =>
            sub.setName('playing').setDescription('Show the song and its album cover'),
        ),

    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);
        const payload = buildNowPlayingReply(client, interaction.guild.id);
        await InteractionHelper.safeEditReply(interaction, payload);
    },
};
