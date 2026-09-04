import { Events } from 'discord.js';
import { isEmbedManagerSaveInProgress } from '../services/embedManagerService.js';
import { logger } from '../utils/logger.js';

const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';

export function channelNameFromEmbedTitle(title) {
    return String(title || '')
        .normalize('NFKD')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[’']/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 100)
        .replace(/-+$/g, '');
}

function existingChannelEmojiPrefix(channelName) {
    const value = String(channelName || '');
    const firstTextCharacter = value.search(/[a-zA-Z0-9]/);
    if (firstTextCharacter <= 0) return '';

    const prefix = value.slice(0, firstTextCharacter);
    return /\p{Extended_Pictographic}/u.test(prefix) ? prefix : '';
}

function changedEmbedTitle(oldMessage, newMessage) {
    if (!oldMessage || oldMessage.partial || !Array.isArray(oldMessage.embeds)) return '';

    const oldEmbeds = oldMessage.embeds;
    const newEmbeds = Array.isArray(newMessage?.embeds) ? newMessage.embeds : [];
    const count = Math.max(oldEmbeds.length, newEmbeds.length);

    for (let index = 0; index < count; index += 1) {
        const previousTitle = String(oldEmbeds[index]?.title || '').replace(/\s+/g, ' ').trim();
        const nextTitle = String(newEmbeds[index]?.title || '').replace(/\s+/g, ' ').trim();
        if (nextTitle && previousTitle !== nextTitle) return nextTitle;
    }

    return '';
}

export default {
    name: Events.MessageUpdate,
    once: false,

    async execute(oldMessage, newMessage) {
        if (!newMessage?.id || !isEmbedManagerSaveInProgress(newMessage.id)) return;

        const message = newMessage.partial
            ? await newMessage.fetch().catch(() => null)
            : newMessage;
        if (!message) return;
        if (message.author?.id !== message.client.user?.id) return;

        // Dynamic response templates live in the private system catalog. Their
        // logical destination channel must never be renamed by a template edit.
        if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return;

        const title = changedEmbedTitle(oldMessage, message);
        if (!title) return;

        const channel = message.channel;
        if (!channel || channel.isThread?.() || typeof channel.setName !== 'function') return;

        const titleName = channelNameFromEmbedTitle(title);
        if (!titleName) return;

        // The Embed Builder may sync the text part of a channel name from the
        // embed title, but it must never remove an existing channel emoji.
        const prefix = existingChannelEmojiPrefix(channel.name);
        const nextName = `${prefix}${titleName}`.slice(0, 100).replace(/-+$/g, '');
        if (String(channel.name || '') === nextName) return;

        await channel.setName(nextName, 'Embed Builder title sync').catch(error => {
            logger.warn(`Failed to sync channel name from Embed Builder title in ${message.guildId}: ${error.message}`);
        });
    },
};
