import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';

const MALICIOUS_TIMEOUT_MS = 30 * 60 * 1000;
const FIRST_LINK_SPAM_TIMEOUT_MS = 60 * 60 * 1000;
const REPEAT_LINK_SPAM_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SPAM_WINDOW_MS = 15 * 1000;
const SPAM_MESSAGE_LIMIT = 3;
const ALERT_DELETE_MS = 15 * 1000;
const CONTENT_CATEGORY_NAME = 'postyourcontent';
const CONTENT_CHANNEL_NAMES = new Set(['youtube', 'tiktok', 'twitch']);
const CLOUDY_C_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';

const linkActivity = new Map();
const linkSpamOffenses = new Map();

const URL_PATTERN = /\b(?:https?:\/\/|www\.|discord\.gg\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\s<>()]*/gi;
const SHORTENER_HOSTS = new Set([
    'bit.ly',
    'cutt.ly',
    'grabify.link',
    'iplogger.org',
    'is.gd',
    'rebrand.ly',
    'shorturl.at',
    'tinyurl.com',
]);
const DANGEROUS_TLDS = new Set([
    'click',
    'download',
    'gq',
    'link',
    'lol',
    'monster',
    'rest',
    'support',
    'tk',
    'top',
    'work',
    'xyz',
]);
const SUSPICIOUS_FILE_PATTERN = /\.(?:apk|bat|cmd|com|exe|hta|jar|js|msi|ps1|scr|vbs)(?:[?#].*)?$/i;

function normalizeChannelName(name = '') {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isContentDestinationChannel(channel) {
    return (
        channel?.isTextBased?.()
        && CONTENT_CHANNEL_NAMES.has(normalizeChannelName(channel.name))
    );
}

function getContentChannels(guild) {
    if (!guild?.channels?.cache) return [];

    const category = guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildCategory
        && normalizeChannelName(channel.name).includes(CONTENT_CATEGORY_NAME)
    );

    const categoryChannels = category
        ? guild.channels.cache
            .filter(channel => channel.parentId === category.id && isContentDestinationChannel(channel))
            .sort((left, right) => left.rawPosition - right.rawPosition)
            .map(channel => channel)
        : [];

    if (categoryChannels.length > 0) return categoryChannels;

    return guild.channels.cache
        .filter(channel => isContentDestinationChannel(channel))
        .sort((left, right) => left.rawPosition - right.rawPosition)
        .map(channel => channel);
}

function formatChannelButtonLabel(channel) {
    const normalized = normalizeChannelName(channel.name);
    if (normalized === 'youtube') return 'YouTube';
    if (normalized === 'tiktok') return 'TikTok';
    if (normalized === 'twitch') return 'Twitch';

    return channel.name
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, character => character.toUpperCase())
        .slice(0, 80);
}

function buildContentChannelRows(message) {
    const channels = getContentChannels(message.guild);
    const rows = [];

    for (let index = 0; index < Math.min(channels.length, 25); index += 5) {
        const buttons = channels.slice(index, index + 5).map(channel =>
            new ButtonBuilder()
                .setLabel(formatChannelButtonLabel(channel))
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/channels/${message.guild.id}/${channel.id}`)
        );

        if (buttons.length > 0) {
            rows.push(new ActionRowBuilder().addComponents(buttons));
        }
    }

    return rows;
}

function normalizeUrl(rawUrl) {
    const cleaned = rawUrl.replace(/[.,!?;:'\")\]}]+$/, '');
    return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function extractUrls(content = '') {
    return [...content.matchAll(URL_PATTERN)].map(match => normalizeUrl(match[0]));
}

function hostnameMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function getContentPlatform(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');

        if (
            hostnameMatches(hostname, 'youtube.com')
            || hostnameMatches(hostname, 'youtu.be')
            || hostnameMatches(hostname, 'youtube-nocookie.com')
        ) {
            return 'youtube';
        }

        if (hostnameMatches(hostname, 'tiktok.com')) return 'tiktok';
        if (hostnameMatches(hostname, 'twitch.tv')) return 'twitch';

        return null;
    } catch {
        return null;
    }
}

function isLikelyMalicious(url) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const labels = hostname.split('.');
        const tld = labels.at(-1) || '';

        if (hostname.startsWith('xn--') || hostname.includes('.xn--')) return true;
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
        if (parsed.username || parsed.password) return true;
        if (SHORTENER_HOSTS.has(hostname)) return true;
        if (DANGEROUS_TLDS.has(tld)) return true;
        if (SUSPICIOUS_FILE_PATTERN.test(parsed.pathname)) return true;

        const discordLookalike =
            hostname.includes('discord') &&
            !['discord.com', 'discordapp.com', 'discord.gg', 'discord.gift'].includes(hostname);
        if (discordLookalike) return true;

        const steamLookalike =
            /(steam|steampowered|steamcommunity)/.test(hostname) &&
            !['steampowered.com', 'steamcommunity.com'].includes(hostname);
        if (steamLookalike) return true;

        return false;
    } catch {
        return true;
    }
}

function isExempt(message) {
    return (
        message.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
        message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
    );
}

function recordLinkActivity(message, urlCount) {
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const recent = (linkActivity.get(key) || []).filter(timestamp => now - timestamp < SPAM_WINDOW_MS);

    for (let index = 0; index < Math.max(1, urlCount); index += 1) {
        recent.push(now);
    }

    linkActivity.set(key, recent);

    if (linkActivity.size > 5000) {
        for (const [entryKey, timestamps] of linkActivity) {
            if (!timestamps.some(timestamp => now - timestamp < SPAM_WINDOW_MS)) {
                linkActivity.delete(entryKey);
            }
        }
    }

    return recent.length >= SPAM_MESSAGE_LIMIT;
}

function getNextLinkSpamTimeout(message) {
    const key = `${message.guild.id}:${message.author.id}`;
    const offenseCount = (linkSpamOffenses.get(key) || 0) + 1;
    linkSpamOffenses.set(key, offenseCount);

    return offenseCount === 1
        ? { durationMs: FIRST_LINK_SPAM_TIMEOUT_MS, label: '1 hour' }
        : { durationMs: REPEAT_LINK_SPAM_TIMEOUT_MS, label: '6 hours' };
}

async function deleteRecentLinkMessagesFromUser(message) {
    const cutoff = Date.now() - SPAM_WINDOW_MS;
    const channels = message.guild.channels.cache.filter(channel =>
        channel?.isTextBased?.()
        && channel.messages?.fetch
        && channel.viewable
    );

    await Promise.allSettled(
        channels.map(async channel => {
            const recentMessages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
            if (!recentMessages) return;

            const matchingMessages = recentMessages.filter(candidate =>
                candidate.author?.id === message.author.id
                && candidate.createdTimestamp >= cutoff
                && extractUrls(candidate.content).length > 0
                && candidate.deletable
            );

            await Promise.allSettled(
                matchingMessages.map(candidate => candidate.delete())
            );
        })
    );
}

function buildAlertPayload(message, title, description, components = []) {
    return {
        embeds: [
            new EmbedBuilder()
                .setColor(getColor('red'))
                .setTitle(title)
                .setDescription(`<@${message.author.id}>, ${description}`)
                .setThumbnail(CLOUDY_C_LOGO_URL)
                .setFooter({ text: 'This notice will be removed automatically.' }),
        ],
        components,
        allowedMentions: { users: [message.author.id] },
    };
}

async function sendTemporaryAlert(message, title, description, components = []) {
    const alert = await message.channel.send(
        buildAlertPayload(message, title, description, components)
    ).catch(error => {
        logger.warn(`Could not send temporary link warning in ${message.channel?.id || 'unknown channel'}:`, error);
        return null;
    });

    if (!alert) return;

    setTimeout(async () => {
        try {
            if (alert.deletable) {
                await alert.delete();
            } else {
                logger.warn(`Temporary link warning ${alert.id} could not be deleted because it is not deletable.`);
            }
        } catch (error) {
            logger.warn(`Could not delete temporary link warning ${alert.id}:`, error);
        }
    }, ALERT_DELETE_MS);
}

async function applyTimeout(message, durationMs, reason) {
    if (!message.member?.moderatable) {
        logger.warn(`Could not timeout ${message.author.tag}: bot role is too low or member is exempt`);
        return false;
    }

    await message.member.timeout(durationMs, reason);
    return true;
}

export async function enforceLinkProtection(message) {
    const urls = extractUrls(message.content);
    if (urls.length === 0 || isExempt(message)) return false;

    const containsMaliciousLink = urls.some(isLikelyMalicious);
    const isLinkSpam = urls.length >= 3 || recordLinkActivity(message, urls.length);
    const currentContentChannel = isContentDestinationChannel(message.channel)
        ? normalizeChannelName(message.channel.name)
        : null;
    const contentPlatforms = urls.map(getContentPlatform).filter(Boolean);
    const hasContentPlatformLink = contentPlatforms.length > 0;
    const wrongContentChannel = hasContentPlatformLink && (
        !currentContentChannel
        || contentPlatforms.some(platform => platform !== currentContentChannel)
    );

    // Normal links are allowed everywhere. Only malicious links, link spam,
    // and YouTube/TikTok/Twitch links posted outside their matching channel are blocked.
    if (!containsMaliciousLink && !isLinkSpam && !wrongContentChannel) {
        return false;
    }

    await message.delete().catch(error => {
        logger.warn('Could not delete blocked link message:', error);
    });

    if (containsMaliciousLink) {
        await applyTimeout(message, MALICIOUS_TIMEOUT_MS, 'Automatic protection: potentially malicious link');
        await sendTemporaryAlert(
            message,
            'Potentially dangerous link blocked',
            'your message was removed and you have been timed out for **30 minutes** because the link appeared unsafe. If you believe this was a mistake, contact the staff team.'
        );
        return true;
    }

    if (isLinkSpam) {
        const timeout = getNextLinkSpamTimeout(message);
        await applyTimeout(message, timeout.durationMs, 'Automatic protection: link spam');
        await deleteRecentLinkMessagesFromUser(message);
        await sendTemporaryAlert(
            message,
            'Link spam detected',
            `repeated or excessive links are not allowed. Your messages were removed and you have been timed out for **${timeout.label}**.`
        );
        return true;
    }

    if (wrongContentChannel) {
        await sendTemporaryAlert(
            message,
            'Wrong channel',
            'please make sure to post your content in the correct channel using the buttons below.',
            buildContentChannelRows(message)
        );
        return true;
    }

    return false;
}
