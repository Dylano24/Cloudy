import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { pgConfig } from '../config/database/postgres.js';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'guild:';
const MAX_FEEDS = 20;
const MAX_BYTES = 1_500_000;
const TICK_MS = 60_000;
let schedulerStarted = false;

function key(guildId, id) {
    return PREFIX + guildId + ':autofeed:' + id;
}

function forbiddenIp(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
    const a = p[0], b = p[1], c = p[2];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113);
}

export function validateFeedUrl(value) {
    const raw = String(value || '').trim();
    if (raw.length > 1024) throw new Error('Website URL is too long.');
    let url;
    try { url = new URL(raw); } catch { throw new Error('Enter a valid website link starting with https://'); }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        (url.port && !['80', '443'].includes(url.port)) ||
        !host.includes('.') || isIP(host) ||
        host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') ||
        host.endsWith('.test') || host.endsWith('.example')) {
        throw new Error('Only public HTTP or HTTPS website links are supported.');
    }
    url.hash = '';
    return url.href;
}

function requestText(input, redirects = 0) {
    const url = new URL(validateFeedUrl(input));
    return new Promise((resolve, reject) => {
        dns.lookup(url.hostname, { family: 4, all: true }, (dnsError, entries) => {
            if (dnsError || !Array.isArray(entries) || !entries.length ||
                entries.some(entry => forbiddenIp(entry.address))) {
                reject(new Error('This website cannot be accessed safely from Cloudy.'));
                return;
            }
            const address = entries[0].address;
            const driver = url.protocol === 'https:' ? https : http;
            const req = driver.get(url, {
                timeout: 10_000,
                lookup: (_name, _options, callback) => callback(null, address, 4),
                headers: {
                    'User-Agent': 'Cloudy-Autofeed/1.0',
                    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
                },
            }, (res) => {
                const status = res.statusCode || 0;
                if ([301, 302, 303, 307, 308].includes(status)) {
                    res.resume();
                    if (redirects >= 3 || !res.headers.location) {
                        reject(new Error('Website redirect limit reached.'));
                        return;
                    }
                    requestText(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject);
                    return;
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    reject(new Error('Website returned HTTP ' + status + '.'));
                    return;
                }
                const parts = [];
                let count = 0;
                res.on('data', chunk => {
                    count += chunk.length;
                    if (count > MAX_BYTES) {
                        req.destroy(new Error('Website response is too large.'));
                    } else {
                        parts.push(chunk);
                    }
                });
                res.once('end', () => resolve({ url: url.href, text: Buffer.concat(parts).toString('utf8') }));
                res.once('error', reject);
            });
            req.once('timeout', () => req.destroy(new Error('Website request timed out.')));
            req.once('error', reject);
        });
    });
}

