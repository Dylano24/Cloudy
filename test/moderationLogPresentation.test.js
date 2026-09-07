import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import {
  CLOUDY_LOGO_URL,
  MODERATION_RESTORE_COLOR,
  MODERATION_RESTRICT_COLOR,
  enforceFixedLogPresentation,
} from '../src/services/moderationLogPresentation.js';

test('fixed moderation presentation wins over saved template styling', () => {
  for (const eventType of ['moderation.kick', 'moderation.timeout']) {
    const embed = enforceFixedLogPresentation(
      new EmbedBuilder().setColor(0x123456).setThumbnail('https://example.com/user.png'),
      { eventType },
    ).toJSON();
    assert.equal(embed.color, MODERATION_RESTRICT_COLOR);
    assert.equal(embed.thumbnail.url, CLOUDY_LOGO_URL);
  }

  for (const eventType of ['moderation.unban', 'moderation.untimeout']) {
    const embed = enforceFixedLogPresentation(new EmbedBuilder().setColor(0x123456), { eventType }).toJSON();
    assert.equal(embed.color, MODERATION_RESTORE_COLOR);
  }
});

test('ban and invite logs use the Cloudy logo without changing unrelated colors', () => {
  const ban = enforceFixedLogPresentation(new EmbedBuilder().setColor(0x520808), {
    eventType: 'moderation.ban',
  }).toJSON();
  assert.equal(ban.color, 0x520808);
  assert.equal(ban.thumbnail.url, CLOUDY_LOGO_URL);

  const created = enforceFixedLogPresentation(new EmbedBuilder().setColor(0x123456), { inviteType: 'created' }).toJSON();
  assert.equal(created.color, 0xFFFFFF);
  assert.equal(created.thumbnail.url, CLOUDY_LOGO_URL);

  const joined = enforceFixedLogPresentation(new EmbedBuilder().setColor(0x123456), { inviteType: 'joined' }).toJSON();
  assert.equal(joined.color, MODERATION_RESTORE_COLOR);
  assert.equal(joined.thumbnail.url, CLOUDY_LOGO_URL);
});
