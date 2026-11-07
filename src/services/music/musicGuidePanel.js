import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from '../cloudyChannelResolver.js';
import { buildMusicGuideEmbed } from './musicEmbeds.js';

const MUSIC_GUIDE_KEY_PREFIX = 'cloudy:music:guide:';
const GUIDE_TITLE = 'Cloudy music';

function isGuideMessage(message, botUserId) {
    return message?.author?.id === botUserId
        && message.embeds?.some(embed => embed.title === GUIDE_TITLE);
}

async function findExistingGuide(channel, botUserId) {
    // Never post a second information panel when Discord history cannot be checked.
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages?.find?.(message => isGuideMessage(message, botUserId)) || null;
}

export async function reconcileMusicGuideMessage(client, guildId = process.env.GUILD_ID) {
    if (client?.config?.features?.music === false) {
        return { ok: false, reason: 'music_disabled' };
    }
    if (!client?.db?.get || !client?.db?.set || !client?.user?.id || !guildId) {
        return { ok: false, reason: 'unavailable' };
    }

    // The static guide belongs to Cloudy Inc.'s configured home guild only.
    // Do not create unsolicited messages when the bot is invited elsewhere.
    const guild = client.guilds?.cache?.get?.(guildId);
    if (!guild) return { ok: false, reason: 'guild_missing' };

    const channel = findCloudyChannelByAlias(
        guild,
        getCloudyChannelDefinition('music')?.aliases || [],
        { textOnly: true },
    );
    if (!channel?.isTextBased?.() || channel.isThread?.()) {
        return { ok: false, reason: 'channel_missing' };
    }

    const me = guild.members?.me || await guild.members?.fetchMe?.().catch(() => null);
    const permissions = me && channel.permissionsFor?.(me);
    if (!permissions?.has?.([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
    ])) {
        return { ok: false, reason: 'missing_permissions' };
    }

    const key = MUSIC_GUIDE_KEY_PREFIX + guildId;
    const saved = await client.db.get(key, null, { strict: true });
    if (saved?.messageId && saved.channelId === channel.id) {
        try {
            const message = await channel.messages.fetch(saved.messageId);
            if (isGuideMessage(message, client.user.id)) {
                // A custom edit in Embed Builder must not be undone at restart.
                return { ok: true, action: 'preserved', messageId: message.id };
            }
            return { ok: false, reason: 'managed_message_changed' };
        } catch (error) {
            // An owner deletion is intentional. Never silently resurrect it.
            if (Number(error?.code) === 10008) {
                return { ok: false, reason: 'guide_deleted' };
            }
            throw error;
        }
    }

    const existing = await findExistingGuide(channel, client.user.id);
    if (existing) {
        const savedOk = await client.db.set(key, {
            channelId: channel.id,
            messageId: existing.id,
        });
        if (savedOk === false) throw new Error('Could not save existing music guide identity');
        return { ok: true, action: 'found', messageId: existing.id };
    }

    const sent = await channel.send({
        embeds: [buildMusicGuideEmbed()],
        allowedMentions: { parse: [] },
    });
    const savedOk = await client.db.set(key, {
        channelId: channel.id,
        messageId: sent.id,
    });
    if (savedOk === false) {
        logger.error('[MUSIC_GUIDE] Guide was posted, but the message ID was not saved. '
            + 'On restart the existing message will be rediscovered by title.');
    }
    logger.info(`[MUSIC_GUIDE] Guide posted in #music: ${sent.id}`);
    return { ok: true, action: 'posted', messageId: sent.id };
}
