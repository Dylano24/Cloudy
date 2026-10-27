// Immutable, content-addressed image storage for manual Cloudy embeds.
// Railway buckets are private S3: only the bot can PUT/GET objects, while
// Discord receives a permanent public URL served by Cloudy's read-only route.
// No public upload endpoint, credentials or arbitrary upstream URL fetching.
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { logger } from '../utils/logger.js';

const MAX_BYTES = 16 * 1024 * 1024;
const pendingUploads = new Map();
const completedUploads = new Set();
const CONTENT_TYPES = { gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const MEDIA_KEY = /^[a-f0-9]{64}\.(?:gif|png|jpg|webp)$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

function config() {
    const env = process.env;
    const endpoint = env.CLOUDY_MEDIA_S3_ENDPOINT;
    const bucket = env.CLOUDY_MEDIA_S3_BUCKET;
    const accessKey = env.CLOUDY_MEDIA_S3_ACCESS_KEY_ID;
    const secretKey = env.CLOUDY_MEDIA_S3_SECRET_ACCESS_KEY;
    const publicBase = env.PUBLIC_APP_URL || 'https://cloudy-production-b24f.up.railway.app';
    if (!endpoint || !bucket || !accessKey || !secretKey || !publicBase) return null;
    try {
        const api = new URL(endpoint);
        const publicUrl = new URL(publicBase);
        if (api.protocol !== 'https:' || publicUrl.protocol !== 'https:') return null;
        if (!/^[a-z0-9][a-z0-9-]{2,120}$/i.test(bucket)) return null;
        return { api, publicUrl, bucket, accessKey, secretKey,
            region: env.CLOUDY_MEDIA_S3_REGION || 'auto',
            style: env.CLOUDY_MEDIA_S3_URL_STYLE === 'path' ? 'path' : 'virtual' };
    } catch { return null; }
}

export function isCloudyEmbedMediaStorageEnabled() { return Boolean(config()); }

function s3Url(settings, key) {
    const url = new URL(settings.api.toString());
    const path = key.split('/').map(encodeURIComponent).join('/');
    if (settings.style === 'virtual') {
        url.hostname = settings.bucket + '.' + url.hostname;
        url.pathname = '/' + path;
    } else {
        url.pathname = '/' + encodeURIComponent(settings.bucket) + '/' + path;
    }
    url.search = '';
    return url;
}

function sign(method, url, body, settings) {
    const time = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = time.slice(0, 8);
    const bodyHash = hash(body || Buffer.alloc(0));
    const headers = {
        host: url.host,
        'x-amz-content-sha256': bodyHash,
        'x-amz-date': time,
    };
    const headerNames = Object.keys(headers).sort();
    const canonicalHeaders = headerNames.map(key => key + ':' + headers[key] + '\n').join('');
    const signedHeaders = headerNames.join(';');
    const canonical = [method, url.pathname, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');
    const scope = [day, settings.region, 's3', 'aws4_request'].join('/');
    const stringToSign = ['AWS4-HMAC-SHA256', time, scope, hash(canonical)].join('\n');
    let key = hmac('AWS4' + settings.secretKey, day);
    key = hmac(key, settings.region);
    key = hmac(key, 's3');
    key = hmac(key, 'aws4_request');
    const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
    return {
        'x-amz-content-sha256': bodyHash, 'x-amz-date': time,
        Authorization: 'AWS4-HMAC-SHA256 Credential=' + settings.accessKey + '/' + scope
            + ',SignedHeaders=' + signedHeaders + ',Signature=' + signature,
    };
}

async function requestObject(method, key, buffer = null, mime = null) {
    const settings = config();
    if (!settings) return null;
    const url = s3Url(settings, 'embeds/' + key);
    const headers = sign(method, url, buffer, settings);
    if (mime) headers['Content-Type'] = mime;
    return fetch(url, {
        method, headers, ...(buffer ? { body: buffer } : {}),
        signal: AbortSignal.timeout(15_000),
    });
}

function fileType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_BYTES) return null;
    if (buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'gif';
    if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

export async function persistCloudyEmbedMediaBuffer(buffer) {
    if (!isCloudyEmbedMediaStorageEnabled()) return null;
    const type = fileType(buffer);
    if (!type) return null;
    const key = hash(buffer) + '.' + type;
    const settings = config();
    const publicLink = new URL('/embed-media/' + key, settings.publicUrl).toString();
    if (completedUploads.has(key)) return publicLink;
    if (!pendingUploads.has(key)) {
        const upload = (async () => {
            const response = await requestObject('PUT', key, buffer, CONTENT_TYPES[type]);
            if (!response?.ok) throw new Error('S3 PUT returned ' + (response?.status || 'no response'));
            completedUploads.add(key);
            return publicLink;
        })().catch(error => {
            logger.warn('[EMBED_MEDIA] Durable media upload unavailable: ' + (error?.message || error));
            return null;
        }).finally(() => pendingUploads.delete(key));
        pendingUploads.set(key, upload);
    }
    return pendingUploads.get(key);
}

function trustedDiscordAttachmentUrl(input) {
    try {
        const url = new URL(String(input || ''));
        return url.protocol === 'https:'
            && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
            && /\/(?:ephemeral-)?attachments\/\d+\/\d+\//.test(url.pathname);
    } catch { return false; }
}

export async function persistCloudyDiscordEmbedMedia(url) {
    if (!isCloudyEmbedMediaStorageEnabled() || !trustedDiscordAttachmentUrl(url)) return null;
    try {
        const reply = await fetch(url, { signal: AbortSignal.timeout(12_000) });
        if (!reply.ok || Number(reply.headers.get('content-length') || 0) > MAX_BYTES) return null;
        const bytes = Buffer.from(await reply.arrayBuffer());
        if (bytes.length > MAX_BYTES) return null;
        return await persistCloudyEmbedMediaBuffer(bytes);
    } catch (error) {
        logger.warn('[EMBED_MEDIA] Discord banner could not be made durable: ' + (error?.message || error));
        return null;
    }
}

export function registerCloudyEmbedMediaRoutes(app) {
    app.get('/embed-media/:key', async (req, res) => {
        const key = String(req.params.key || '');
        if (!MEDIA_KEY.test(key)) return res.sendStatus(404);
        const type = key.slice(key.lastIndexOf('.') + 1);
        try {
            const object = await requestObject('GET', key);
            if (!object?.ok || !object.body) return res.sendStatus(404);
            res.setHeader('Content-Type', CONTENT_TYPES[type]);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'");
            if (object.headers.get('etag')) res.setHeader('ETag', object.headers.get('etag'));
            const stream = Readable.fromWeb(object.body);
            stream.on('error', () => { if (!res.headersSent) res.sendStatus(502); else res.destroy(); });
            stream.pipe(res);
        } catch (error) {
            logger.warn('[EMBED_MEDIA] Unable to serve stored embed image: ' + (error?.message || error));
            if (!res.headersSent) res.sendStatus(503);
            else res.destroy();
        }
    });
}
