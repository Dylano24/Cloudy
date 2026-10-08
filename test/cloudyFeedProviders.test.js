import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudyMediaProvider, redgifsEndpoint, normalizeRedgifsItems,
  redgifsMedia, parseEromeAlbum, discoverEromeAlbums, eromeMedia,
  readCloudyProviderItems,
} from '../src/services/cloudyFeedProviders.js';
import { normalizeMediaCountry } from '../src/services/cloudyFeedParser.js';
import { eligibleMediaForSource } from '../src/services/cloudyFeedService.js';

test('provider dispatch recognizes real RedGIFs and Erome hosts only', () => {
  assert.equal(cloudyMediaProvider('https://redgifs.com/'), 'redgifs');
  assert.equal(cloudyMediaProvider('https://www.redgifs.com/watch/SomeID'), 'redgifs');
  assert.equal(cloudyMediaProvider('https://nl.erome.com/a/abc123'), 'erome');
  assert.equal(cloudyMediaProvider('https://erome.com/explore'), 'erome');
  assert.equal(cloudyMediaProvider('https://redgifs.com.evil.example'), null);
  assert.equal(cloudyMediaProvider('https://example.org/'), null);
  assert.equal(cloudyMediaProvider('http://redgifs.com/'), null);
});

test('RedGIFs pages resolve to supported API routes, not HTML scraping', () => {
  assert.equal(redgifsEndpoint('https://redgifs.com/watch/AbC'), '/v2/gifs/abc');
  assert.equal(redgifsEndpoint('https://www.redgifs.com/users/Foo'), '/v2/users/foo/search?page=1&count=30&type=g&order=recent');
  assert.match(redgifsEndpoint('https://redgifs.com/browse?tags=Comedy'), /^\/v2\/gifs\/search\?/);
  assert.match(redgifsEndpoint('https://redgifs.com/'), /^\/v2\/search\/gifs\?/);
  assert.throws(() => redgifsEndpoint('https://redgifs.com/some/unexpected/route'), /Use the RedGIFs/);
  assert.throws(() => redgifsEndpoint('https://redgifs.com/watch/abc%2Fdef'), /Invalid RedGIFs identifier/);
});

test('RedGIFs temporary auth and public MP4 extraction use no credentials from user', async () => {
  const requests = [];
  const result = await redgifsMedia('https://redgifs.com/watch/ABC', normalizeMediaCountry, async (path, token) => {
    requests.push({ path, token: Boolean(token) });
    if (path === '/v2/auth/temporary') return { token: 'mock-temporary-token' };
    return { gif: { id: 'abc', title: 'Short clip', countryCode: 'US',
      urls: { sd: 'https://thumbs.example.org/media/abc.mp4', poster: 'https://thumbs.example.org/poster.jpg' } } };
  });
  assert.deepEqual(requests, [
    { path: '/v2/auth/temporary', token: false },
    { path: '/v2/gifs/abc', token: true },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].video, 'https://thumbs.example.org/media/abc.mp4');
  assert.equal(result[0].country, 'US');
  assert.equal(result[0].url, 'https://www.redgifs.com/watch/abc');
});

test('RedGIFs media without USA origin metadata remains eligible', () => {
  const items = normalizeRedgifsItems({ gifs: [
    { id: 'one', urls: { sd: 'https://media.example.org/a.mp4' }, country: 'NL' },
    { id: 'two', urls: { sd: 'https://media.example.org/b.mp4' } },
    { id: 'three', urls: { sd: 'https://media.example.org/c.mp4' }, country: 'USA' },
    { id: 'four', urls: { sd: 'http://private.invalid/a.mp4' }, country: 'USA' },
  ] }, normalizeMediaCountry);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(x => x.country), [null, null, 'US']);
  assert.deepEqual(eligibleMediaForSource(items, 'https://www.redgifs.com/').map(x => x.video),
    ['https://media.example.org/a.mp4', 'https://media.example.org/b.mp4',
      'https://media.example.org/c.mp4']);
});

test('Erome public albums expose separate HTTPS video files without site links as post', () => {
  const html = '<html><title>Public album</title>'
    + '<video data-country="US" data-setup="{}"><source src="https://v1.erome.com/abc/clip.mp4"></video>'
    + '<video data-country="NL"><source src="/videos/foreign.mp4"></video>'
    + '<div class="img" data-country="United States"><img data-src="https://s1.erome.com/abc/image.jpg"></div>'
    + '</html>';
  const items = parseEromeAlbum(html, 'https://www.erome.com/a/ABC', normalizeMediaCountry);
  assert.equal(items.length, 3);
  assert.equal(items[0].video, 'https://v1.erome.com/abc/clip.mp4');
  assert.equal(items[0].country, 'US');
  assert.equal(items[1].country, null);
  assert.equal(items[2].image, 'https://s1.erome.com/abc/image.jpg');
  assert.equal(items[2].country, 'US');
});

test('Erome index discovers only same-provider public album paths', () => {
  const html = '<a class="album-link" href="/a/Album1">One</a>'
    + '<a href="https://erome.com/a/Album2">Two</a>'
    + '<a href="https://other.example.com/a/unsafe">Unsafe</a>'
    + '<a href="/s/faq">FAQ</a>'
    + '<a href="/a/Album1">Duplicate</a>';
  assert.deepEqual(discoverEromeAlbums(html, 'https://erome.com/explore'), [
    'https://erome.com/a/Album1', 'https://erome.com/a/Album2',
  ]);
});

test('Erome explore performs a bounded sample and refuses blocked albums', async () => {
  const calls = [];
  const downloader = async url => {
    calls.push(url);
    if (url === 'https://erome.com/') {
      return { url, text: '<a href="/a/a1"></a><a href="/a/a2"></a><a href="/a/a3"></a><a href="/a/a4"></a>' };
    }
    if (url.endsWith('/a/a2')) throw new Error('HTTP 403');
    return { url, text: '<video data-country="US"><source src="https://v1.erome.com/ok.mp4"></video>' };
  };
  const items = await eromeMedia('https://erome.com/', normalizeMediaCountry, downloader);
  assert.equal(calls.length, 4); // index + only three albums; no bulk scraping
  assert.equal(items.length, 2);
  assert.ok(items.every(x => x.country === 'US'));
  await assert.rejects(eromeMedia('https://erome.com/s/faq', normalizeMediaCountry, downloader), /public Erome album or explore/);
});

test('unknown providers return null; RedGIFs uses only API discovery', async () => {
  const unhandled = await readCloudyProviderItems('https://example.com/', {
    normalizeCountry: normalizeMediaCountry, downloader: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(unhandled, null);
  let downloadedHtml = false;
  const returned = await readCloudyProviderItems('https://redgifs.com/watch/abc', {
    normalizeCountry: normalizeMediaCountry,
    downloader: async () => { downloadedHtml = true; throw new Error('bad'); },
    getJson: async path => path === '/v2/auth/temporary' ? { token: 'mock-token' }
      : { gif: { id: 'abc', urls: { sd: 'https://media.example.org/a.mp4' }, country: 'US' } },
  });
  assert.equal(downloadedHtml, false);
  assert.equal(returned.length, 1);
  assert.equal(returned[0].country, 'US');
});
