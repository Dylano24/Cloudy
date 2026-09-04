import { Events } from 'discord.js';

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

export default {
    name: Events.MessageUpdate,
    once: false,

    execute() {
        // Embed Builder titles and Discord channel names are intentionally
        // independent. Saving an embed must never rename or reformat a channel.
        return undefined;
    },
};
