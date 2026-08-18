import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const RUST_PATCH_CHANNEL_ID = '1533886914459861103';
const RUST_NEWS_FEED = 'https://rust.facepunch.com/rss/news';
const LAST_PATCH_KEY = 'global:rust:patch-notes:last-link';
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

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

function readTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? decodeXml(match[1]).trim() : '';
}

function readImage(xml) {
    const enclosure = xml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i);
    if (enclosure?.[1]) return decodeXml(enclosure[1]);

    const media = xml.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
    return media?.[1] ? decodeXml(media[1]) : null;
}

function parseLatestPatch(feed) {
    const items = feed.match(/<item\b[\s\S]*?<\/item>/gi) || [];

    for (const item of items) {
        const category = readTag(item, 'category').toLowerCase();
        if (category && !category.includes('devblog')) continue;

        const title = readTag(item, 'title');
        const link = readTag(item, 'link') || readTag(item, 'guid');
        if (!title || !link) continue;

        return {
            title,
            link,
            description: stripHtml(readTag(item, 'description')).slice(0, 1000),
            publishedAt: readTag(item, 'pubDate'),
            image: readImage(item),
        };
    }

    return null;
}

async function checkForRustPatch(client) {
    try {
        const response = await fetch(RUST_NEWS_FEED, {
            headers: { 'User-Agent': 'Cloudy Discord Bot/1.0' },
        });
        if (!response.ok) {
            throw new Error(`Rust feed returned HTTP ${response.status}`);
        }

        const patch = parseLatestPatch(await response.text());
        if (!patch) {
            throw new Error('No Rust devblog was found in the official feed');
        }

        const previousLink = await client.db.get(LAST_PATCH_KEY);
        if (previousLink === patch.link) return;

        const channel = await client.channels.fetch(RUST_PATCH_CHANNEL_ID);
        if (!channel?.isTextBased()) {
            throw new Error(`Channel ${RUST_PATCH_CHANNEL_ID} is not a text channel`);
        }

        const embed = new EmbedBuilder()
            .setColor('#CE422B')
            .setTitle(`🛠️ Rust Patch Notes — ${patch.title}`)
            .setURL(patch.link)
            .setDescription(
                patch.description || 'A new official Rust update is available. Click the title to read the full patch notes.'
            )
            .addFields({
                name: 'Official Patch Notes',
                value: `[Read the full update on Facepunch](${patch.link})`,
            })
            .setFooter({ text: 'Official Rust update • Facepunch Studios' })
            .setTimestamp(patch.publishedAt ? new Date(patch.publishedAt) : new Date());

        if (patch.image) embed.setImage(patch.image);

        await channel.send({ embeds: [embed] });
        await client.db.set(LAST_PATCH_KEY, patch.link);
        logger.info(`Posted Rust patch notes: ${patch.title}`);
    } catch (error) {
        logger.warn('Rust patch notes check failed:', error);
    }
}

export function startRustPatchNotes(client) {
    void checkForRustPatch(client);

    const timer = setInterval(() => {
        void checkForRustPatch(client);
    }, CHECK_INTERVAL_MS);

    timer.unref?.();
}
