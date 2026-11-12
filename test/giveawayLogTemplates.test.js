import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGiveawayCreatedLog, buildGiveawayEndedLog, buildGiveawayWinnerCountryLog } from '../src/services/giveawayLogService.js';
import { buildGiveawayClaimLog } from '../src/services/giveawayClaimLogService.js';
import { isGiveawayLogEmbed } from '../src/services/giveawayLogTitles.js';

const GUILD = '156000000000000001';
const giveaway = {
  messageId: '156000000000000002', channelId: '156000000000000003', prize: 'Shjsjs',
  hostId: '156000000000000004', winnerCount: 1, participants: [],
  createdAt: '2026-11-12T18:32:00.000Z', endedAt: '2026-11-12T18:33:00.000Z',
};
const created = () => buildGiveawayCreatedLog(GUILD, giveaway, 22).embeds[0];
const ended = () => buildGiveawayEndedLog(GUILD, giveaway, [], 22).embeds[0];

function useTemplates(templates) {
  return import('../src/utils/database.js').then(({ db }) => {
    const stored = new Map([['cloudy:embed-template:' + GUILD + ':__global__', templates]]);
    db.initialized = true; db.useFallback = false; db.connectionType = 'test';
    db.db = { get: async key => structuredClone(stored.get(key) ?? null), set: async () => true, delete: async () => true, list: async () => [] };
  });
}

// Like production: templates saved under the old look of these titles.
const OLD_LOOK = {
  'giveaway created': { title: 'Giveaway created', color: 0x00C49D, fields: [] },
  'giveaway ended': { title: 'Giveaway ended', color: 0xFFFFFF, fields: [] },
  'other reply': { title: 'Other reply', color: 0x00C49D, fields: [] },
};

test('every giveaway log is recognised, other embeds are not', () => {
  assert.equal(isGiveawayLogEmbed(created()), true);
  assert.equal(isGiveawayLogEmbed(ended()), true);
  assert.equal(isGiveawayLogEmbed(buildGiveawayWinnerCountryLog(GUILD, giveaway, ['a'], { number: 22 }).embeds[0]), true);
  for (const event of ['opened', 'revealed', 'closed', 'expired']) {
    assert.equal(isGiveawayLogEmbed(buildGiveawayClaimLog({ event, guildId: GUILD, messageId: giveaway.messageId,
      userId: '156000000000000005', giveaway }).embeds[0]), true, event);
  }
  assert.equal(isGiveawayLogEmbed({ title: 'Giveaway created', footer: { text: 'Other bot' } }), false);
  assert.equal(isGiveawayLogEmbed({ title: 'Other reply', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }), false);
});

test('a saved template never recolours Giveaway created (white) or Giveaway ended (black) before sending', async () => {
  await useTemplates(OLD_LOOK);
  const { applySavedResponsePayloadTemplates } = await import('../src/events/fullResponseCatalogReady.js');
  const other = { title: 'Other reply', description: 'x', color: 0xFFFFFF };
  const out = await applySavedResponsePayloadTemplates({ embeds: [created(), ended(), other] }, { guildId: GUILD, channelId: 'giveaway-logs' });
  assert.equal(out.embeds[0].color, 0xFFFFFF, 'Giveaway created keeps its white side line');
  assert.equal(out.embeds[1].color, 0x010101, 'Giveaway ended keeps its black side line');
  assert.equal(out.embeds[2].color, 0x00C49D, 'other replies still follow their saved template');
});

test('the logs are never edited after sending by a saved template', async () => {
  await useTemplates(OLD_LOOK);
  const { applySavedEmbedTemplates } = await import('../src/services/embedTemplateService.js');
  for (const embed of [created(), ended()]) {
    const edits = [];
    const message = {
      id: '156000000000000099', guildId: GUILD, channelId: 'giveaway-logs', editable: true,
      channel: { name: 'giveaway-logs' }, embeds: [{ ...embed, toJSON: () => structuredClone(embed) }],
      edit: async payload => { edits.push(payload); },
    };
    await applySavedEmbedTemplates(message, { initialCreation: true });
    assert.equal(edits.length, 0, embed.title + ' is not edited');
  }
});
