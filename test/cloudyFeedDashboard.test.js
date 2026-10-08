import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, ApplicationCommandOptionType } from 'discord.js';
import { CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';
import { CLOUDY_BRANDING } from '../src/services/cloudyBrandingService.js';
import auto from '../src/commands/Tools/auto.js';
import { buildCloudyFeedDashboard, channelChooser, feedChooser, feedDetail, feedModal, readableFeedName, parseAutoMessageTime, formatAutoMessage } from '../src/services/cloudyFeedDashboardService.js';

test('Cloudy feed slash command uses /auto feed and default disabled visibility', () => {
  const data = auto.data.toJSON();
  assert.equal(data.name, 'auto');
  assert.equal(data.default_member_permissions, '0');
  assert.equal(data.options[0].name, 'feed');
  assert.equal(data.options[0].type, ApplicationCommandOptionType.Subcommand);
});

test('Cloudy feed main embed only shows its original title and description', () => {
  const feed = {
    id: 'aabbccdd', name: 'Pornhub', source: 'https://nl.pornhub.com/',
    channelId: '1532882647838228724', minutes: 120, active: true,
    lastError: 'No matching media found',
  };
  for (const feeds of [[], [feed]]) {
    const result = buildCloudyFeedDashboard('1532882647838228723', feeds);
    const embed = result.embeds[0].toJSON();
    assert.equal(embed.title, 'Cloudy feed');
    assert.equal(embed.description,
      'Configure automatic posts from websites. Cloudy will randomly select new content and post it to your chosen channel.\n\u200B');
    assert.equal(embed.fields, undefined, 'No source/channel/timer/status in main dashboard');
    assert.equal(embed.thumbnail.url, CLOUDY_LOGO_URL);
    assert.equal(embed.footer.text, CLOUDY_BRANDING);
    const buttons = result.components[0].components;
    assert.deepEqual(buttons.map(button => button.data.label), ['Add feed', 'Manage feed']);
    assert.equal(buttons[1].data.disabled, feeds.length === 0);
  }
});

test('Auto message accepts minutes and hours from 1m through 168h', () => {
  assert.equal(parseAutoMessageTime('1m'), 1);
  assert.equal(parseAutoMessageTime('30m'), 30);
  assert.equal(parseAutoMessageTime('1h'), 60);
  assert.equal(parseAutoMessageTime('2H'), 120);
  assert.equal(parseAutoMessageTime('168h'), 10080);
  assert.equal(parseAutoMessageTime('', 90), 90);
  for (const invalid of ['', '0m', '-1h', '1.5h', '169h', '10081m', '5', 'wrong']) {
    assert.throws(() => parseAutoMessageTime(invalid), invalid);
  }
});

test('Auto message displays short duration units', () => {
  assert.equal(formatAutoMessage(1), '1m');
  assert.equal(formatAutoMessage(30), '30m');
  assert.equal(formatAutoMessage(60), '1h');
  assert.equal(formatAutoMessage(120), '2h');
  assert.equal(formatAutoMessage(90), '90m');
  const detail = feedDetail({ id: 'abc123' }, {
    id: 'aabbccdd', source: 'https://example.org/feed', channelId: '1532882647838228724',
    minutes: 1, active: true,
  }).embeds[0].toJSON();
  assert.match(detail.fields[0].value, /Auto message:\*\* 1m/);
});

test('channel picker has a Back button for new feeds and edit feeds', () => {
  const session = { id: 'session123', guildId: '1532882647838228723' };
  const create = channelChooser(session);
  const edit = channelChooser(session, true);
  assert.equal(create.components.length, 2);
  assert.equal(create.components[0].components[0].data.placeholder, 'Select a channel');
  assert.deepEqual(create.components[1].components.map(b => b.data.label), ['Back']);
  assert.equal(create.components[1].components[0].data.custom_id, 'cloudyfeed:back:session123');
  assert.deepEqual(edit.components[1].components.map(b => b.data.label), ['Keep current channel', 'Back']);
});

test('feed selection also has a Back button without changing the choices', () => {
  const result = feedChooser({ id: 'abc123' }, [{
    id: 'aabbccdd', source: 'https://example.org/feed',
  }]);
  assert.equal(result.components[0].components[0].toJSON().options[0].value, 'aabbccdd');
  assert.match(result.components[0].components[0].toJSON().options[0].label, /Example/);
  assert.equal(result.components[1].components[0].data.custom_id, 'cloudyfeed:back:abc123');
});

test('selected feed detail displays full source, channel, interval and dynamic pause or resume', () => {
  const session = { id: 'abc123' };
  const feed = {
    id: '04db1b8f', name: 'Media updates', channelId: '1532882647838228724',
    source: 'https://example.org/media', minutes: 5, active: true,
    lastError: 'No supported photos or videos found',
  };
  assert.equal(readableFeedName(feed), 'Media updates');
  const active = feedDetail(session, feed);
  const card = active.embeds[0].toJSON().fields[0].value;
  assert.match(card, /https:\/\/example.org\/media/);
  assert.match(card, /<\#1532882647838228724>/);
  assert.match(card, /5m/);
  assert.match(card, /No supported photos or videos found/);
  assert.deepEqual(active.components[0].components.map(button => button.data.label),
    ['Edit feed', 'Pause feed', 'Delete feed', 'Back']);
  assert.equal(active.components[0].components[1].data.style, ButtonStyle.Primary);

  const paused = feedDetail(session, { ...feed, active: false });
  assert.equal(paused.components[0].components[1].data.label, 'Resume feed');
  assert.equal(paused.components[0].components[1].data.style, ButtonStyle.Success);
});

test('feed chooser shows a readable name and destination channel', () => {
  const session = {
    id: 'abc123',
    guild: { channels: { cache: new Map([['1532882647838228724', { name: 'nsfw' }]]) } },
  };
  const result = feedChooser(session, [{
    id: '04db1b8f', name: 'Media updates', source: 'https://example.org/gallery',
    channelId: '1532882647838228724', minutes: 5, active: false,
  }]);
  const item = result.components[0].components[0].toJSON().options[0];
  assert.equal(item.label, 'Media updates • #nsfw');
  assert.match(item.description, /5m • Paused/);
});

test('all feed embeds keep C logo and footer without a white separator', () => {
  const feed = {
    id: 'aaa', name: 'Media', source: 'https://example.org/videos',
    channelId: '1532882647838228724', minutes: 1, active: true,
  };
  const main = buildCloudyFeedDashboard('1532882647838228723', [feed]);
  const chooser = feedChooser({ id: 'session1' }, [feed]);
  const detail = feedDetail({ id: 'session1' }, feed);
  for (const panel of [main, chooser, detail]) {
    const embed = panel.embeds[0].toJSON();
    assert.equal(embed.thumbnail.url, CLOUDY_LOGO_URL);
    assert.equal(embed.footer.text, CLOUDY_BRANDING);
    assert.equal(embed.color, 0xFFFFFF);
  }
  const value = detail.embeds[0].toJSON().fields[0].value;
  assert.match(value, /Source:\*\* https:\/\/example.org\/videos\n\*\*Channel:/);
  assert.doesNotMatch(value, /━/);
  assert.doesNotMatch(JSON.stringify(main.embeds[0].toJSON()), /https:\/\/example.org/);
});

test('Edit feed contains only the original four fields and preserves the current channel', () => {
  const session = {
    id: 'session1', action: 'edit',
    feed: {
      id: 'abc', source: 'https://example.org/videos', name: 'Media',
      channelId: '1532882647838228724', minutes: 5, adult: true,
    },
  };
  const modal = feedModal(session).toJSON();
  assert.equal(modal.title, 'Edit feed');
  assert.equal(modal.components.length, 4);
  assert.deepEqual(modal.components.map(x => x.label),
    ['Feed name', 'Website URL', 'Auto message', '18+ content']);
  assert.doesNotMatch(JSON.stringify(modal), /feedChannel|Channel \(optional\)|channel.*select/i);
});

test('Feed name uses a neutral placeholder without changing saved names', () => {
  const add = feedModal({ id: 'session1', action: 'add' }).toJSON();
  const edit = feedModal({
    id: 'session1', action: 'edit',
    feed: { id: 'abc', source: 'https://example.org/media', name: 'My feed', minutes: 5, adult: false },
  }).toJSON();
  assert.match(JSON.stringify(add), /Enter feed name/);
  assert.match(JSON.stringify(edit), /Enter feed name/);
  assert.doesNotMatch(JSON.stringify(add), /Erome/);
  assert.doesNotMatch(JSON.stringify(edit), /Erome/);
  assert.match(JSON.stringify(edit), /"value":"My feed"/);
});