function plain(value) {
    return decodeHtmlEntities(String(value || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()).slice(0, 1600);
}

function tag(xml, name) {
    const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i');
    return xml.match(re)?.[1] || '';
}

function attr(xml, attribute) {
    return xml.match(new RegExp('(?:\\s|^)' + attribute + '\\s*=\\s*["\\x27]([^"\\x27]*)["\\x27]', 'i'))?.[1] || '';
}

function publicMedia(url, base) {
    try {
        const value = new URL(decodeHtmlEntities(String(url || '')), base);
        return ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password ? value.href : null;
    } catch { return null; }
}

function extractImage(item, base) {
    const tags = item.match(/<(?:enclosure|media:thumbnail|media:content|img)\b[^>]*>/gi) || [];
    for (const node of tags) {
        const candidate = attr(node, 'url') || attr(node, 'src');
        if (candidate && (!node.startsWith('<enclosure') || /^image\//i.test(attr(node, 'type')))) {
            const image = publicMedia(candidate, base);
            if (image) return image;
        }
    }
    return null;
}

export function parseFeedItems(text, base) {
    const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) ||
        text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
    const items = [];
    for (const block of blocks.slice(0, 100)) {
        const rawLink = tag(block, 'link');
        const linkElement = block.match(/<link\b[^>]*\/?>/i)?.[0] || '';
        const link = publicMedia(plain(rawLink) || attr(linkElement, 'href') || plain(tag(block, 'guid')), base);
        const title = plain(tag(block, 'title')).slice(0, 240);
        if (!link || !title) continue;
        const description = plain(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content:encoded') || tag(block, 'content')).slice(0, 1200);
        items.push({ link, title, description, image: extractImage(block, base) });
    }
    return items;
}

function discoverFeed(html, base) {
    for (const link of html.match(/<link\b[^>]*>/gi) || []) {
        const rel = attr(link, 'rel').toLowerCase();
        const type = attr(link, 'type').toLowerCase();
        if (rel.split(/\s+/).includes('alternate') && /(rss|atom|xml|json)/.test(type)) {
            const href = publicMedia(attr(link, 'href'), base);
            if (href) return href;
        }
    }
    return null;
}

function htmlItems(html, base) {
    const items = [];
    for (const article of (html.match(/<article\b[\s\S]*?<\/article>/gi) || []).slice(0, 100)) {
        const anchor = article.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/i)?.[0] || '';
        const link = publicMedia(attr(anchor.match(/<a\b[^>]*>/i)?.[0] || '', 'href'), base);
        const title = plain(tag(article, 'h2') || tag(article, 'h3') || anchor).slice(0, 240);
        if (!title || !link) continue;
        items.push({ title, link, description: plain(tag(article, 'p')).slice(0, 1200), image: extractImage(article, base) });
    }
    return items;
}

export async function loadSourceItems(input) {
    const response = await requestText(input);
    let items = parseFeedItems(response.text, response.url);
    if (!items.length && /<html\b/i.test(response.text)) {
        const feed = discoverFeed(response.text, response.url);
        if (feed && feed !== response.url) {
            const feedResponse = await requestText(feed);
            items = parseFeedItems(feedResponse.text, feedResponse.url);
        }
        if (!items.length) items = htmlItems(response.text, response.url);
    }
    if (!items.length) throw new Error('No readable posts found. This website may require an RSS feed or API.');
    return items;
}

export async function listAutoFeeds(client, guildId) {
    const keys = await client.db.list(PREFIX + guildId + ':autofeed:');
    const records = await Promise.all(keys.map(k => client.db.get(k, null, { strict: true })));
    return records.filter(r => r && r.id && r.guildId === guildId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function addAutoFeed(client, guild, fields) {
    const url = validateFeedUrl(fields.url);
    const minutes = Number(fields.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
        throw new Error('Choose a posting interval between 5 and 1440 minutes.');
    }
    const channel = await guild.channels.fetch(fields.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function' ||
        ![0, 5].includes(channel.type)) {
        throw new Error('Choose a text or announcement channel in this server.');
    }
    if (fields.adult && !channel.nsfw) {
        throw new Error('Adult feeds must use a Discord age restricted channel.');
    }
    const bot = guild.members.me || await guild.members.fetchMe();
    const perms = channel.permissionsFor(bot);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages) ||
        !perms.has(PermissionFlagsBits.EmbedLinks)) {
        throw new Error('Cloudy needs View channel, Send messages and Embed links in that channel.');
    }
    const existing = await listAutoFeeds(client, guild.id);
    if (existing.length >= MAX_FEEDS) throw new Error('Maximum 20 auto feeds per server.');
    const matches = await loadSourceItems(url);
    const now = Date.now();
    const record = {
        id: randomUUID(), guildId: guild.id, url, channelId: channel.id, intervalMinutes: minutes,
        adult: Boolean(fields.adult), paused: false, seen: [], createdAt: now,
        nextRunAt: now + minutes * 60_000, lastPostedAt: null,
    };
    await client.db.set(key(guild.id, record.id), record);
    return { feed: record, availablePosts: matches.length };
}

export async function updateAutoFeed(client, guildId, id, patch) {
    const current = await client.db.get(key(guildId, id), null, { strict: true });
    if (!current) throw new Error('Feed not found.');
    const updated = { ...current, ...patch, id: current.id, guildId };
    await client.db.set(key(guildId, id), updated);
    return updated;
}

export async function deleteAutoFeed(client, guildId, id) {
    await client.db.delete(key(guildId, id));
}

async function claimRun(client, feed) {
    const nextRun = Date.now() + feed.intervalMinutes * 60_000;
    const pool = client.db?.db?.pool;
    if (pool && client.db.db.isAvailable?.()) {
        const result = await pool.query(
            'UPDATE ' + pgConfig.tables.temp_data +
            ' SET value = jsonb_set(value, \u0027{nextRunAt}\u0027, to_jsonb($2::bigint), true)' +
            ' WHERE key = $1 AND (value->>\u0027paused\u0027)::boolean IS FALSE' +
            ' AND COALESCE((value->>\u0027nextRunAt\u0027)::bigint, 0) <= $3::bigint RETURNING value',
            [key(feed.guildId, feed.id), nextRun, Date.now()],
        );
        return result.rowCount === 1 ? result.rows[0].value : null;
    }
    if (process.env.NODE_ENV === 'production') return null;
    const current = await client.db.get(key(feed.guildId, feed.id), null, { strict: true });
    if (!current || current.paused || current.nextRunAt > Date.now()) return null;
    return updateAutoFeed(client, feed.guildId, feed.id, { nextRunAt: nextRun });
}

async function runFeed(client, feed) {
    const claimed = await claimRun(client, feed);
    if (!claimed) return;
    try {
        const guild = client.guilds.cache.get(claimed.guildId);
        if (!guild) return;
        const channel = await guild.channels.fetch(claimed.channelId).catch(() => null);
        if (!channel?.send || (claimed.adult && !channel.nsfw)) return;
        const bot = guild.members.me || await guild.members.fetchMe();
        const perms = channel.permissionsFor(bot);
        if (!perms?.has(PermissionFlagsBits.ViewChannel) ||
            !perms.has(PermissionFlagsBits.SendMessages) ||
            !perms.has(PermissionFlagsBits.EmbedLinks)) return;
        const posts = await loadSourceItems(claimed.url);
        const seen = new Set(claimed.seen || []);
        const unseen = posts.filter(post => !seen.has(post.link));
        if (!unseen.length) return;
        const selected = unseen[Math.floor(Math.random() * unseen.length)];
        const current = await client.db.get(key(claimed.guildId, claimed.id), null, { strict: true });
        if (!current || current.paused || current.url !== claimed.url || current.channelId !== claimed.channelId) return;
        const embed = new EmbedBuilder()
            .setColor(0xFFFFFF)
            .setTitle(selected.title.slice(0, 256))
            .setURL(selected.link);
        if (selected.description) embed.setDescription(selected.description.slice(0, 4096));
        if (selected.image) embed.setImage(selected.image);
        // Mark selected posts before sending; a restart cannot create duplicate posts.
        const nextSeen = [...new Set([...(current.seen || []), selected.link])].slice(-200);
        await updateAutoFeed(client, claimed.guildId, claimed.id, { seen: nextSeen, lastPostedAt: Date.now() });
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        logger.warn('[AUTO_FEED] Feed failed for ' + feed.id + ': ' + error.message);
    }
}

export function startAutoFeedScheduler(client) {
    if (schedulerStarted) return;
    schedulerStarted = true;
    let ticking = false;
    const run = async () => {
        if (ticking || !client.isReady()) return;
        ticking = true;
        try {
            for (const guild of client.guilds.cache.values()) {
                const feeds = await listAutoFeeds(client, guild.id);
                for (const feed of feeds) {
                    if (!feed.paused && feed.nextRunAt <= Date.now()) {
                        await runFeed(client, feed);
                    }
                }
            }
        } catch (error) {
            logger.error('[AUTO_FEED] Scheduler error: ' + error.message);
        } finally { ticking = false; }
    };
    const timer = setInterval(() => { void run(); }, TICK_MS);
    timer.unref?.();
    void run();
}
