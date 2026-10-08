import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleMediaForSource, isVideoOnlySource, mediaSourceProblem, parseMediaType,
} from '../src/services/cloudyFeedService.js';

test('video platforms are matched by exact host rather than a lookalike domain', () => {
  assert.equal(isVideoOnlySource('https://nl.pornhub.com/'), true);
  assert.equal(isVideoOnlySource('https://www.pornhub.com/'), true);
  assert.equal(isVideoOnlySource('https://notpornhub.com/'), false);
  assert.equal(isVideoOnlySource('https://pornhub.com.evil.invalid/'), false);
});

test('porn website thumbnails cannot be posted in place of playable videos', () => {
  const source = 'https://nl.pornhub.com/';
  const thumbnail = {
    title: 'A thumbnail', url: 'https://www.pornhub.com/view_video.php?viewkey=abc',
    image: 'https://cdn.example.org/thumbnail.jpg', video: null, country: 'US',
  };
  assert.deepEqual(eligibleMediaForSource([thumbnail], source), []);
  assert.match(mediaSourceProblem([thumbnail], source), /does not provide directly playable video/);
  assert.equal(eligibleMediaForSource([thumbnail], 'https://example.org/gallery').length, 1);
});

test('video platform accepts video regardless of country metadata', () => {
  const source = 'https://nl.pornhub.com/video';
  const unknown = { url: 'https://example.org/1', video: 'https://example.org/1.mp4', country: null };
  const selected = { url: 'https://example.org/2', video: 'https://example.org/2.mp4', country: 'US' };
  assert.deepEqual(eligibleMediaForSource([unknown, selected], source), [unknown, selected]);
  assert.equal(mediaSourceProblem([unknown], source), null);
  assert.equal(mediaSourceProblem([unknown, selected], source), null);
});

test('a media-empty homepage gets a precise diagnostic', () => {
  assert.equal(mediaSourceProblem([], 'https://nl.pornhub.com/'),
    'Website contains no accessible media posts.');
});

test('selection requires one and only one recognized media type', () => {
  assert.equal(parseMediaType('video'), 'video');
  assert.equal(parseMediaType('picture'), 'picture');
  for (const invalid of [undefined, null, '', 'all', 'both', 'Video', 'photo', 'video,picture']) {
    assert.throws(() => parseMediaType(invalid), /Choose Videos only or Pictures only/);
  }
});

test('Videos only never posts pictures; Pictures only never posts video posters', () => {
  const source = 'https://example.org/gallery';
  const movie = { url: 'https://example.org/v', video: 'https://cdn.example.org/real.mp4',
    image: 'https://cdn.example.org/video-thumbnail.jpg' };
  const picture = { url: 'https://example.org/p', image: 'https://cdn.example.org/real.jpg' };
  const bareVideo = { url: 'https://example.org/b', video: 'https://cdn.example.org/second.webm' };
  const items = [movie, picture, bareVideo];
  assert.deepEqual(eligibleMediaForSource(items, source, 'video'), [movie, bareVideo]);
  assert.deepEqual(eligibleMediaForSource(items, source, 'picture'), [picture]);
  assert.deepEqual(eligibleMediaForSource(items, source), items,
    'pre-existing feeds without selected type should not change');
  assert.equal(mediaSourceProblem([movie], source, 'picture'),
    'No matching pictures available from this website.');
  assert.equal(mediaSourceProblem([picture], source, 'video'),
    'No matching playable videos available from this website.');
  assert.equal(mediaSourceProblem([picture], source, 'picture'), null);
  assert.equal(mediaSourceProblem([movie], source, 'video'), null);
  assert.deepEqual(eligibleMediaForSource([movie], 'https://nl.pornhub.com/', 'picture'), [],
    'video-only site thumbnails are not photos');
});
