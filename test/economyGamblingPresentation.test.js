import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import {
  economySentenceCase,
  normalizeEconomyEmbed,
  normalizeEconomyPayload,
  normalizeEconomyInteractionPayload,
} from '../src/utils/economyGamblingPresentation.js';
import { CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';

test('titles and body labels use sentence case without damaging usernames or mentions', () => {
  assert.equal(economySentenceCase('New Bank Balance'), 'New bank balance');
  assert.equal(economySentenceCase('The Bank'), 'The bank');
  assert.equal(economySentenceCase('Player Hand'), 'Player hand');
  assert.equal(economySentenceCase("SomeGamer's Bank Balance"), "SomeGamer's bank balance");
  assert.equal(
    economySentenceCase('Cash Balance: **$50**\nThe Bank has $100 and <@123456789012345678>'),
    'Cash balance: **$50**\nThe bank has $100 and <@123456789012345678>',
  );
  const quoted = String.fromCharCode(96) + 'New Bank' + String.fromCharCode(96);
  assert.equal(economySentenceCase('Read https://cloudy.example.com/Bank/Balance and ' + quoted),
    'Read https://cloudy.example.com/Bank/Balance and ' + quoted);
});

test('win, loss, errors and neutral checks use exact existing Cloudy colors and logo', () => {
  const cases = [
    ['Baccarat Win', 0xFFFFFF, 0x00C49D],
    ['Robbery Successful', 0xFF0000, 0x00C49D],
    ['Blackjack Loss', 0x00FF00, 0x7A1712],
    ['Robbery Failed', 0xFFFFFF, 0x7A1712],
    ['Insufficient Funds', 0xFFFFFF, 0x7A1712],
    ['Bank Balance', 0x57F287, 0xFFFFFF],
    ['Baccarat — Bet $25', 0xED4245, 0xFFFFFF],
    ['Economy Leaderboard', 0xED4245, 0xFFFFFF],
  ];
  for (const [title, previousColor, expected] of cases) {
    const source = { title, color: previousColor, fields: [{ name: 'Cash Balance', value: 'The Bank: **$50**' }] };
    const changed = normalizeEconomyEmbed(source);
    assert.equal(changed.color, expected, title);
    assert.equal(changed.thumbnail.url, CLOUDY_LOGO_URL, title);
    assert.equal(changed.fields[0].name, 'Cash balance', title);
    assert.equal(changed.fields[0].value, 'The bank: **$50**', title);
    assert.equal(source.title, title, 'never mutate source objects');
  }
});

test('only economy and gambling commands are changed, not unrelated embeds', () => {
  const embed = { title: 'The Bank', color: 0x123456 };
  const payload = { embeds: [embed], components: [] };
  const manual = normalizeEconomyInteractionPayload({ commandName: 'embedbuilder' }, payload);
  const ticket = normalizeEconomyInteractionPayload({ commandName: 'ticket' }, payload);
  assert.strictEqual(manual, payload);
  assert.strictEqual(ticket, payload);
  assert.strictEqual(manual.embeds[0], embed);
  assert.equal(normalizeEconomyInteractionPayload({ commandName: 'balance' }, payload).embeds[0].title, 'The bank');
  assert.equal(normalizeEconomyInteractionPayload({ commandName: 'roulette' }, payload).embeds[0].thumbnail.url, CLOUDY_LOGO_URL);
});

test('supports discord.js EmbedBuilder and preserves author, footer and banner', () => {
  const embed = new EmbedBuilder().setTitle('Your Bank Balance')
    .setDescription('The Bank is ready.')
    .setColor(0xFFFFFF)
    .setThumbnail('https://example.com/old-logo.png')
    .setImage('https://example.com/banner.gif')
    .setAuthor({ name: 'SomeGamer' })
    .setFooter({ text: '© Cloudy Inc. • Quality. Innovation. Performance.' })
    .addFields({ name: 'Total Cash', value: '$100', inline: true });
  const result = normalizeEconomyPayload({ embeds: [embed] }).embeds[0];
  assert.strictEqual(result, embed);
  assert.equal(result.toJSON().title, 'Your bank balance');
  assert.equal(result.toJSON().thumbnail.url, CLOUDY_LOGO_URL);
  assert.equal(result.toJSON().image.url, 'https://example.com/banner.gif');
  assert.equal(result.toJSON().author.name, 'SomeGamer');
  assert.equal(result.toJSON().footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
});
