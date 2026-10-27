import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import help from '../src/interactions/buttons/gameHelp.js';
import { GAME_HELP, gameHelpRow } from '../src/services/gameHelpService.js';
import { isCollectorManagedComponent } from '../src/utils/collectorComponents.js';

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
