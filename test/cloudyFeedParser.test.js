import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSourceUrl, publicIp, readResponsePrefix, parseFeedItems, htmlFeedUrl, parseWebsiteItems, readWebsiteItems, normalizeMediaCountry,
} from '../src/services/cloudyFeedParser.js';

test('accepts public HTTPS pages but rejects local and internal URLs', () => {
  assert.equal(validateSourceUrl('https://rust.facepunch.com/news').hostname, 'rust.facepunch.com');
  for (const value of ['http://example.org', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.1',
    'https://internal.local', 'file:///etc/passwd', 'https://user:pass@example.org']) {
    assert.throws(() => validateSourceUrl(value));
  }
});

test('rejects private DNS results and allows public IPs', () => {
  for (const value of ['127.0.0.1', '10.3.1.4', '172.16.0.10', '192.168.0.1',
    '169.254.1.3', '100.100.2.3', '::1', 'fc00::1', 'fe80::1', '203.0.113.1']) {
    assert.equal(publicIp(value), false, value);
  }
  assert.equal(publicIp('8.8.8.8'), true);
  assert.equal(publicIp('2606:4700:4700::1111'), true);
});

test('extracts RSS entries including encoded text and enclosures', () => {
  const rss = '<rss><channel><item><title>Rust &amp; gaming</title><link>https://example.org/a</link>'
    + '<description><![CDATA[<p>New patch</p>]]></description>'
    + '<enclosure url="https://example.org/image.jpg" type="image/jpeg" /></item></channel></rss>';
  assert.deepEqual(parseFeedItems(rss, 'https://example.org/feed').map(item => ({
    title: item.title, url: item.url, description: item.description, image: item.image,
  })), [{
    title: 'Rust & gaming',
    url: 'https://example.org/a',
    description: 'New patch',
    image: 'https://example.org/image.jpg',
  }]);
});

test('detects a linked RSS source on a normal webpage', () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>';
  assert.equal(htmlFeedUrl(html, 'https://news.example.org/'), 'https://news.example.org/feed.xml');
});

test('extracts randomizable individual website articles', () => {
  const html = '<article><h2>Patch notes</h2><a href="/first">Read more</a><p>Update</p></article>'
    + '<article><h2>Community event</h2><a href="/second">Read more</a></article>';
  assert.deepEqual(parseWebsiteItems(html, 'https://example.org/').map(item => item.url), [
    'https://example.org/first', 'https://example.org/second',
  ]);
});

test('reads website responses larger than the previous 1 MB limit', async () => {
  const data = new TextEncoder().encode('<html><title>Large site</title>' + ' '.repeat(1_500_000) + '</html>');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const result = await readResponsePrefix(stream);
  assert.equal(result.truncated, false);
  assert.equal(result.text.length, data.byteLength);
  assert.match(result.text, /^<html><title>Large site/);
});

test('limits oversized HTML to a bounded prefix without throwing', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<article><h2>News</h2><a href="/news">Read</a></article>' + 'x'.repeat(200)));
    },
    cancel() { cancelled = true; },
  });
  const result = await readResponsePrefix(stream, 128);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 128);
  assert.equal(cancelled, true);
});


test('detects image and video RSS media including enclosures', () => {
  const rss = '<rss><channel>'
    + '<item><title>First photo</title><link>https://example.org/album/a</link>'
    + '<enclosure url="https://cdn.example.org/photo.jpg" type="image/jpeg"/></item>'
    + '<item><title>Video clip</title><link>https://example.org/album/b</link>'
    + '<enclosure url="https://cdn.example.org/video.mp4" type="video/mp4"/></item>'
    + '</channel></rss>';
  const items = parseFeedItems(rss, 'https://example.org/rss');
  assert.equal(items[0].image, 'https://cdn.example.org/photo.jpg');
  assert.equal(items[0].video, null);
  assert.equal(items[1].video, 'https://cdn.example.org/video.mp4');
  assert.equal(items[1].image, null);
});

test('extracts public video tags and gallery figure images', () => {
  const videos = parseWebsiteItems(
    '<html><title>Clips</title><video poster="/thumb.jpg"><source src="/clip.mp4" type="video/mp4"></video></html>',
    'https://example.org/posts/video',
  );
  assert.equal(videos[0].video, 'https://example.org/clip.mp4');
  assert.equal(videos[0].image, 'https://example.org/thumb.jpg');

  const images = parseWebsiteItems(
    '<html><figure><a href="/album/1"><img src="/uploads/photo.jpg"></a>'
    + '<figcaption>First upload</figcaption></figure></html>',
    'https://example.org/',
  );
  assert.equal(images[0].url, 'https://example.org/album/1');
  assert.equal(images[0].image, 'https://example.org/uploads/photo.jpg');
});

test('does not treat a plain FAQ document as an image or video feed', () => {
  const items = parseWebsiteItems('<html><title>Frequently asked questions</title><h1>FAQ</h1></html>',
    'https://example.org/s/faq');
  assert.equal(items.length, 1);
  assert.equal(items[0].image, null);
  assert.equal(items[0].video, null);
});


test('accepts direct HTTPS image and video links as media sources', async () => {
  const image = await readWebsiteItems('https://cdn.example.org/image.jpg');
  const video = await readWebsiteItems('https://cdn.example.org/video.mp4');
  assert.equal(image[0].image, 'https://cdn.example.org/image.jpg');
  assert.equal(image[0].video, null);
  assert.equal(video[0].video, 'https://cdn.example.org/video.mp4');
  assert.equal(video[0].image, null);
});

