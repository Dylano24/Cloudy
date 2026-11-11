import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { musicChannelFor, resolveOwnerMusicChannel } from './musicChannel.js';
import { buildMusicGuideEmbed, MUSIC_GUIDE_DESCRIPTION } from './musicEmbeds.js';

const MUSIC_GUIDE_KEY_PREFIX = 'cloudy:music:guide:';
const GUIDE_TITLE = 'Cloudy music';
const COMMANDS_BUTTON_ID = 'dedicated_commands:music';

export function buildMusicGuideComponents() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(COMMANDS_BUTTON_ID)
            .setLabel('Commands')
            .setStyle(ButtonStyle.Secondary),
    )];
}

function hasCommandsButton(components = []) {
    return components.some(row => (row?.components || row?.data?.components || []).some(button =>
        String(button.customId || button.custom_id || button.data?.custom_id || '') === COMMANDS_BUTTON_ID,
    ));
}

function shouldReplaceOldGuideText(message) {
    const guide = message.embeds?.find(embed => embed.title === GUIDE_TITLE);
    return String(guide?.description || '').startsWith('Your music. Your queue. Your experience.');
}

async function upgradeExistingGuide(message) {
    const oldDefaultText = shouldReplaceOldGuideText(message);
    const hasButton = hasCommandsButton(message.components || []);
    if (!oldDefaultText && hasButton) return false;
    const embeds = (message.embeds || []).map(embed => {
        const data = embed.toJSON?.() || embed;
        return oldDefaultText && data.title === GUIDE_TITLE
            ? { ...data, description: MUSIC_GUIDE_DESCRIPTION }
            : data;
    });
    const rows = (message.components || []).map(row => row.toJSON?.() || row);
    if (!hasButton) {
        if (rows.length < 5) {
            rows.push(...buildMusicGuideComponents().map(row => row.toJSON()));
        } else {
            const available = rows.find(row => (row.components || []).length < 5);
            if (!available) throw new Error('No room for the Music Commands button');
            available.components.push(buildMusicGuideComponents()[0].toJSON().components[0]);
        }
    }
    await message.edit({ embeds, components: rows, allowedMentions: { parse: [] } });
    return true;
}

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

    // The static guide belongs to the owner's music channel, else Cloudy Inc.'s
    // configured home guild only. Do not create unsolicited messages when the
    // bot is invited elsewhere.
    const owner = await resolveOwnerMusicChannel(client);
    const guild = owner?.channel.guild || client.guilds?.cache?.get?.(guildId);
    if (!guild) return { ok: false, reason: 'guild_missing' };

    const channel = owner?.channel || musicChannelFor(guild);
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

    const key = MUSIC_GUIDE_KEY_PREFIX + guild.id;
    const saved = await client.db.get(key, null, { strict: true });
    if (saved?.messageId && saved.channelId === channel.id) {
        try {
            const message = await channel.messages.fetch(saved.messageId);
            if (isGuideMessage(message, client.user.id)) {
                // Retain owner-authored wording. Only migrate the old default
                // instructions and add the same Commands button as Gambling.
                const updated = await upgradeExistingGuide(message);
                return { ok: true, action: updated ? 'updated' : 'preserved', messageId: message.id };
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
        const updated = await upgradeExistingGuide(existing);
        const savedOk = await client.db.set(key, {
            channelId: channel.id,
            messageId: existing.id,
        });
        if (savedOk === false) throw new Error('Could not save existing music guide identity');
        return { ok: true, action: updated ? 'updated' : 'found', messageId: existing.id };
    }

    const sent = await channel.send({
        embeds: [buildMusicGuideEmbed()],
        components: buildMusicGuideComponents(),
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
