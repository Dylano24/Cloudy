import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSourceUrl, publicIp, parseFeedItems, htmlFeedUrl, parseWebsiteItems,
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
