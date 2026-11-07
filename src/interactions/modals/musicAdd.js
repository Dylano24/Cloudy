import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, handleInteractionError, replyUserError } from '../../utils/errorHandler.js';
import { getGuildMusicData } from '../../services/music/playerStore.js';
import { getPlayer, playQuery } from '../../services/music/musicActions.js';
import { canControlMusic, VOICE_CHANNEL_DENIAL } from '../../services/music/permissions.js';
import { refreshPlayerMessage } from '../../services/music/playerHandler.js';
import { MUSIC_BUTTON_IDS } from '../../services/music/musicEmbeds.js';

// The Add button does not acknowledge/defer before opening its modal.
// The modal is handled through the same global modal registry as other Cloudy forms.
export default {
    name: MUSIC_BUTTON_IDS.ADD_MODAL,

    async execute(interaction, client, [sourceMessageId] = []) {
        const guildId = interaction.guildId || interaction.guild?.id;
        const player = guildId ? getPlayer(client, guildId) : null;

        if (!player?.current) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'Nothing is playing right now.',
            });
        }
        if (!canControlMusic(interaction.member, player)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: VOICE_CHANNEL_DENIAL,
            });
        }

        const guildData = getGuildMusicData(guildId);
        if (!sourceMessageId || String(guildData.playerMessageId) !== sourceMessageId) {
            return replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'This music player is outdated. Use the current player.',
            });
        }

        const query = interaction.fields?.getTextInputValue('music_add_query')?.trim();
        if (!query || query.length < 2 || query.length > 200) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'Enter a song name between 2 and 200 characters.',
            });
        }

        // Only the member who clicked Add sees the result. The player itself
        // remains public and refreshes its queue count in the same message.
        const deferred = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferred) return;

        try {
            const { embed } = await playQuery(client, interaction, query);
            await refreshPlayerMessage(client, guildId);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            await handleInteractionError(interaction, error, {
                type: 'modal',
                customId: interaction.customId,
                handler: 'musicAdd',
            });
        }
    },
};
