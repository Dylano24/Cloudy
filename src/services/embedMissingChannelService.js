import { MessageFlags } from 'discord.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';
import { registerCloudyEmbedMessage } from './embedRegistryService.js';

function isUsableMessage(message, botUserId) {
    if (!message?.guildId || message.author?.id !== botUserId || !message.embeds?.length) return false;
    if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
    if (message.interaction || message.interactionMetadata) return false;

    const title = String(message.embeds[0]?.title || '').trim().toLowerCase();
    if (['message builder', 'modify embed', 'embed loaded', 'changes saved', 'could not load embeds'].includes(title)) {
        return false;
    }

    return true;
}

function isBuilderMarked(message) {
    return message.embeds?.some(embed =>
        String(embed?.footer?.text || '').endsWith(MESSAGE_BUILDER_FOOTER_MARKER),
    );
}

function newestCandidate(messages, botUserId) {
    const usable = [...messages]
        .filter(message => isUsableMessage(message, botUserId))
        .sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));

    return usable.find(isBuilderMarked) || usable[0] || null;
}

function recordName(embed) {
    const title = String(embed?.title || '').replace(/\s+/g, ' ').trim();
    if (title) return title.slice(0, 256);

    const firstLine = String(embed?.description || '')
        .split('\n')
        .map(line => line.replace(/^[>\s#*_`~|\-]+/, '').replace(/[*_`~]/g, '').trim())
        .find(Boolean);
    return String(firstLine || 'Untitled embed').slice(0, 256);
}

export async function discoverMissingChannelEmbed(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return null;

    const channel = guild.channels.cache.get(String(channelId))
        || await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.messages?.fetch) return null;

    let message = newestCandidate(channel.messages.cache.values(), botUserId);
    if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (!recent?.size) return null;
        message = newestCandidate(recent.values(), botUserId);
    }
    if (!message) return null;

    // Register it through the existing manual-template path. This keeps the
    // normal registry/reconcile/save behaviour intact and avoids any global scan.
    await registerCloudyEmbedMessage(message, 'embed-builder');

    const embedIndex = Math.max(0, message.embeds.findIndex(embed =>
        String(embed?.footer?.text || '').endsWith(MESSAGE_BUILDER_FOOTER_MARKER),
    ));
    const embed = message.embeds[embedIndex] || message.embeds[0];
    const record = {
        guildId: String(guild.id),
        channelId: String(channel.id),
        backingChannelId: null,
        messageId: String(message.id),
        embedIndex,
        source: 'embed-builder',
        title: String(embed?.title || '').slice(0, 256),
        name: recordName(embed),
        createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
    };

    return { channel, message, embed, record };
}
