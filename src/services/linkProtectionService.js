import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

const INVITE_TIMEOUT_MS = 10 * 60 * 1000;
const MALICIOUS_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const LINK_SPAM_TIMEOUT_MS = 60 * 60 * 1000;
const SPAM_WINDOW_MS = 15 * 1000;
const SPAM_MESSAGE_LIMIT = 3;
const ALERT_DELETE_MS = 10 * 1000;

const linkActivity = new Map();

const URL_PATTERN = /\b(?:https?:\/\/|www\.|discord\.gg\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)[^\s<>()]*/gi;
const DISCORD_INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
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

function getAllowedLinkChannels() {
    return new Set(
        String(process.env.ALLOWED_LINK_CHANNEL_IDS || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
    );
}

function normalizeUrl(rawUrl) {
    const cleaned = rawUrl.replace(/[.,!?;:'")\]}]+$/, '');
    return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
}

function extractUrls(content = '') {
    return [...content.matchAll(URL_PATTERN)].map(match => normalizeUrl(match[0]));
}

function isDiscordInvite(url) {
    return DISCORD_INVITE_PATTERN.test(url);
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

async function sendTemporaryAlert(message, title, description) {
    const alert = await message.channel.send({
        embeds: [
            new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle(title)
                .setDescription(`<@${message.author.id}>, ${description}`)
                .setFooter({ text: 'This notice will be removed automatically.' }),
        ],
        allowedMentions: { users: [message.author.id] },
    }).catch(() => null);

    if (alert) {
        const timer = setTimeout(() => alert.delete().catch(() => {}), ALERT_DELETE_MS);
        timer.unref?.();
    }
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

    const containsInvite = urls.some(isDiscordInvite);
    const containsMaliciousLink = urls.some(isLikelyMalicious);
    const isLinkSpam = urls.length >= 4 || recordLinkActivity(message, urls.length);
    const allowedChannels = getAllowedLinkChannels();
    const isAllowedChannel = allowedChannels.has(message.channel.id);

    if (!containsInvite && !containsMaliciousLink && !isLinkSpam && isAllowedChannel) {
        return false;
    }

    await message.delete().catch(error => {
        logger.warn('Could not delete blocked link message:', error);
    });

    if (containsMaliciousLink) {
        await applyTimeout(message, MALICIOUS_TIMEOUT_MS, 'Automatic protection: potentially malicious link');
        await sendTemporaryAlert(
            message,
            'Potentially Dangerous Link Blocked',
            'your message was removed and you have been timed out for **24 hours** because the link appeared unsafe. If you believe this was a mistake, contact the staff team.'
        );
        return true;
    }

    if (containsInvite) {
        await applyTimeout(message, INVITE_TIMEOUT_MS, 'Automatic protection: unauthorized Discord invite');
        await sendTemporaryAlert(
            message,
            'Discord Invite Blocked',
            'Discord invite links are not allowed here. Your message was removed and you have been timed out for **10 minutes**.'
        );
        return true;
    }

    if (isLinkSpam) {
        await applyTimeout(message, LINK_SPAM_TIMEOUT_MS, 'Automatic protection: link spam');
        await sendTemporaryAlert(
            message,
            'Link Spam Detected',
            'repeated or excessive links are not allowed. Your messages were removed and you have been timed out for **1 hour**.'
        );
        return true;
    }

    const destination = process.env.LINK_CHANNEL_ID
        ? `Please use <#${process.env.LINK_CHANNEL_ID}> for links.`
        : 'Please send links only in the appropriate links channel.';

    await sendTemporaryAlert(
        message,
        'Links Are Not Allowed Here',
        `your message was removed because links cannot be posted in this channel. ${destination}`
    );
    return true;
}
