import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSourceUrl, publicIp, readResponsePrefix, parseFeedItems, htmlFeedUrl, parseWebsiteItems,
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
