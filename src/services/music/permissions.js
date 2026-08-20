import { getGuildMusicData } from './playerStore.js';
import { canMemberControlSession } from './musicSessionService.js';

export const VOICE_CHANNEL_DENIAL =
    'You need to be in the same voice channel as the bot to use music controls.';

export const MUSIC_SESSION_DENIAL =
    'This music session is locked or restricted. The session owner, an allowed user, DJ role, server owner or administrator can control it.';

export function canControlMusic(member, player) {
    const memberChannel = member?.voice?.channel;
    if (!memberChannel || !player?.voiceChannel) {
        return false;
    }
    if (memberChannel.id !== player.voiceChannel) {
        return false;
    }

    const guildData = getGuildMusicData(member.guild.id);
    return canMemberControlSession(member, guildData);
}

export function requireVoiceChannel(member) {
    return Boolean(member?.voice?.channel);
}
