import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import help from '../src/interactions/buttons/gameHelp.js';
import { GAME_HELP, gameHelpRow } from '../src/services/gameHelpService.js';
import { isCollectorManagedComponent } from '../src/utils/collectorComponents.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import fullResponseCapture from '../src/events/fullResponseCatalogReady.js';
import plainResponseCapture from '../src/events/plainResponseCaptureReady.js';
import { getSystemEmbedTemplateKey, primeSystemEmbedTemplateData } from '../src/services/systemEmbedCatalogService.js';

for (const game of ['blackjack', 'baccarat', 'roulette']) {
  test(`${game} Help remains usable after game collectors end without changing bets`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const id = gameHelpRow(game).toJSON().components[0].custom_id;
    assert.equal(isCollectorManagedComponent(id.split(':')[0]), false);
    let payload, deleted = false;
    await help.execute({ reply: async value => { payload = value; }, deleteReply: async () => { deleted = true; } }, {}, [game]);
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.equal(payload.content, GAME_HELP[game]);
    assert.ok(payload.content.startsWith('**How to play'));
    t.mock.timers.tick(300000); await Promise.resolve(); assert.equal(deleted, true);
  });
}
test('baccarat and blackjack explain card values before controls; roulette explains zero', () => {
  assert.ok(GAME_HELP.blackjack.indexOf('**Card values:') < GAME_HELP.blackjack.indexOf('**Hit:'));
  assert.ok(GAME_HELP.baccarat.indexOf('**Card values:') < GAME_HELP.baccarat.indexOf('**Player:'));
  assert.ok(GAME_HELP.roulette.includes('Zero is green'));
});

test('baccarat keeps the blank paragraph after Tie through both response wrappers despite an old saved guide', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const guildId = 'casino-guide-spacing';
  const context = 'gambling/game_help';
  const staleGuide = GAME_HELP.baccarat.replace('your bet.\n\nThese returns', 'your bet.\nThese returns');
  const key = getSystemEmbedTemplateKey('content', '', staleGuide, context);
  assert.equal(primeSystemEmbedTemplateData(key, context, { description: staleGuide }, guildId), true);

  // Match startup order: plain response capture wraps the full catalog capture.
  fullResponseCapture.execute({ on() {} });
  plainResponseCapture.execute();
  let sent;
  const interaction = {
    id: 'baccarat-guide-click', customId: 'game_help:baccarat', guildId,
    user: { id: 'player' },
    reply: async payload => { sent = payload; },
    editReply: async () => {}, followUp: async () => {}, deleteReply: async () => {},
  };
  InteractionHelper.patchInteractionResponses(interaction);
  await help.execute(interaction, {}, ['baccarat']);

  assert.match(sent.content, /\*\*Tie:\*\* a win returns 9 times your bet\.\n\nThese returns/);
  assert.equal(sent.flags, MessageFlags.Ephemeral);

  const noticeContext = 'utility/guide-spacing-control';
  const notice = 'Current notice';
  primeSystemEmbedTemplateData(getSystemEmbedTemplateKey('content', '', notice, noticeContext), noticeContext,
    { description: 'Saved notice' }, guildId);
  const normalInteraction = { id: 'normal-notice', customId: 'normal-notice', guildId,
    user: { id: 'player' },
    channel: { name: noticeContext },
    reply: async payload => { sent = payload; },
    editReply: async () => {}, followUp: async () => {},
  };
  InteractionHelper.patchInteractionResponses(normalInteraction);
  await normalInteraction.reply({ content: notice });
  assert.equal(sent.content, 'Saved notice', 'ordinary saved responses still apply');
});
