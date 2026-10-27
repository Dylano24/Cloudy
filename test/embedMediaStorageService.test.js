import test from 'node:test';
import assert from 'node:assert/strict';
import {
    persistCloudyEmbedMediaBuffer, persistCloudyDiscordEmbedMedia,
    isCloudyEmbedMediaStorageEnabled,
} from '../src/services/embedMediaStorageService.js';

test('immutable media upload uses signed private S3 PUT and returns a stable public URL', async t => {
    const env = {
        CLOUDY_MEDIA_S3_ENDPOINT: 'https://t3.storageapi.dev',
        CLOUDY_MEDIA_S3_BUCKET: 'cloudy-images-test-123',
        CLOUDY_MEDIA_S3_ACCESS_KEY_ID: 'test-access',
        CLOUDY_MEDIA_S3_SECRET_ACCESS_KEY: 'test-secret',
        CLOUDY_MEDIA_S3_REGION: 'auto',
        CLOUDY_MEDIA_S3_URL_STYLE: 'virtual',
        PUBLIC_APP_URL: 'https://cloudy-production-b24f.up.railway.app',
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => { for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
    const requestCalls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requestCalls.push({ url: String(url), options });
        return { ok: true, status: 200 };
    });
    const gif = Buffer.from('GIF89a' + 'x'.repeat(70));
    assert.equal(isCloudyEmbedMediaStorageEnabled(), true);
    const first = await persistCloudyEmbedMediaBuffer(gif);
    const second = await persistCloudyEmbedMediaBuffer(gif);
    assert.equal(first, second);
    assert.match(first, /^https:\/\/cloudy-production-b24f\.up\.railway\.app\/embed-media\/[a-f0-9]{64}\.gif$/);
    assert.equal(requestCalls.length, 1);
    assert.match(requestCalls[0].url, /^https:\/\/cloudy-images-test-123\.t3\.storageapi\.dev\/embeds\//);
    assert.match(requestCalls[0].options.headers.Authorization, /AWS4-HMAC-SHA256 Credential=test-access/);
    assert.equal(requestCalls[0].options.headers['Content-Type'], 'image/gif');
});

test('unsupported media and untrusted external downloads are never persisted', async t => {
    const env = {
        CLOUDY_MEDIA_S3_ENDPOINT: 'https://t3.storageapi.dev',
        CLOUDY_MEDIA_S3_BUCKET: 'cloudy-images-test-123',
        CLOUDY_MEDIA_S3_ACCESS_KEY_ID: 'test-access',
        CLOUDY_MEDIA_S3_SECRET_ACCESS_KEY: 'test-secret',
    };
    const prev = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => { for (const [key, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[key]; else process.env[key] = v;
    } });
    assert.equal(await persistCloudyEmbedMediaBuffer(Buffer.from('this is not an image')), null);
    assert.equal(await persistCloudyDiscordEmbedMedia('http://127.0.0.1/private'), null);
    assert.equal(await persistCloudyDiscordEmbedMedia('https://evil.example/attachments/1/2/evil.gif'), null);
});
