import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVoteMessage, buildVoteResultMessage, compactExistingVoteFooter} from '../src/services/voteService.js';

test('both vote cards use compact native footer text instead of a gallery image that stretches on desktop', () => {
  const vote = {guildId: 'g', options: ['West', 'East'], votes: {member: 0}, question: 'Choose a map', layout: 'preview',
    endsAt: 1800000000000, optionLinks: ['https://example.test/map.png'], optionMedia: {messageId: 'pictures'}};
  for (const payload of [buildVoteMessage(vote, 1700000000000), buildVoteResultMessage({...vote, ended: true}, ['winner.png'])]) {
    const card = payload.components.find(component => component.toJSON().type === 17).toJSON();
    const footer = card.components.at(-1);
    assert.equal(footer.type, 10);
    assert.equal(footer.content, '-# © Cloudy Inc. • Quality. Innovation. Performance.');
    assert.doesNotMatch(JSON.stringify(card), /vote-footer.*\.png/);
    assert.equal(card.accent_color, 0xFFFFFF);
  }
  const result = buildVoteResultMessage({...vote, ended: true}, ['winner.png']).components[0].toJSON();
  assert.ok(result.components.some(component => component.type === 12 && component.items[0].media.url === 'attachment://winner.png'), 'the winning picture remains in the card');
});

test('an explicit existing-vote repair changes only its old footer and defaults to preview', async () => {
  const vote = {options: ['West', 'East'], votes: {member: 0}, question: 'Choose a map', endsAt: 1800000000000};
  const components = buildVoteResultMessage({...vote, ended: true}, ['winner.png']).components.map(row => row.toJSON());
  const oldFooter = {type: 12, id: 42, items: [{media: {url: 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@40fe0e6b8d22ad7ba8750cbc137fd25ab8b96eaa/assets/vote-footer-small.png'}}]};
  components[0].components[components[0].components.length - 1] = oldFooter;
  const original = structuredClone(components);
  const edits = [];
  const message = {id: 'existing-result', guildId: 'guild', channelId: 'channel', author: {id: 'cloudy'}, components,
    async edit(payload) {
      assert.deepEqual(Object.keys(payload), ['components']);
      edits.push(payload);
      this.components = structuredClone(payload.components);
      return this;
    }};
  const client = {user: {id: 'cloudy'}};
  assert.equal((await compactExistingVoteFooter(client, message)).applied, false);
  assert.deepEqual(message.components, original);
  assert.equal(edits.length, 0);
  assert.equal((await compactExistingVoteFooter(client, message, {apply: true})).applied, true);
  const expected = structuredClone(original);
  expected[0].components[expected[0].components.length - 1] = {type: 10, id: 42,
    content: '-# © Cloudy Inc. • Quality. Innovation. Performance.'};
  assert.deepEqual(message.components, expected, 'all vote counts, winners, pictures and layout stay exact');
  assert.equal((await compactExistingVoteFooter(client, message, {apply: true})).applied, false);
  assert.equal(edits.length, 1);
  message.components = buildVoteMessage({...vote, layout: 'preview', optionLinks: ['https://example.test/map.png']}, 1700000000000).components.map(row => row.toJSON());
  await assert.rejects(compactExistingVoteFooter(client, message, {apply: true}), /finished/);
  assert.equal(edits.length, 1, 'maintenance never races a live vote redraw');
  message.author.id = 'another-bot';
  await assert.rejects(compactExistingVoteFooter(client, message, {apply: true}));
  assert.equal(edits.length, 1);
});
