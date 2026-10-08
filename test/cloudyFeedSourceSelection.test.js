import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleMediaForSource, isVideoOnlySource, mediaSourceProblem,
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

test('video platform accepts only videos with permitted regional metadata', () => {
  const source = 'https://nl.pornhub.com/video';
  const unknown = { url: 'https://example.org/1', video: 'https://example.org/1.mp4', country: null };
  const selected = { url: 'https://example.org/2', video: 'https://example.org/2.mp4', country: 'US' };
  assert.deepEqual(eligibleMediaForSource([unknown, selected], source), [selected]);
  assert.equal(mediaSourceProblem([unknown], source), 'No matching playable media available from this website.');
  assert.equal(mediaSourceProblem([unknown, selected], source), null);
});

test('a media-empty homepage gets a precise diagnostic', () => {
  assert.equal(mediaSourceProblem([], 'https://nl.pornhub.com/'),
    'Website contains no accessible media posts.');
});
