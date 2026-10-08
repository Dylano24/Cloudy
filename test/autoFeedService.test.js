import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedItems, validateFeedUrl } from '../src/services/autoFeedService.js';
import { hasCloudyOwnerMember } from '../src/services/ownerRoleAccess.js';

test('Auto feed accepts public websites and rejects local network targets', () => {
  assert.equal(validateFeedUrl('https://example.org/posts#here'), 'https://example.org/posts');
  for (const unsafe of [
    'file:///etc/passwd', 'http://127.0.0.1/', 'https://localhost/feed',
    'http://192.168.0.1/', 'https://admin:password@example.org/',
    'https://somewhere.local/', 'https://example.org:8080/',
  ]) {
    assert.throws(() => validateFeedUrl(unsafe));
  }
});

test('Auto feed reads RSS items including images', () => {
  const xml = '<rss><channel><item><title>First post</title><link>https://example.org/a</link>' +
    '<description><![CDATA[<p>One &amp; two</p>]]></description>' +
    '<media:content url="https://example.org/image.jpg"/></item></channel></rss>';
  assert.deepEqual(parseFeedItems(xml, 'https://example.org/'), [{
    title: 'First post', link: 'https://example.org/a',
    description: 'One & two', image: 'https://example.org/image.jpg',
  }]);
});

test('Auto feed reads Atom entries and resolves relative links', () => {
  const xml = '<feed><entry><title>Atom post</title><link href="/posts/1"/>' +
    '<summary>Short update</summary></entry></feed>';
  const items = parseFeedItems(xml, 'https://example.org/');
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://example.org/posts/1');
  assert.equal(items[0].title, 'Atom post');
});

test('Owner access requires role named Owner, not admin status', () => {
  assert.equal(hasCloudyOwnerMember({ roles: { cache: { some: fn => [{ name: 'Owner' }].some(fn) } } }), true);
  assert.equal(hasCloudyOwnerMember({ roles: { cache: { some: fn => [{ name: 'Moderator' }].some(fn) } } }), false);
});
