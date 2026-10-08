import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaCandidates } from '../src/services/cloudyFeedService.js';
import { buildCloudyFeedDashboard, feedDetail } from '../src/services/cloudyFeedDashboardService.js';

test('feed accepts supported photos and videos regardless of origin country', () => {
  const items = [
    { url: 'https://example.org/us', image: 'https://example.org/us.jpg', country: 'US' },
    { url: 'https://example.org/foreign', video: 'https://example.org/c.mp4', country: 'CA' },
    { url: 'https://example.org/unknown', video: 'https://example.org/d.mp4', country: null },
    { url: 'https://example.org/us-article', country: 'US' },
  ];
  assert.deepEqual(mediaCandidates(items).map(item => item.url), [
    'https://example.org/us', 'https://example.org/foreign', 'https://example.org/unknown',
  ]);
});

test('USA filtering is not shown in main dashboard or selected feed detail', () => {
  const feed = {
    id: '04db1b8f', name: 'Media', channelId: '1532882647838228724',
    source: 'https://example.org/media', minutes: 5, active: true,
    lastError: 'No matching media found',
  };
  const main = buildCloudyFeedDashboard('1532882647838228723', [feed]);
  const detail = feedDetail({ id: 'abc123' }, feed);
  assert.equal(main.embeds[0].toJSON().fields, undefined);
  assert.doesNotMatch(main.embeds[0].toJSON().description, /Region|USA only|USA-tagged/);
  const value = detail.embeds[0].toJSON().fields[0].value;
  assert.doesNotMatch(value, /Region|USA only|USA-tagged/);
  assert.match(value, /No matching media found/);
});

test('existing feeds with no USA check are not falsely marked USA-tagged media available', () => {
  const feed = {
    id: '04db1b8f', source: 'https://example.org/gallery', channelId: '1532882647838228724',
    minutes: 10, active: true, lastCheck: Date.now(), lastUsCheck: undefined,
  };
  const detail = feedDetail({ id: 'abc123' }, feed);
  assert.match(detail.embeds[0].toJSON().fields[0].value, /Source check:\*\* Not checked/);
});
