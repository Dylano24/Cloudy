import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export function getMusicDeferOptions(interaction) {
    return interaction._isPrefixCommand ? {} : { flags: MessageFlags.Ephemeral };
}

export async function deferMusicCommand(interaction) {
    return InteractionHelper.safeDefer(interaction, getMusicDeferOptions(interaction));
}

// Public result, private problems: a successful command shows its result to the
// channel, but if it fails the public reply is replaced by a private notice
// that removes itself (see sendErrorResponse).
export async function deferMusicPublic(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction);
    interaction.__cloudyPrivateErrors = true;
    return deferred;
}
