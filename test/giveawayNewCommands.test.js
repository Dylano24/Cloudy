import test from 'node:test';
import assert from 'node:assert/strict';
import command from '../src/commands/Giveaway/giveaway.js';
import { createDeleteConfirmation, createGiveawayManagePanel, createGiveawayEmbed, createWinnerAnnouncement } from '../src/services/giveawayService.js';
import { giveawayTextModalHandler } from '../src/handlers/giveawayButtons.js';

const giveaway = {
  messageId: '123456789012345678',
  prize: 'Yes',
  participants: [],
  endsAt: Date.now() + 3600_000,
  winnerCount: 1,
};

test('/giveaway create is the new giveaway slash entry point', () => {
  const data = command.data.toJSON();
  assert.equal(data.name, 'giveaway');
  assert.deepEqual(data.options.map(option => option.name), ['create']);
  assert.equal(data.options[0].description, 'Open the giveaway builder to create and set a giveaway.');
});

test('manage buttons match the required order, IDs and branding', () => {
  const panel = createGiveawayManagePanel(giveaway);
  const rows = panel.components.map(row => row.toJSON().components);
  assert.deepEqual(rows.map(row => row.map(button => button.label)), [
    ['Reroll', 'Edit text', 'Edit timer'],
    ['End', 'View participants', 'Delete'],
  ]);
  assert.deepEqual(rows.flat().map(button => button.custom_id), [
    'giveaway_admin:reroll:123456789012345678',
    'giveaway_admin:text:123456789012345678',
    'giveaway_admin:timer:123456789012345678',
    'giveaway_admin:end:123456789012345678',
    'giveaway_admin:participants:123456789012345678',
    'giveaway_admin:delete:123456789012345678',
  ]);
  assert.ok(panel.embeds[0].thumbnail.url);
  assert.ok(createDeleteConfirmation(giveaway).embeds[0].thumbnail.url);
  assert.equal(giveawayTextModalHandler.customId, 'giveaway_text');
});

test('final giveaway and announcement have the required copy', () => {
  const final = createGiveawayEmbed({ ...giveaway, ended: true, endedAt: new Date().toISOString() }, 'ended', ['555']);
  assert.match(final.description, /Giveaway ended!/);
  assert.match(final.description, /The winner\(s\) have been announced and tagged below!/);
  const announcement = createWinnerAnnouncement(giveaway, ['555']);
  assert.match(announcement.embeds[0].description, /Congratulations!/);
  assert.match(announcement.embeds[0].description, /Please open a support ticket within 24 hours/);
  assert.match(announcement.embeds[0].description, /Failure to claim your prize within this timeframe/);
});
