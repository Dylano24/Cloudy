import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  assert.match(number.description, /enter it after selecting Number/i);
});

test('roulette prompts for a missing Number bet instead of returning the old validation error', async () => {
  const source = await fs.readFile(new URL('../src/commands/Economy/roulette.js', import.meta.url), 'utf8');

  assert.match(source, /safeShowModal\(interaction, modal\)/);
  assert.match(source, /awaitModalSubmit/);
  assert.match(source, /roulette_number_value/);
  assert.match(source, /roulette_number_\$\{interaction\.id\}/);
  assert.doesNotMatch(source, /roulette_number:\$\{interaction\.id\}/);
  assert.match(source, /value >= 0/);
  assert.match(source, /value <= 36/);
  assert.doesNotMatch(source, /Roulette number required/);
});
