import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags, ApplicationCommandOptionType } from 'discord.js';
import auto from '../src/commands/Tools/auto.js';
import { buildCloudyFeedDashboard, channelChooser, feedChooser, parseAutoMessageTime, formatAutoMessage } from '../src/services/cloudyFeedDashboardService.js';

test('Cloudy feed slash command uses /auto feed and default disabled visibility', () => {
  const data = auto.data.toJSON();
  assert.equal(data.name, 'auto');
  assert.equal(data.default_member_permissions, '0');
  assert.equal(data.options[0].name, 'feed');
  assert.equal(data.options[0].type, ApplicationCommandOptionType.Subcommand);
});

test('Cloudy feed dashboard keeps exact copy and uses a blue Pause feed button', () => {
  const result = buildCloudyFeedDashboard('1532882647838228723', [{
    id: 'aabbccdd', source: 'https://example.org/feed', channelId: '1532882647838228724',
    minutes: 120, active: true, recentUrls: [],
  }]);
  const embed = result.embeds[0].toJSON();
  assert.equal(embed.title, 'Cloudy feed');
  assert.equal(embed.description, 'Configure automatic posts from websites. Cloudy will randomly select new content and post it to your chosen channel.');
  assert.match(embed.fields[0].value, /Auto message:\*\* 2h/);
  assert.doesNotMatch(embed.fields[0].value, /Duplicates|Random posts|Channel ID/);
  const buttons = result.components[0].components;
  assert.deepEqual(buttons.map(button => button.data.label), ['Add feed', 'Edit feed', 'Pause feed', 'Delete feed']);
  assert.equal(buttons[2].data.style, ButtonStyle.Primary);
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
  const embed = buildCloudyFeedDashboard('1532882647838228723', [{
    id: 'aabbccdd', source: 'https://example.org/feed', channelId: '1532882647838228724',
    minutes: 1, active: true,
  }]).embeds[0].toJSON();
  assert.match(embed.fields[0].value, /Auto message:\*\* 1m/);
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
  assert.equal(result.components[1].components[0].data.custom_id, 'cloudyfeed:back:abc123');
});
