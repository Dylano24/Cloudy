import test from 'node:test';
import assert from 'node:assert/strict';
import roulette from '../src/commands/Economy/roulette.js';

test('roulette exposes fixed bet choices and an optional 0-36 number option', () => {
  const data = roulette.data.toJSON();
  const amount = data.options.find(option => option.name === 'amount');
  const bet = data.options.find(option => option.name === 'bet');
  const number = data.options.find(option => option.name === 'number');

  assert.ok(amount, 'amount option is required');
  assert.equal(amount.required, true);
  assert.equal(amount.min_value, 1);

  assert.ok(bet, 'bet option is required');
  assert.equal(bet.required, true);
  assert.deepEqual(
    bet.choices.map(choice => [choice.name, choice.value]),
    [
      ['Red', 'red'],
      ['Black', 'black'],
      ['Even', 'even'],
      ['Odd', 'odd'],
      ['Number', 'number'],
    ],
  );

  assert.ok(number, 'number option exists');
  assert.equal(number.required, false);
  assert.equal(number.min_value, 0);
  assert.equal(number.max_value, 36);
});
