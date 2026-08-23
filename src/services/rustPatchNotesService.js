import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events,
    PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const RUST_PATCH_CHANNEL_ID = '1533886914459861103';
const RUST_NEWS_FEED = 'https://rust.facepunch.com/rss/news';
const LAST_PATCH_KEY = `global:rust:patch-notes:${RUST_PATCH_CHANNEL_ID}:last-link:v6`;

const LATEST_KNOWN_PATCH = {
    title: 'Power Trip',
    link: 'https://rust.facepunch.com/news/power-trip',
    description: "This month's update brings Player Maintained Monuments, including a Satellite Crash, Dome Pumping and a restorable Power Plant, plus balances, bug fixes, optimisations and improvements.",
    publishedAt: '2026-08-06T18:00:00Z',
    image: null,
    body: [
        '### Player Maintained Monuments',
        'Restore and power key monuments across the island, including Power Plant production and new monument interactions.',
        '',
        '### Satellite Crash',
        'Trigger a new server-wide satellite event and compete for its unique loot.',
        '',
        '### Balances & Improvements',
        'Includes balancing changes, bug fixes, optimisations and quality-of-life improvements.',
    ].join('\n'),
};
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_RETRY_MS = 60 * 1000;

function decodeXml(value = '') {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function stripHtml(value = '') {
    return decodeXml(value)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}


function htmlToDiscord(value = '') {
    const markdown = decodeXml(value)
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n### $1\n')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n• $1')
        .replace(/<(?:p|div|section|article)[^>]*>/gi, '\n')
        .replace(/<\/(?:p|div|section|article)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&#x27;/gi, "'")
        .replace(/&#x2F;/gi, '/')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (markdown.length <= 3600) return markdown;
    return `${markdown.slice(0, 3596).trimEnd()} ...`;
}

function readTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? decodeXml(match[1]).trim() : '';
}

function readImage(xml) {
    const enclosure = xml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i);
    if (enclosure?.[1]) return decodeXml(enclosure[1]);

    const media = xml.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
    if (media?.[1]) return decodeXml(media[1]);

    const content = readTag(xml, 'content:encoded') || readTag(xml, 'description');
    const image = content.match(/<img[^>]+src=["']([^"']+)["']/i);
    return image?.[1] ? decodeXml(image[1]) : null;
}

function parseLatestPatch(feed) {
    const items = feed.match(/<item\b[\s\S]*?<\/item>/gi) || [];

    for (const item of items) {
        const category = readTag(item, 'category').toLowerCase();
        if (category && !category.includes('devblog')) continue;

        const title = readTag(item, 'title');
        const link = readTag(item, 'link') || readTag(item, 'guid');
        if (!title || !link) continue;

        const descriptionHtml = readTag(item, 'description');
        const fullArticleHtml = readTag(item, 'content:encoded');

        return {
            title,
            link,
            description: stripHtml(descriptionHtml).slice(0, 1000),
            body: htmlToDiscord(fullArticleHtml || descriptionHtml),
            publishedAt: readTag(item, 'pubDate'),
            image: readImage(item),
        };
    }

    return null;
}

async function checkForRustPatch(client) {
    try {
        let patch = LATEST_KNOWN_PATCH;

        try {
            const feedUrl = `${RUST_NEWS_FEED}?cloudy=${Date.now()}`;
            const response = await fetch(feedUrl, {
                headers: {
                    'User-Agent': 'Cloudy Discord Bot/1.0',
                    Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
                    'Cache-Control': 'no-cache',
                },
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) {
                throw new Error(`Rust feed returned HTTP ${response.status}`);
            }

            patch = parseLatestPatch(await response.text()) || LATEST_KNOWN_PATCH;
        } catch (feedError) {
            logger.warn('Could not fetch the Rust feed; posting the latest known official patch.', feedError);
        }

        const channel = await client.channels.fetch(RUST_PATCH_CHANNEL_ID);
        if (!channel?.isTextBased()) {
            throw new Error(`Channel ${RUST_PATCH_CHANNEL_ID} is not a text channel`);
        }

        const botMember = channel.guild?.members?.me;
        const permissions = botMember ? channel.permissionsFor(botMember) : null;
        const requiredPermissions = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
        ];

        if (permissions && !permissions.has(requiredPermissions)) {
            throw new Error(
                `Cloudy needs View Channel, Send Messages and Embed Links in channel ${RUST_PATCH_CHANNEL_ID}`
            );
        }

        const previousLink = await client.db.get(LAST_PATCH_KEY);

        try {
            const recentMessages = await channel.messages.fetch({ limit: 100 });
            const isAlreadyPosted = recentMessages.some(message =>
                message.author.id === client.user.id &&
                message.embeds.some(embed => embed.url === patch.link)
            );

            if (isAlreadyPosted) {
                if (previousLink !== patch.link) {
                    await client.db.set(LAST_PATCH_KEY, patch.link);
                }
                return true;
            }
        } catch (historyError) {
            logger.warn('Could not verify recent Rust patch messages; using stored state.', historyError);
        }

        if (previousLink === patch.link) {
            return true;
        }

        const articlePreview =
            patch.body ||
            patch.description ||
            'A new official Rust update is available.';

        const embed = new EmbedBuilder()
            .setColor('#FFFFFF')
            .setAuthor({ name: 'RUST • OFFICIAL UPDATE' })
            .setTitle(patch.title)
            .setURL(patch.link)
            .setDescription(articlePreview)
            .setFooter({ text: 'Cloudy Patch Notes • Source: Facepunch Studios' })
            .setTimestamp(patch.publishedAt ? new Date(patch.publishedAt) : new Date());

        if (patch.image) embed.setImage(patch.image);

        const linkRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Read full patch notes')
                .setStyle(ButtonStyle.Link)
                .setURL(patch.link)
        );

        await channel.send({
            embeds: [embed],
            components: [linkRow],
        });
        await client.db.set(LAST_PATCH_KEY, patch.link);
        logger.info(`Posted Rust patch notes: ${patch.title}`);
        return true;
    } catch (error) {
        logger.warn('Rust patch notes check failed:', error);
        return false;
    }
}

let patchNotesTimer = null;

export function startRustPatchNotes(client) {
    const beginMonitoring = async () => {
        if (patchNotesTimer) return;

        const posted = await checkForRustPatch(client);
        if (!posted) {
            const retry = setTimeout(() => {
                void checkForRustPatch(client);
            }, STARTUP_RETRY_MS);
            retry.unref?.();
        }

        patchNotesTimer = setInterval(() => {
            void checkForRustPatch(client);
        }, CHECK_INTERVAL_MS);

        patchNotesTimer.unref?.();
        logger.info(`Rust patch notes monitor active for channel ${RUST_PATCH_CHANNEL_ID}`);
    };

    if (client.isReady()) {
        void beginMonitoring();
    } else {
        client.once(Events.ClientReady, () => {
            void beginMonitoring();
        });
    }
}
