import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { isMusicGuide, buildMusicGuideCopy, scheduleMusicGuide } from '../src/services/music/musicGuideSticky.js';
import { registerBuilderInteraction } from '../src/utils/builderSessionCleanup.js';

const guideMessage = extra => ({ embeds: [{ title: 'Cloudy music', description: 'Owner text' }], ...extra });

test('only the real guide counts, never the Builder preview of it', () => {
  assert.equal(isMusicGuide(guideMessage()), true);
  assert.equal(isMusicGuide({ embeds: [{ title: 'Something else' }] }), false);
  registerBuilderInteraction('builder-interaction-1');
  assert.equal(isMusicGuide(guideMessage({ interaction: { id: 'builder-interaction-1' } })), false);
});

test('the moved guide keeps the owner\'s text, buttons and files, and a removed guide is never recreated', () => {
  const copy = buildMusicGuideCopy({
    content: 'Hello',
    embeds: [{ toJSON: () => ({ title: 'Cloudy music', description: 'Edited by the owner' }) }],
    components: [{ toJSON: () => ({ type: 1, components: [{ type: 2, custom_id: 'dedicated_commands:music' }] }) }],
    attachments: new Map([['1', { url: 'https://cdn.example/a.png', name: 'a.png' }]]),
  });
  assert.equal(copy.content, 'Hello');
  assert.equal(copy.embeds[0].description, 'Edited by the owner');
  assert.equal(copy.components[0].components[0].custom_id, 'dedicated_commands:music');
  assert.deepEqual(copy.files, [{ attachment: 'https://cdn.example/a.png', name: 'a.png' }]);
  assert.deepEqual(copy.allowedMentions, { parse: [] });
  assert.throws(() => buildMusicGuideCopy(null), /MUSIC_GUIDE_MISSING/);
});

test('a member message in the home server\'s music channel moves the guide; nothing else does', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = process.env.GUILD_ID;
  process.env.GUILD_ID = 'home-guild';
  try {
    const bot = { user: { id: 'bot' } };
    const music = { id: 'c-music', name: 'music', type: ChannelType.GuildText, isTextBased: () => true, rawPosition: 1, client: bot };
    const general = { id: 'c-general', name: 'general', type: ChannelType.GuildText, isTextBased: () => true, rawPosition: 0, client: bot };
    const guild = { id: 'home-guild', client: bot, channels: { cache: new Map([['c-music', music], ['c-general', general]]) } };
    const message = (channel, extra = {}) => ({ guild, channel, author: { bot: false }, client: bot, ...extra });

    assert.equal(scheduleMusicGuide(message(music)), true);
    assert.equal(scheduleMusicGuide(message(general)), false, 'another channel');
    assert.equal(scheduleMusicGuide(message(music, { author: { bot: true } })), false, 'a bot message');
    assert.equal(scheduleMusicGuide(message(music, { guild: { ...guild, id: 'other-guild' } })), false, 'another server');
    process.env.GUILD_ID = '';
    assert.equal(scheduleMusicGuide(message(music)), false, 'no home server configured');
  } finally {
    if (previous === undefined) delete process.env.GUILD_ID; else process.env.GUILD_ID = previous;
  }
});