test('continues finding media after text-only articles', () => {
  const html = '<html><title>Gallery</title>'
    + '<article><h2>Information</h2><a href="/info">Read</a></article>'
    + '<figure><img src="/uploads/new-photo.jpg"><figcaption>Gallery picture</figcaption></figure>'
    + '</html>';
  const items = parseWebsiteItems(html, 'https://example.org/gallery');
  assert.ok(items.some(item => item.image === 'https://example.org/uploads/new-photo.jpg'));
});

test('USA country normalization is exact, not a language or a domain hint', () => {
  for (const source of ['US', 'USA', 'United States', 'United States of America', '🇺🇸']) {
    assert.equal(normalizeMediaCountry(source), 'US', source);
  }
  for (const source of ['', 'NL', 'Netherlands', 'CA', 'en-US', 'English', 'United Kingdom']) {
    assert.equal(normalizeMediaCountry(source), null, source);
  }
});

test('RSS item country metadata is per post and does not assume a default region', () => {
  const rss = '<rss><channel><item><title>US clip</title><link>https://example.org/a</link>'
    + '<country>United States</country><enclosure url="https://example.org/a.mp4" type="video/mp4" /></item>'
    + '<item><title>Unmarked clip</title><link>https://example.org/b</link>'
    + '<enclosure url="https://example.org/b.mp4" type="video/mp4" /></item>'
    + '<item><title>Other clip</title><link>https://example.org/c</link>'
    + '<country>CA</country><enclosure url="https://example.org/c.mp4" type="video/mp4" /></item>'
    + '</channel></rss>';
  const results = parseFeedItems(rss, 'https://example.org/rss');
  assert.deepEqual(results.map(item => item.country), ['US', null, null]);
});

test('an HTML gallery identifies USA only from explicit item attributes', () => {
  const html = '<html><title>Media</title>'
    + '<figure data-country="USA"><img src="/usa.jpg"><figcaption>USA</figcaption></figure>'
    + '<figure data-country="DE"><img src="/europe.jpg"><figcaption>Europe</figcaption></figure>'
    + '</html>';
  const results = parseWebsiteItems(html, 'https://example.org/media');
  assert.equal(results.find(x => x.image?.includes('usa.jpg'))?.country, 'US');
  assert.equal(results.find(x => x.image?.includes('europe.jpg'))?.country, null);
});

test('a country-tagged video object is accepted but an en-US page locale is not', () => {
  const html = '<html lang="en-US"><title>Clips</title>'
    + '<script type="application/ld+json">'
    + '{"@type":"VideoObject","name":"US clip","countryOfOrigin":{"name":"United States"}}'
    + '</script><video src="/us.mp4"></video></html>';
  const results = parseWebsiteItems(html, 'https://example.org/clip');
  assert.equal(results[0].country, 'US');
  const other = parseWebsiteItems('<html lang="en-US"><title>Clip</title><video src="/x.mp4"></video></html>',
    'https://example.org/clip');
  assert.equal(other[0].country, null);
});

test('public JSON-LD VideoObject with MP4 contentUrl is a playable video source', () => {
  const html = '<html><script type="application/ld+json">'
    + JSON.stringify({
      '@type': 'VideoObject', name: 'Media clip',
      url: 'https://example.org/watch/1', contentUrl: 'https://cdn.example.org/clip.mp4?file=1',
      countryOfOrigin: { name: 'United States' },
      thumbnailUrl: 'https://cdn.example.org/thumb.jpg',
    }) + '</script></html>';
  const item = parseWebsiteItems(html, 'https://example.org/');
  assert.equal(item.length, 1);
  assert.equal(item[0].video, 'https://cdn.example.org/clip.mp4?file=1');
  assert.equal(item[0].country, 'US');
  assert.equal(item[0].url, 'https://example.org/watch/1');
});

test('JSON-LD watch page, HLS playlist and iframe are never treated as direct video files', () => {
  const records = [
    { '@type': 'VideoObject', name: 'Watch', contentUrl: 'https://example.org/watch/1' },
    { '@type': 'VideoObject', name: 'Stream', contentUrl: 'https://example.org/stream.m3u8' },
    { '@type': 'VideoObject', name: 'Embed', embedUrl: 'https://example.org/player/7' },
    { '@type': 'VideoObject', name: 'Unsafe', contentUrl: 'http://example.org/clip.mp4' },
  ];
  const html = '<html><script type="application/ld+json">'
    + JSON.stringify({ '@graph': records }) + '</script></html>';
  const items = parseWebsiteItems(html, 'https://example.org/');
  assert.equal(items.filter(item => item.video).length, 0);
});

test('nested JSON-LD ItemList videos are supported without network calls', () => {
  const html = '<html><script type="application/ld+json">'
    + JSON.stringify({
      '@type': 'ItemList',
      itemListElement: [
        { item: { '@type': 'VideoObject', name: 'Clip A', contentUrl: 'https://media.example.org/a.webm',
          countryOfOrigin: 'USA' } },
      ],
    }) + '</script></html>';
  const items = parseWebsiteItems(html, 'https://example.org/');
  assert.equal(items.length, 1);
  assert.equal(items[0].video, 'https://media.example.org/a.webm');
  assert.equal(items[0].country, 'US');
});
