import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events,
    PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';
import { createSingleFlight } from '../utils/singleFlight.js';
import { preparePatchNotesBanner, repairMissingPatchBanner, samePatchArticle } from './patchNotesBannerService.js';

const RUST_PATCH_CHANNEL_ID = '1533886914459861103';
const RUST_NEWS_FEED = 'https://rust.facepunch.com/rss/news';
const LAST_PATCH_KEY = `global:rust:patch-notes:${RUST_PATCH_CHANNEL_ID}:last-link:v6`;

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_RETRY_MS = 60 * 1000;
const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1000;
let lastPatchChannelWarningAt = 0;

function decodeXml(value = '') {
    return decodeHtmlEntities(value)
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
    const enclosure = (xml.match(/<enclosure\b[^>]*>/gi) || []).find(tag => /type=["']image\//i.test(tag));
    const enclosureUrl = enclosure?.match(/\burl=["']([^"']+)["']/i)?.[1];
    if (enclosureUrl) return decodeXml(enclosureUrl);

    const media = xml.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
    if (media?.[1]) return decodeXml(media[1]);

    const content = readTag(xml, 'content:encoded') || readTag(xml, 'description');
    const image = content.match(/<img[^>]+src=["']([^"']+)["']/i);
    return image?.[1] ? decodeXml(image[1]) : null;
}

export function parseLatestPatch(feed) {
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

export async function repairEncodedPatchText(message) {
    const original = message.embeds.map(embed => embed.toJSON());
    const embeds = original.map(data => ({
        ...data,
        ...(data.title ? { title: decodeHtmlEntities(data.title) } : {}),
        ...(data.description ? { description: decodeHtmlEntities(data.description) } : {}),
    }));
    if (JSON.stringify(original) !== JSON.stringify(embeds)) await message.edit({ embeds });
}

async function checkForRustPatch(client) {
    try {
        let patch;

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

            patch = parseLatestPatch(await response.text());
            if (!patch) throw new Error('No official Rust patch in feed');
        } catch (feedError) {
            throw new Error('Could not fetch current official Rust patch; retrying later', { cause: feedError });
        }

        const channel = await resolveCloudyChannel(client, 'rustPatch', { textOnly: true });
        if (!channel?.isTextBased()) {
            throw new Error(`Rust update channel ${RUST_PATCH_CHANNEL_ID} is missing or inaccessible. Check the channel name, View Channel and Cloudy permissions.`);
        }

        const botMember = channel.guild?.members?.me;
        const permissions = botMember ? channel.permissionsFor(botMember) : null;
        const requiredPermissions = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
        ];

        if (permissions && !permissions.has(requiredPermissions)) {
            throw new Error(
                `Cloudy needs View Channel, Send Messages, Embed Links and Attach Files in channel ${RUST_PATCH_CHANNEL_ID}`
            );
        }

        const previousLink = await client.db.get(LAST_PATCH_KEY);

        let recentMessages;
        try {
            recentMessages = await channel.messages.fetch({ limit: 100 });
        } catch (historyError) {
            logger.warn('Could not verify recent Rust patch messages; using stored state.', historyError);
        }
        if (recentMessages) {
            const existingMessage = recentMessages.find(message =>
                message.author.id === client.user.id &&
                message.embeds.some(embed => samePatchArticle(embed.url, patch.link))
            );

            if (existingMessage) {
                await repairMissingPatchBanner(existingMessage, patch);
                if (previousLink !== patch.link) {
                    await client.db.set(LAST_PATCH_KEY, patch.link);
                }
                return true;
            }
        }

        if (samePatchArticle(previousLink, patch.link)) {
            return true;
        }

        const banner = await preparePatchNotesBanner(patch);
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

        embed.setImage(banner.image.url);

        const linkRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Read full patch notes')
                .setStyle(ButtonStyle.Link)
                .setURL(patch.link)
        );

        await channel.send({
            embeds: [embed],
            components: [linkRow],
            files: [banner.file],
        });
        await client.db.set(LAST_PATCH_KEY, patch.link);
        lastPatchChannelWarningAt = 0;
        logger.info(`Posted Rust patch notes: ${patch.title}`);
        return true;
    } catch (error) {
        if (Date.now() - lastPatchChannelWarningAt >= FAILURE_LOG_INTERVAL_MS) {
            lastPatchChannelWarningAt = Date.now();
            logger.warn('Rust patch notes check failed:', error);
        } else {
            logger.debug(`Rust patch notes check still unavailable: ${error?.message || error}`);
        }
        return false;
    }
}

const patchNotesMonitors = new WeakMap();

export function startRustPatchNotes(client) {
    // Ready and app startup both request this monitor. Reserve it before any
    // network await so they cannot install duplicate checks or intervals.
    if (patchNotesMonitors.has(client)) return;
    const runCheck = createSingleFlight(() => checkForRustPatch(client));
    patchNotesMonitors.set(client, { runCheck });

    const beginMonitoring = async () => {
        const posted = await runCheck();
        if (!posted) {
            const retry = setTimeout(() => {
                void runCheck();
            }, STARTUP_RETRY_MS);
            retry.unref?.();
        }

        const timer = setInterval(() => {
            void runCheck();
        }, CHECK_INTERVAL_MS);

        patchNotesMonitors.get(client).timer = timer;
        timer.unref?.();
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
