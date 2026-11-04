import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { clearAllRateLimits } from '../src/utils/rateLimiter.js';
import {
  createGiveawayButtons,
  createGiveawayEmbed,
  createWinnerAnnouncement,
  giveawayPing,
  DEFAULT_GIVEAWAY_CLAIM,
  DEFAULT_GIVEAWAY_FAILURE,
  LEGACY_GIVEAWAY_CLAIM,
  LEGACY_GIVEAWAY_FAILURE,
  PREVIOUS_GIVEAWAY_CLAIM,
  FORMER_GIVEAWAY_CLAIM,
  parseDuration,
} from '../src/services/giveawayService.js';
import {
  checkGiveaways, checkUnclaimedGiveawayWinners, finishGiveaway,
  GIVEAWAY_WINNER_CLAIM_WINDOW_MS, loadGiveaway, refreshExistingGiveawayClaimInstructions, refreshEndedGiveawayClosingCopy, reorderEndedGiveawayDescription,
} from '../src/services/giveawayActions.js';
import buttons from '../src/interactions/buttons/giveaway/giveaway.js';
import timerModal from '../src/interactions/modals/giveawayTimer.js';
import textModal from '../src/interactions/modals/giveawayText.js';
import create from '../src/commands/Giveaway/gcreate.js';
import { handleGiveawayBuilderInteraction } from '../src/services/giveawayBuilderService.js';
import { giveawayClaimModalHandler } from '../src/handlers/giveawayButtons.js';

const GUILD = 'giveaway-guild';
const MESSAGE = '1565600000000000001';
const json = value => value?.toJSON?.() || value;
const settle = () => new Promise(resolve => { setImmediate(resolve); });
const button = name => buttons.find(entry => entry.name === name);

function world(stored = {}) {
  const values = new Map([[`guild:${GUILD}:giveaways`, structuredClone(stored)]]);
  const client = {
    db: {
      get: async (key, fallback) => structuredClone(values.get(key) ?? fallback),
      set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
      list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
    },
    guilds: { cache: new Collection() },
    channels: { fetch: async () => null },
  };
  const sent = [];
  const deleted = [];
  const giveawayMessage = { id: MESSAGE, edits: [], edit: async payload => { giveawayMessage.edits.push(payload); return giveawayMessage; },
    delete: async () => { deleted.push(MESSAGE); } };
  const channel = { id: 'giveaways', isTextBased: () => true,
    messages: { fetch: async id => (id === MESSAGE && !deleted.includes(MESSAGE) ? giveawayMessage : null) },
    send: async payload => { const message = { id: String(1565600000000000100n + BigInt(sent.length)), ...payload, delete: async () => { deleted.push(message.id); } }; sent.push(message); return message; } };
  const guild = { id: GUILD, ownerId: 'owner', channels: { cache: new Collection([[channel.id, channel]]) } };
  client.guilds.cache.set(GUILD, guild);
  const member = (id, permissions = 0n) => ({ id, permissions: { has: flag => (BigInt(permissions) & BigInt(flag)) === BigInt(flag) }, roles: { cache: new Collection() } });
  function interaction(user = 'member', { staff = false, args = {} } = {}) {
    const result = { guildId: GUILD, guild, client, user: { id: user }, member: {
      ...member(user, staff ? PermissionFlagsBits.ManageGuild : 0n),
      roles: { cache: staff ? new Collection([['owner', { name: 'Owner' }]]) : new Collection() },
    },
      message: giveawayMessage, inGuild: () => true, replies: [], replied: false, deferred: false, ...args,
      update: async payload => { result.updated = payload; result.replied = true; },
      reply: async payload => { result.replies.push(payload); result.replied = true; },
      followUp: async payload => { result.replies.push(payload); return { id: `follow-up-${result.replies.length}` }; },
      deleted: [],
      deleteReply: async target => { result.deleted.push(target?.id ?? '@original'); },
      deferUpdate: async () => { result.deferred = true; },
      deferReply: async () => { result.deferred = true; },
      editReply: async payload => { result.edited = payload; },
      showModal: async modal => { result.modal = modal.toJSON(); } };
    return result;
  }
  return { client, values, sent, deleted, giveawayMessage, channel, guild, interaction };
}

const activeGiveaway = (extra = {}) => ({ messageId: MESSAGE, channelId: 'giveaways', guildId: GUILD, prize: '1 month vip',
  winnerCount: 1, participants: [], endsAt: Date.now() + 3_600_000, ended: false, isEnded: false, ...extra });

test('giveaway embed follows the owner layout: emojis, prize, requirements, winners, end time', () => {
  const giveaway = activeGiveaway({ endsAt: 1_800_000_000_000 });
  const embed = createGiveawayEmbed(giveaway, 'active');
  assert.equal(embed.description, [
    '<a:W89gift:1557507008284987442> **Giveaway time!**',
    '',
    'Cloudy Inc. is giving you the chance to win something special!',
    '',
    '<:W89zgiveway:1557507484812312727> **1 month vip**',
    '',
    '**Hosted by**',
    'Not specified',
    '',
    '**Requirements**',
    'None',
    '',
    '**Winners**',
    '1',
    '',
    '**Participants**',
    '0',
    '',
    '**Good luck to everyone!**',
    '',
    '<a:W89timer:1557506643372146778> **Giveaway ends**',
    '<t:1800000000:F> (<t:1800000000:R>)',
  ].join('\n'));
  assert.equal(embed.color, 0xFFFFFF);
  // A personal description and requirements replace the defaults.
  const custom = createGiveawayEmbed(activeGiveaway({ description: 'Win big!', requirements: 'Level 5' }), 'active');
  assert.match(custom.description, /\*\*Giveaway time!\*\*\n\nWin big!\n/);
  assert.match(custom.description, /\*\*Requirements\*\*\nLevel 5\n/);
  const customClosing = createGiveawayEmbed(activeGiveaway({ closingText: 'Best of luck!' }), 'active');
  assert.match(customClosing.description, /\*\*Best of luck!\*\*\n\n<a:W89timer:1557506643372146778> \*\*Giveaway ends\*\*/);
  // Ended: winners tagged, green, ended time.
  const ended = createGiveawayEmbed(activeGiveaway({ endedAt: new Date(1_800_000_000_000).toISOString() }), 'ended', ['a', 'b']);
  assert.match(ended.description, /\*\*Winners\*\*\n<@a>, <@b>\n/);
  assert.ok(ended.description.includes('Thank you to everyone who participated!'));
  assert.match(ended.description, /\*\*Participants\*\*\n0\n\nThe winner\(s\) have been announced and tagged!\n\n<a:W89timer:1557506643372146778> \*\*Giveaway ended\*\*\n<t:1800000000:F>$/);
  assert.doesNotMatch(ended.description, /This giveaway has ended!/);
  assert.equal(ended.color, 0xFFFFFF);
});

test('ended giveaways with no winners retain the original text in the requested order', () => {
  const embed = createGiveawayEmbed(activeGiveaway({ ended: true, isEnded: true }), 'ended', []);
  assert.match(embed.description, /No valid entries/);
  assert.match(embed.description, /The winner\(s\) have been announced and tagged!/);
  assert.doesNotMatch(embed.description, /This giveaway has ended!/);
});

test('existing ended giveaway messages are reordered in place without changing buttons or footer', async () => {
  const giveaway = activeGiveaway({
    ended: true, isEnded: true, endedAt: new Date().toISOString(), winnerIds: [],
  });
  const w = world({ [MESSAGE]: giveaway });
  w.client.user = { id: 'cloudy-bot' };
  w.giveawayMessage.author = { id: 'cloudy-bot' };
  const original = {
    description: 'Thank you to everyone who participated!\n\n<a:W89timer:1557506643372146778> **Giveaway ended**\n<t:1800000000:F>\n\nThis giveaway has ended!',
    color: 0xFFFFFF,
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    thumbnail: { url: 'https://example.test/cloudy.png' },
  };
  w.giveawayMessage.embeds = [{ toJSON: () => structuredClone(original) }];
  await refreshEndedGiveawayClosingCopy(w.client);
  assert.equal(w.giveawayMessage.edits.length, 1);
  const edit = w.giveawayMessage.edits[0];
  assert.equal(edit.components, undefined);
  assert.equal(edit.embeds[0].description,
    'Thank you to everyone who participated!\n\nThe winner(s) have been announced and tagged!\n\n<a:W89timer:1557506643372146778> **Giveaway ended**\n<t:1800000000:F>');
  assert.equal(edit.embeds[0].color, original.color);
  assert.deepEqual(edit.embeds[0].footer, original.footer);
  assert.deepEqual(edit.embeds[0].thumbnail, original.thumbnail);
  await refreshEndedGiveawayClosingCopy(w.client);
  assert.equal(w.giveawayMessage.edits.length, 1, 'restart reconciliation is idempotent');
});

test('already-ended giveaway removes only below from posted copy without changing the embed or buttons', async () => {
  const giveaway = activeGiveaway({
    ended: true, isEnded: true, endedAt: new Date().toISOString(), winnerIds: ['winner'],
  });
  const w = world({ [MESSAGE]: giveaway });
  w.client.user = { id: 'cloudy-bot' };
  w.giveawayMessage.author = { id: 'cloudy-bot' };
  const original = {
    description: '**Giveaway ended!**\n\nThank you to everyone who participated!\n\n' +
      '**Winners**\n<@winner>\n\n**Participants**\n1\n\n' +
      'The winner(s) have been announced and tagged below!\n\n' +
      '<a:W89timer:1557506643372146778> **Giveaway ended**\n<t:1800000000:F>',
    color: 0xFFFFFF,
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    thumbnail: { url: 'https://example.test/cloudy.png' },
  };
  w.giveawayMessage.embeds = [{ toJSON: () => structuredClone(original) }];
  await refreshEndedGiveawayClosingCopy(w.client);
  assert.equal(w.giveawayMessage.edits.length, 1);
  const updated = w.giveawayMessage.edits[0];
  assert.equal(updated.components, undefined);
  assert.deepEqual(updated.embeds, [{
    ...original,
    description: original.description.replace('tagged below!', 'tagged!'),
  }]);
  assert.equal(w.values.get('guild:' + GUILD + ':giveaway:ended-copy-order-v3'), true);
  await refreshEndedGiveawayClosingCopy(w.client);
  assert.equal(w.giveawayMessage.edits.length, 1);
});

test('existing giveaway swap keeps both original lines unchanged', () => {
  const prefix = 'All other original giveaway content';
  const timer = '<a:W89timer:1557506643372146778> **Giveaway ended**\n<t:1800000000:F>';
  const copy = 'The winner(s) have been announced and tagged!';
  const expected = prefix + '\n\n' + copy + '\n\n' + timer;
  for (const lastLine of [copy, 'This giveaway has ended!', 'The winner(s) have been announced and tagged below!']) {
    assert.equal(reorderEndedGiveawayDescription(prefix + '\n\n' + timer + '\n\n' + lastLine), expected);
  }
  assert.equal(reorderEndedGiveawayDescription(expected), expected);
  assert.equal(reorderEndedGiveawayDescription(prefix + '\n\nThe winner(s) have been announced and tagged below!\n\n' + timer), expected);
  assert.equal(reorderEndedGiveawayDescription(prefix + '\n\nThe winner(s) have been announced and tagged!\n\n' + timer), expected);
  assert.equal(reorderEndedGiveawayDescription(prefix + '\n\n' + timer), prefix + '\n\n' + timer);
});

test('public giveaway posts contain only participant buttons; no Manage button', () => {
  const rows = createGiveawayButtons(activeGiveaway({ participants: ['a', 'b', 'c'] })).map(json);
  assert.equal(rows.length, 1);
  const [entry] = rows;
  assert.deepEqual(entry.components.map(component => component.label), ['Enter giveaway', 'Leave giveaway']);
  assert.equal(entry.components[0].emoji.id, '1543303914152001536');
  assert.equal(entry.components[1].emoji.id, '1565742837453029516');
  assert.equal(entry.components[1].emoji.animated, true);
  assert.equal(entry.components[0].style, 2);
  assert.equal(entry.components[1].style, 2);
  const endedRows = createGiveawayButtons(activeGiveaway({ participants: ['a'], ended: true })).map(json);
  assert.equal(endedRows.length, 1);
  assert.deepEqual(endedRows[0].components.map(component => [component.label, component.disabled]), [['Enter giveaway', true]]);
});

test('ping tags @everyone, one role, or nobody', () => {
  assert.deepEqual(giveawayPing({ id: GUILD }, GUILD), { content: '@everyone', allowedMentions: { parse: ['everyone'] } });
  assert.deepEqual(giveawayPing({ id: 'giveaway-role' }, GUILD), { content: '<@&giveaway-role>', allowedMentions: { parse: [], roles: ['giveaway-role'] } });
  assert.deepEqual(giveawayPing(null, GUILD), { content: undefined, allowedMentions: { parse: [] } });
});

test('Enter and Leave update the entry count; repeats and ended giveaways get a private warning', async () => {
  clearAllRateLimits();
  const w = world({ [MESSAGE]: activeGiveaway() });
  const enter = w.interaction('member');
  await button('giveaway_enter').execute(enter, w.client);
  assert.deepEqual((await loadGiveaway(w.client, GUILD, MESSAGE)).participants, ['member']);
  // Acknowledged at once, then the giveaway (entry count) is refreshed.
  assert.equal(enter.deferred, true);
  assert.equal(json(enter.edited.components[0]).components[0].label, 'Enter giveaway');
  assert.match(enter.edited.embeds[0].description, /\*\*Winners\*\*\n1\n\n\*\*Participants\*\*\n1\n\n/);
  assert.equal(json(enter.replies[0].embeds[0]).title, 'Success');
  assert.equal(json(enter.replies[0].embeds[0]).description, 'You entered the giveaway.\n\nGood luck!');

  clearAllRateLimits();
  const again = w.interaction('member');
  await button('giveaway_enter').execute(again, w.client);
  assert.equal(again.edited, undefined);
  assert.match(JSON.stringify(json(again.replies[0].embeds[0])), /already entered/);

  clearAllRateLimits();
  const leave = w.interaction('member');
  await button('giveaway_leave').execute(leave, w.client);
  assert.deepEqual((await loadGiveaway(w.client, GUILD, MESSAGE)).participants, []);
  assert.equal(json(leave.edited.components[0]).components[0].label, 'Enter giveaway');
  assert.match(leave.edited.embeds[0].description, /\*\*Participants\*\*\n0\n\n/);
  assert.deepEqual(json(leave.edited.components[0]).components.map(component => component.custom_id), ['giveaway_enter', 'giveaway_leave']);

  clearAllRateLimits();
  const notIn = w.interaction('member');
  await button('giveaway_leave').execute(notIn, w.client);
  assert.match(JSON.stringify(json(notIn.replies[0].embeds[0])), /have not entered/);

  // Time is up: nobody can enter any more.
  clearAllRateLimits();
  const late = world({ [MESSAGE]: activeGiveaway({ endsAt: Date.now() - 1000 }) });
  const lateEntry = late.interaction('member');
  await button('giveaway_enter').execute(lateEntry, late.client);
  assert.match(JSON.stringify(json(lateEntry.replies[0].embeds[0])), /already ended/);
  assert.deepEqual((await loadGiveaway(late.client, GUILD, MESSAGE)).participants, []);

  // Buttons on giveaways posted before the new layout still enter.
  clearAllRateLimits();
  const legacy = w.interaction('older');
  await button('giveaway_join').execute(legacy, w.client);
  assert.deepEqual((await loadGiveaway(w.client, GUILD, MESSAGE)).participants, ['older']);
});

test('legacy Manage clicks remain Owner-only for old posts', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({ participants: ['a'] }) });
  const member = w.interaction('member');
  await button('giveaway_manage').execute(member, w.client);
  assert.match(JSON.stringify(json(member.replies[0].embeds[0])), /Owner role/);

  const staff = w.interaction('staff', { staff: true });
  await button('giveaway_manage').execute(staff, w.client);
  const panel = staff.edited;
  assert.equal(staff.deferred, true);
  assert.deepEqual(panel.components.flatMap(row => json(row).components.map(component => component.label)),
    ['Reroll', 'Edit text', 'Edit timer', 'End', 'View participants', 'Delete', 'Edit claim']);
  assert.equal(panel.components.flatMap(row => json(row).components).find(component => component.label === 'View participants').emoji.name, '👤');
  assert.equal(panel.components.flatMap(row => json(row).components).find(component => component.label === 'Reroll').emoji.name, '🎲');
  // The owner's white person emoji is used once Cloudy can see it.
  w.client.emojis = { cache: new Collection([['999', { id: '999', name: 'W881241476043907403887', animated: false }]]) };
  const withEmoji = w.interaction('staff', { staff: true });
  await button('giveaway_manage').execute(withEmoji, w.client);
  assert.equal(withEmoji.edited.components.flatMap(row => json(row).components).find(component => component.label === 'View participants').emoji.id, '999');

  const list = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(list, w.client, ['participants', MESSAGE]);
  assert.match(list.edited.embeds[0].description, /1\. <@a>/);
});

test('Owner can re-edit text on the existing message; staff without Owner role cannot manage', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({ hostId: 'host' }) });
  const owner = w.interaction('owner');
  await button('giveaway_manage').execute(owner, w.client);
  assert.equal(owner.edited.components.length, 3);

  const nonowner = w.interaction('staff', { staff: false });
  nonowner.member.permissions.has = () => true;
  await button('giveaway_manage').execute(nonowner, w.client);
  assert.match(JSON.stringify(nonowner.replies[0]), /Owner role/);

  const modal = w.interaction('owner');
  await button('giveaway_admin').execute(modal, w.client, ['text', MESSAGE]);
  assert.deepEqual(modal.modal.components.map(row => row.components[0].custom_id),
    ['introTitle', 'description', 'prize', 'requirements', 'closingText']);

  const values = {
    introTitle: 'Special giveaway!', description: 'New introduction', prize: 'New prize',
    requirements: 'Member', closingText: 'Best of luck!',
  };
  const edit = w.interaction('owner', { args: { fields: { getTextInputValue: name => values[name] } } });
  await textModal.execute(edit, w.client, [MESSAGE]);
  const saved = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(saved.messageId, MESSAGE);
  assert.equal(saved.prize, 'New prize');
  assert.equal(saved.closingText, 'Best of luck!');
  assert.equal(w.sent.length, 0);
  assert.equal(w.giveawayMessage.edits.length, 1);
  assert.match(w.giveawayMessage.edits[0].embeds[0].description, /Best of luck!/);
});

test('Edit claim hides Public claim instructions and preserves existing public text', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({
    hostId: 'owner',
    claim: 'Original public claim instructions must remain intact.',
  }) });
  const modal = w.interaction('owner');
  await button('giveaway_admin').execute(modal, w.client, ['claim', MESSAGE]);
  assert.deepEqual(modal.modal.components.map(row => row.components[0].custom_id),
    ['claimIntroduction', 'claimConditions', 'claimHowToGet', 'claimReview', 'claimPleaseNote']);

  const fields = {
    claimIntroduction: 'Welcome to your claim.',
    claimConditions: 'Prize conditions for PlayStation gift card.',
    claimHowToGet: 'Reveal your activation code.',
    claimReview: 'Please leave a review.',
    claimPleaseNote: 'The channel closes after 24 hours.',
  };
  const submit = w.interaction('owner', { args: {
    fields: { getTextInputValue: name => {
      assert.ok(Object.hasOwn(fields, name), 'Unexpected or removed field: ' + name);
      return fields[name];
    } },
  } });
  await giveawayClaimModalHandler.execute(submit, w.client, [MESSAGE]);
  const saved = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(saved.claim, 'Original public claim instructions must remain intact.');
  assert.equal(saved.claimIntroduction, 'Welcome to your claim.');
  assert.equal(saved.claimConditions, 'Prize conditions for PlayStation gift card.');
  assert.equal(saved.claimHowToGet, 'Reveal your activation code.');
  assert.equal(saved.claimReview, 'Please leave a review.');
  assert.equal(saved.claimPleaseNote, 'The channel closes after 24 hours.');
});

test('End draws winners, marks the giveaway, and tags the winners with how to claim the prize', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({ participants: ['winner'], claim: 'DM the owner within 24 hours.' }) });
  const staff = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(staff, w.client, ['end', MESSAGE]);
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(stored.ended, true);
  assert.deepEqual(stored.winnerIds, ['winner']);
  const edited = w.giveawayMessage.edits.at(-1);
  assert.match(edited.embeds[0].description, /\*\*Winners\*\*\n<@winner>/);
  assert.equal(edited.embeds[0].color, 0xFFFFFF);
  assert.equal(w.sent.at(-1).embeds[0].color, 0xFFFFFF);
  const announcement = w.sent.at(-1);
  assert.equal(announcement.content, '<@winner>');
  assert.deepEqual(announcement.allowedMentions, { parse: [], users: ['winner'] });
  assert.equal(announcement.reply.messageReference, MESSAGE);
  assert.match(announcement.embeds[0].description, /<@winner> has won \*\*1 month vip\*\*!/);
  assert.match(announcement.embeds[0].description, /DM the owner within 24 hours\./);
  assert.match(announcement.embeds[0].description, /Failure to claim your prize/);
  assert.equal(stored.winnerPingMessageId, announcement.id);
  assert.ok(Date.parse(stored.claimDeadlineAt) >= Date.now() + GIVEAWAY_WINNER_CLAIM_WINDOW_MS - 1_000);
  assert.equal(json(staff.edited.embeds[0]).title, 'Success');
  // The default claim text is used when none was given: 24 hours.
  assert.equal(DEFAULT_GIVEAWAY_CLAIM, 'Please click the button below within 24 hours to collect your prize.');
  assert.ok(createWinnerAnnouncement(activeGiveaway(), ['x']).embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM));
});

test('winner announcement uses the new Claim text and preserves custom instructions and remaining content', () => {
  const standard = createWinnerAnnouncement(activeGiveaway({ claim: null }), ['winner']);
  const legacy = createWinnerAnnouncement(activeGiveaway({ claim: LEGACY_GIVEAWAY_CLAIM }), ['winner']);
  const previous = createWinnerAnnouncement(activeGiveaway({ claim: PREVIOUS_GIVEAWAY_CLAIM }), ['winner']);
  const former = createWinnerAnnouncement(activeGiveaway({ claim: FORMER_GIVEAWAY_CLAIM }), ['winner']);
  const custom = createWinnerAnnouncement(activeGiveaway({ claim: 'Contact the host for assistance.' }), ['winner']);
  assert.ok(standard.embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM));
  assert.equal(legacy.embeds[0].description, standard.embeds[0].description);
  assert.equal(previous.embeds[0].description, standard.embeds[0].description);
  assert.equal(former.embeds[0].description, standard.embeds[0].description);
  assert.ok(custom.embeds[0].description.includes('Contact the host for assistance.'));
  assert.doesNotMatch(custom.embeds[0].description, /be redirected to a private channel/);
  assert.equal(DEFAULT_GIVEAWAY_FAILURE, 'Failure to claim your prize within this timeframe will result in a reroll, and a new winner will be selected.');
  assert.ok(standard.embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM + '\n\n' + DEFAULT_GIVEAWAY_FAILURE));
  assert.doesNotMatch(standard.embeds[0].description, /be redirected to a private channel|within \*\*24 hours\*\*/);
  assert.ok(standard.embeds[0].thumbnail?.url);
  assert.equal(standard.components[0].toJSON().components[0].label, 'Claim');
  for (const rendered of [standard, createWinnerAnnouncement(activeGiveaway(), ['winner'], { reroll: true })]) {
    const button = rendered.components[0].toJSON().components[0];
    assert.deepEqual(button.emoji, { id: '1566400796348649492', name: 'gift_icon_white' });
    assert.equal(button.custom_id, `gclaim:open:${MESSAGE}`);
    assert.equal(button.label, 'Claim');
    assert.equal(button.style, 2);
  }
});

test('already-posted winner messages replace only the old instruction, in place, and only once', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerIds: ['winner'],
    announcementIds: ['announcement1', 'announcement2', 'announcement3', 'announcement4'],
  }) });
  const original = createWinnerAnnouncement(activeGiveaway({ claim: null }), ['winner']);
  const oldEmbed = {
    ...original.embeds[0],
    description: original.embeds[0].description
        .replace(DEFAULT_GIVEAWAY_CLAIM, LEGACY_GIVEAWAY_CLAIM)
        .replace(DEFAULT_GIVEAWAY_FAILURE, LEGACY_GIVEAWAY_FAILURE),
  };
  const existing = {
    embeds: [oldEmbed],
    content: original.content,
    components: original.components,
    edits: [],
    edit: async payload => {
      existing.edits.push(payload);
      existing.embeds = payload.embeds;
      return existing;
    },
  };
  const custom = {
    embeds: [createWinnerAnnouncement(activeGiveaway({
      claim: 'Custom claim instructions remain unchanged.',
    }), ['winner']).embeds[0]],
    edits: [],
    edit: async payload => { custom.edits.push(payload); return custom; },
  };
  const previouslyPosted = {
    embeds: [{
      ...original.embeds[0],
      description: original.embeds[0].description.replace(DEFAULT_GIVEAWAY_CLAIM, PREVIOUS_GIVEAWAY_CLAIM),
    }],
    edits: [],
    edit: async payload => {
      previouslyPosted.edits.push(payload);
      previouslyPosted.embeds = payload.embeds;
      return previouslyPosted;
    },
  };
  const justBeforeUpdate = {
    embeds: [{ ...original.embeds[0],
      description: original.embeds[0].description
        .replace(DEFAULT_GIVEAWAY_CLAIM, FORMER_GIVEAWAY_CLAIM)
        .replace(DEFAULT_GIVEAWAY_FAILURE, LEGACY_GIVEAWAY_FAILURE),
    }],
    edits: [],
    edit: async payload => {
      justBeforeUpdate.edits.push(payload);
      justBeforeUpdate.embeds = payload.embeds;
      return justBeforeUpdate;
    },
  };
  w.channel.messages.fetch = async id => id === 'announcement1'
    ? existing : id === 'announcement2' ? custom
      : id === 'announcement3' ? previouslyPosted
        : id === 'announcement4' ? justBeforeUpdate : w.giveawayMessage;
  const beforeContent = existing.content;
  const beforeComponents = existing.components;
  const beforeThumbnail = existing.embeds[0].thumbnail;
  await refreshExistingGiveawayClaimInstructions(w.client);
  assert.equal(existing.edits.length, 1);
  assert.equal(previouslyPosted.edits.length, 1);
  assert.equal(justBeforeUpdate.edits.length, 1);
  assert.ok(previouslyPosted.embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM));
  assert.ok(justBeforeUpdate.embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM + '\n\n' + DEFAULT_GIVEAWAY_FAILURE));
  assert.equal(custom.edits.length, 0);
  assert.equal(existing.content, beforeContent);
  assert.equal(existing.components, beforeComponents);
  assert.deepEqual(existing.embeds[0].thumbnail, beforeThumbnail);
  assert.ok(existing.embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM));
  assert.ok(existing.embeds[0].description.includes(DEFAULT_GIVEAWAY_CLAIM));
  assert.ok(existing.embeds[0].description.includes(DEFAULT_GIVEAWAY_FAILURE));
  assert.doesNotMatch(existing.embeds[0].description, /within \*\*24 hours\*\*/);
  await refreshExistingGiveawayClaimInstructions(w.client);
  assert.equal(existing.edits.length, 1);
  assert.equal(previouslyPosted.edits.length, 1);
  assert.equal(justBeforeUpdate.edits.length, 1);
});


// Existing Claim buttons receive the new icon without changing content,
// embeds, channel/message IDs, button routing, mentions or disabled state.
test('already-posted Claim button swaps only old gift icon, once, in the same message', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerIds: ['winner'],
    announcementIds: ['legacy-claim'],
  }) });
  const payload = createWinnerAnnouncement(activeGiveaway(), ['winner']);
  const previous = payload.components[0].toJSON();
  const button = { ...previous.components[0],
    emoji: { id: '1543303758912688230', name: 'W89gift' },
    disabled: true,
  };
  const oldRow = { ...previous, components: [button] };
  const posted = {
    id: 'legacy-claim',
    content: payload.content,
    embeds: structuredClone(payload.embeds),
    components: [structuredClone(oldRow)],
    edits: [],
    edit: async function(change) {
      this.edits.push(change);
      if (change.embeds) this.embeds = change.embeds;
      if (change.components) this.components = change.components;
      return this;
    },
  };
  w.channel.messages.fetch = async id => id === 'legacy-claim' ? posted : w.giveawayMessage;
  const originalText = posted.content;
  const originalEmbeds = structuredClone(posted.embeds);
  await refreshExistingGiveawayClaimInstructions(w.client);
  assert.equal(posted.edits.length, 1);
  assert.deepEqual(Object.keys(posted.edits[0]), ['components']);
  assert.deepEqual(posted.embeds, originalEmbeds);
  assert.equal(posted.content, originalText);
  const updated = posted.components[0].components[0];
  assert.deepEqual(updated.emoji, { id: '1566400796348649492', name: 'gift_icon_white' });
  assert.deepEqual({ ...updated, emoji: button.emoji }, button,
    'only the emoji is changed; custom ID, label, style and disabled state persist');
  await refreshExistingGiveawayClaimInstructions(w.client);
  assert.equal(posted.edits.length, 1, 'second startup must not edit again');
});

test('Reroll draws someone new and announces them; nobody new left is an error', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({ participants: ['first', 'second'], ended: true, isEnded: true, winnerIds: ['first'] }) });
  const staff = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(staff, w.client, ['reroll', MESSAGE]);
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.deepEqual(stored.winnerIds, ['second']);
  assert.ok(Date.parse(stored.claimDeadlineAt) >= Date.now() + GIVEAWAY_WINNER_CLAIM_WINDOW_MS - 1_000);
  assert.match(w.sent.at(-1).embeds[0].description, /New winner!/);
  assert.equal(w.sent.at(-1).content, '<@second>');

  const again = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(again, w.client, ['reroll', MESSAGE]);
  assert.match(JSON.stringify(json(again.replies.at(-1).embeds[0])), /already won/);
});


const expiredClaimWindow = () => new Date(Date.now() - 5_000).toISOString();
const claimedRecord = (userId, closed = false) => ({
  messageId: MESSAGE, userId, channelId: 'private-' + userId,
  createdAt: new Date(Date.now() - 100_000).toISOString(),
  closedAt: closed ? new Date().toISOString() : null,
});

test('automatic claim reroll replaces exactly one missing winner and preserves two claimed prizes', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerCount: 3, winnerIds: ['first', 'second', 'third'],
    participants: ['first', 'second', 'third', 'new1', 'new2'],
    claimDeadlineAt: expiredClaimWindow(),
  }) });
  w.values.set(`guild:${GUILD}:giveaway-claim:records`, {
    [`${MESSAGE}:first`]: claimedRecord('first'),
    [`${MESSAGE}:third`]: claimedRecord('third', true),
  });
  await checkUnclaimedGiveawayWinners(w.client);
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(stored.winnerIds.length, 3);
  assert.deepEqual(stored.winnerIds.slice(0, 2), ['first', 'third']);
  assert.ok(['new1', 'new2'].includes(stored.winnerIds[2]));
  assert.deepEqual(stored.previousWinnerIds, ['first', 'second', 'third']);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].content, `<@${stored.winnerIds[2]}>`);
  assert.deepEqual(w.sent[0].allowedMentions.users, [stored.winnerIds[2]]);
  assert.match(w.sent[0].embeds[0].description, /New winner!/);
  assert.ok(Date.parse(stored.claimDeadlineAt) >= Date.now() + GIVEAWAY_WINNER_CLAIM_WINDOW_MS - 1_000);
  await checkUnclaimedGiveawayWinners(w.client);
  assert.equal(w.sent.length, 1, 'the same expired round must not be rerolled twice');
});

test('automatic claim reroll replaces all missing winners, then can retry the next 24h round', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerCount: 2, winnerIds: ['first', 'second'],
    participants: ['first', 'second', 'third', 'fourth', 'fifth'],
    claimDeadlineAt: expiredClaimWindow(),
  }) });
  await checkUnclaimedGiveawayWinners(w.client);
  const firstRound = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(firstRound.winnerIds.length, 2);
  assert.ok(firstRound.winnerIds.every(id => !['first', 'second'].includes(id)));
  assert.equal(new Set(firstRound.winnerIds).size, 2);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].allowedMentions.users.length, 2);
  // The following round has its own deadline; previous winners never return.
  w.values.set(`guild:${GUILD}:giveaways`, {
    [MESSAGE]: { ...firstRound, claimDeadlineAt: expiredClaimWindow() },
  });
  await checkUnclaimedGiveawayWinners(w.client);
  const secondRound = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(secondRound.winnerIds.length, 1);
  assert.ok(!['first', 'second', ...firstRound.winnerIds].includes(secondRound.winnerIds[0]));
  assert.equal(w.sent.length, 2);
  assert.equal(secondRound.previousWinnerIds.length, 4);
});

test('automatic claim reroll finishes quietly if everyone claimed or no replacements exist', async () => {
  const all = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerCount: 2, winnerIds: ['a', 'b'],
    participants: ['a', 'b', 'c'], claimDeadlineAt: expiredClaimWindow(),
  }) });
  all.values.set(`guild:${GUILD}:giveaway-claim:records`, {
    [`${MESSAGE}:a`]: claimedRecord('a'),
    [`${MESSAGE}:b`]: claimedRecord('b'),
  });
  await checkUnclaimedGiveawayWinners(all.client);
  const complete = await loadGiveaway(all.client, GUILD, MESSAGE);
  assert.deepEqual(complete.winnerIds, ['a', 'b']);
  assert.equal(complete.claimDeadlineAt, null);
  assert.equal(all.sent.length, 0);
  assert.equal(all.giveawayMessage.edits.length, 0);

  const exhausted = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerCount: 2, winnerIds: ['a', 'b'],
    participants: ['a', 'b'], claimDeadlineAt: expiredClaimWindow(),
  }) });
  exhausted.values.set(`guild:${GUILD}:giveaway-claim:records`, {
    [`${MESSAGE}:a`]: claimedRecord('a'),
  });
  await checkUnclaimedGiveawayWinners(exhausted.client);
  const stored = await loadGiveaway(exhausted.client, GUILD, MESSAGE);
  assert.deepEqual(stored.winnerIds, ['a']);
  assert.equal(stored.claimDeadlineAt, null);
  assert.equal(exhausted.sent.length, 0);
  assert.equal(exhausted.giveawayMessage.edits.length, 1);
  await checkUnclaimedGiveawayWinners(exhausted.client);
  assert.equal(exhausted.giveawayMessage.edits.length, 1);
});

test('legacy ended giveaways are not rerolled and claim storage failures cannot remove winners', async () => {
  const old = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerIds: ['winner'],
    participants: ['winner', 'next'],
  }) });
  await checkUnclaimedGiveawayWinners(old.client);
  assert.deepEqual((await loadGiveaway(old.client, GUILD, MESSAGE)).winnerIds, ['winner']);
  assert.equal(old.sent.length, 0);

  const unsafe = world({ [MESSAGE]: activeGiveaway({
    ended: true, isEnded: true, winnerIds: ['winner'],
    participants: ['winner', 'next'], claimDeadlineAt: expiredClaimWindow(),
  }) });
  const oldGet = unsafe.client.db.get;
  unsafe.client.db.get = async (key, ...args) => {
    if (key.endsWith(':giveaway-claim:records')) throw new Error('claim DB offline');
    return oldGet(key, ...args);
  };
  await checkUnclaimedGiveawayWinners(unsafe.client);
  assert.deepEqual((await loadGiveaway(unsafe.client, GUILD, MESSAGE)).winnerIds, ['winner']);
  assert.equal(unsafe.sent.length, 0);
});

test('Edit timer sets a new end time from now and updates the giveaway', async () => {
  const w = world({ [MESSAGE]: activeGiveaway() });
  const open = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(open, w.client, ['timer', MESSAGE]);
  assert.equal(open.modal.custom_id, `giveaway_timer:${MESSAGE}`);
  const before = Date.now();
  const submit = w.interaction('staff', { staff: true, args: { fields: { getTextInputValue: () => '2h' } } });
  await timerModal.execute(submit, w.client, [MESSAGE]);
  assert.equal(json(submit.edited.embeds[0]).title, 'Success');
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.ok(stored.endsAt >= before + 7_200_000 && stored.endsAt <= Date.now() + 7_200_000);
  assert.match(w.giveawayMessage.edits.at(-1).embeds[0].description, new RegExp(`<t:${Math.floor(stored.endsAt / 1000)}:F>`));
});

test('Delete asks to confirm, then removes the record and the giveaway message', async () => {
  const w = world({ [MESSAGE]: activeGiveaway() });
  const ask = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(ask, w.client, ['delete', MESSAGE]);
  assert.equal(ask.edited.embeds[0].title, 'Delete giveaway?');
  const confirm = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(confirm, w.client, ['confirmdelete', MESSAGE]);
  assert.equal(await loadGiveaway(w.client, GUILD, MESSAGE), null);
  assert.ok(w.deleted.includes(MESSAGE));
});

test('the automatic check ends due giveaways once; a removed giveaway message is closed without tags', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({ participants: ['winner'], endsAt: Date.now() - 1000 }) });
  await checkGiveaways(w.client);
  assert.equal((await loadGiveaway(w.client, GUILD, MESSAGE)).ended, true);
  assert.equal(w.sent.length, 1);
  await checkGiveaways(w.client);
  assert.equal(w.sent.length, 1);

  const gone = world({ [MESSAGE]: activeGiveaway({ participants: ['winner'] }) });
  gone.deleted.push(MESSAGE);
  const result = await finishGiveaway(gone.client, gone.guild, MESSAGE);
  assert.equal(result.announced, false);
  assert.equal(gone.sent.length, 0);
  assert.equal((await loadGiveaway(gone.client, GUILD, MESSAGE)).ended, true);
});

test('/gcreate opens the Giveaway Builder: preview, edit forms, tag, channel, then Post', async () => {
  const w = world({});
  const staff = w.interaction('staff', { staff: true });
  const command = Object.assign(staff, { channelId: 'giveaways', guild: { ...w.guild, channels: { ...w.guild.channels, fetch: async id => w.guild.channels.cache.get(id) } } });
  await create.execute(command);
  const builder = command.replies[0];
  assert.equal(builder.flags, 64);
  assert.match(builder.embeds[0].description, /Your prize/);
  assert.match(builder.embeds[1].description, /Cloudy Inc.*congratulates/);
  assert.match(builder.embeds[1].description, /Prize conditions/);
  assert.match(builder.embeds[1].description, /Share your feedback/);
  const controls = builder.components.map(json);
  const sessionId = controls[2].components[0].custom_id.split(':')[2];
  assert.deepEqual(controls.slice(2).map(row => row.components.map(component => [component.label, component.style])), [
    [['Edit text', 2], ['Duration & winners', 2]],
    [['Edit claim', 2], ['Post giveaway', 3], ['Cancel', 2]],
  ]);
  assert.equal(controls[0].components[0].options[0].label, '@everyone');
  assert.equal(controls[0].components[0].options[1].label, 'Role');
  assert.equal(controls[0].components[0].placeholder, 'Choose a tag');
  assert.notEqual(controls[0].components[0].options[2].default, true);
  assert.equal(controls[1].components[0].placeholder, 'Choose a channel');
  assert.equal(controls[1].components[0].default_values, undefined);
  const postButton = controls[3].components[1];
  assert.equal(postButton.emoji.name, '📤');
  assert.equal(postButton.disabled, true);

  const click = (customId, extra = {}) => Object.assign(w.interaction('staff', { staff: true }), { guild: command.guild, customId, ...extra });
  // Edit text form: introduction, description, prize, requirements and closing.
  const openText = click(`gbuilder:text:${sessionId}`);
  await handleGiveawayBuilderInteraction(openText, w.client);
  assert.deepEqual(openText.modal.components.map(row => row.components[0].custom_id), ['introTitle', 'description', 'prize', 'requirements', 'closingText']);
  assert.equal(openText.modal.components[1].components[0].value, 'Cloudy Inc. is giving you the chance to win something special!');
  const texts = {
    introTitle: 'Giveaway time !',
    prize: '1 month vip',
    description: 'Win big!\nGood luck',
    requirements: 'Level 5',
    closingText: 'Good luck to everyone!',
  };
  const textForm = click(`gbuilder:textform:${sessionId}`, { fields: { getTextInputValue: name => texts[name] } });
  await handleGiveawayBuilderInteraction(textForm, w.client);
  assert.match(textForm.updated.embeds[0].description, /\*\*1 month vip\*\*/);
  assert.match(textForm.updated.embeds[1].description, /How to get your prize/);
  assert.match(textForm.updated.embeds[1].description, /Reveal my code/);
  assert.doesNotMatch(textForm.updated.embeds[1].description, /<@staff>/);
  assert.equal(json(textForm.updated.components[3]).components[1].disabled, true);
  const openClaim = click(`gbuilder:claim:${sessionId}`);
  await handleGiveawayBuilderInteraction(openClaim, w.client);
  assert.deepEqual(openClaim.modal.components.map(row => row.components[0].custom_id),
    ['claimIntroduction', 'claimConditions', 'claimHowToGet', 'claimReview', 'claimPleaseNote']);
  const claimInputs = {
    claimIntroduction: 'You won! Congratulations!',
    claimConditions: 'PlayStation Store gift card details.',
    claimHowToGet: 'Click Reveal my code to display the code.',
    claimReview: 'Thank you for your feedback.',
    claimPleaseNote: 'This channel closes after 24 hours.',
  };
  const claimForm = click(`gbuilder:claimform:${sessionId}`, { fields: {
    getTextInputValue: name => {
      assert.ok(Object.hasOwn(claimInputs, name), 'No public claim field should be read: ' + name);
      return claimInputs[name];
    },
  } });
  await handleGiveawayBuilderInteraction(claimForm, w.client);
  assert.match(claimForm.updated.embeds[1].description, /PlayStation Store gift card details\./);
  assert.match(claimForm.updated.embeds[1].description, /You won! Congratulations!/);
  assert.match(claimForm.updated.embeds[1].description, /Thank you for your feedback/);
  assert.equal(claimForm.updated.embeds[1].thumbnail, undefined);
  // Duration & winners form: "Example" placeholder, 1m is the shortest, with validation.
  const openTiming = click(`gbuilder:timing:${sessionId}`);
  await handleGiveawayBuilderInteraction(openTiming, w.client);
  assert.equal(openTiming.modal.components[0].components[0].placeholder, 'Example: 1m, 1h, 1d');
  assert.equal(parseDuration('1m'), 60_000);
  const badTiming = click(`gbuilder:timingform:${sessionId}`, { fields: { getTextInputValue: name => (name === 'duration' ? 'soon' : '2') } });
  await handleGiveawayBuilderInteraction(badTiming, w.client);
  assert.match(JSON.stringify(json(badTiming.replies[0].embeds[0])), /Invalid duration/);
  const timing = click(`gbuilder:timingform:${sessionId}`, { fields: { getTextInputValue: name => (name === 'duration' ? '2h' : '2') } });
  await handleGiveawayBuilderInteraction(timing, w.client);
  assert.match(timing.updated.embeds[0].description, /\*\*Winners\*\*\n2\n/);
  // A role selector appears above the channel selector, without changing the other buttons.
  const role = click(`gbuilder:role:${sessionId}`, { values: ['giveaway-role'], isRoleSelectMenu: () => true });
  await handleGiveawayBuilderInteraction(role, w.client);
  assert.equal(json(role.updated.components[0]).components[0].options[1].default, true);
  assert.equal(json(role.updated.components[1]).components[0].custom_id, `gbuilder:role:${sessionId}`);
  assert.equal(json(role.updated.components[1]).components[0].placeholder, 'Choose the role');
  assert.equal(json(role.updated.components[2]).components[0].custom_id, `gbuilder:channel:${sessionId}`);
  assert.equal(json(role.updated.components[4]).components[1].disabled, true);
  // Posting becomes available only once the user chooses a channel.
  const channel = click(`gbuilder:channel:${sessionId}`, { values: ['giveaways'], isChannelSelectMenu: () => true });
  await handleGiveawayBuilderInteraction(channel, w.client);
  assert.equal(json(channel.updated.components[4]).components[1].disabled, false);
  const post = click(`gbuilder:post:${sessionId}`);
  await handleGiveawayBuilderInteraction(post, w.client);
  const posted = w.sent[0];
  assert.equal(posted.content, '<@&giveaway-role>');
  assert.deepEqual(posted.allowedMentions, { parse: [], roles: ['giveaway-role'] });
  assert.match(posted.embeds[0].description, /\*\*Giveaway time!\*\*\n\nWin big!\nGood luck\n/);
  assert.match(posted.embeds[0].description, /\*\*Hosted by\*\*\n<@staff>/);
  const stored = await loadGiveaway(w.client, GUILD, posted.id);
  assert.equal(stored.requirements, 'Level 5');
  assert.equal(stored.claim, null);
  assert.equal(stored.winnerCount, 2);
  assert.ok(stored.endsAt > Date.now() + 7_100_000);
  assert.equal(json(post.edited.embeds[0]).title, 'Success');
  // The builder is closed once posted.
  const late = click(`gbuilder:post:${sessionId}`);
  await handleGiveawayBuilderInteraction(late, w.client);
  assert.match(JSON.stringify(json(late.replies[0].embeds[0])), /expired/);
  assert.equal(w.sent.length, 1);
  // Reopening after posting restores the user's authored preview, without
  // restoring the previous role tag or the last giveaway's timer and winners.
  const reopen = Object.assign(w.interaction('staff', { staff: true }), { channelId: 'giveaways', guild: command.guild });
  await create.execute(reopen);
  // A new giveaway must restore the original defaults; previous authored
  // giveaway/claim changes belong only to the already-posted giveaway.
  assert.match(reopen.replies[0].embeds[0].description, /\*\*Your prize\*\*/);
  assert.doesNotMatch(reopen.replies[0].embeds[0].description, /1 month vip/);
  assert.match(reopen.replies[0].embeds[1].description, /Cloudy Inc\. congratulates you on winning this prize!/);
  assert.match(reopen.replies[0].embeds[1].description, /Details and conditions of their prize\./);
  assert.match(reopen.replies[0].embeds[1].description, /How to get your prize/);
  assert.doesNotMatch(reopen.replies[0].embeds[1].description, /You won! Congratulations!|PlayStation Store gift card details\./);
  assert.notEqual(json(reopen.replies[0].components[0]).components[0].options[2].default, true);
  assert.equal(json(reopen.replies[0].components[0]).components[0].placeholder, 'Choose a tag');
  assert.equal(json(reopen.replies[0].components[1]).components[0].placeholder, 'Choose a channel');
  assert.equal(json(reopen.replies[0].components[3]).components[1].disabled, true);
});

test('opening a new builder ignores past giveaways and legacy saved templates', async () => {
  const oldGiveaway = activeGiveaway({
    hostId: 'staff',
    prize: 'Custom saved prize',
    claim: 'Open the private winner ticket.',
    createdAt: '2026-10-31T23:00:00.000Z',
  });
  const w = world({ [MESSAGE]: oldGiveaway });
  // Simulate legacy template persistence with custom text, which must no
  // longer override fresh defaults.
  w.values.set('guild:' + GUILD + ':giveaway-builder:template:staff', {
    introTitle: 'Custom old introduction',
    prize: 'Old saved giveaway prize',
    claimReview: 'Old custom claim review text',
  });
  const command = Object.assign(w.interaction('staff', { staff: true }), {
    channelId: 'giveaways',
    guild: { ...w.guild, channels: { ...w.guild.channels, fetch: async id => w.guild.channels.cache.get(id) } },
  });
  await create.execute(command);
  const [giveaway, winner] = command.replies[0].embeds;
  assert.match(giveaway.description, /\*\*Your prize\*\*/);
  assert.doesNotMatch(giveaway.description, /Custom saved prize/);
  assert.match(winner.description, /Cloudy Inc.*congratulates/);
  assert.match(winner.description, /Prize conditions/);
  assert.match(winner.description, /How to get your prize/);
  assert.match(winner.description, /satisfied with your experience/);
  assert.doesNotMatch(winner.description, /Old custom claim review text/);
  assert.doesNotMatch(giveaway.description, /Custom old introduction|Old saved giveaway prize/);
  assert.equal(command.replies[0].components.length, 4);
  assert.notEqual(json(command.replies[0].components[0]).components[0].options[2].default, true);
  assert.equal(w.sent.length, 0);
});

test('only staff can open the Giveaway Builder; @everyone can be tagged', async () => {
  const w = world({});
  const member = Object.assign(w.interaction('member'), { channelId: 'giveaways' });
  await create.execute(member);
  assert.match(JSON.stringify(json(member.replies[0].embeds[0])), /Only staff/);
  const staff = Object.assign(w.interaction('staff', { staff: true }), { channelId: 'giveaways' });
  await create.execute(staff);
  const sessionId = json(staff.replies[0].components[2]).components[0].custom_id.split(':')[2];
  const everyone = Object.assign(w.interaction('staff', { staff: true }), {
    customId: `gbuilder:pingtype:${sessionId}`,
    values: ['everyone'],
    isStringSelectMenu: () => true,
  });
  await handleGiveawayBuilderInteraction(everyone, w.client);
  assert.equal(json(everyone.updated.components[0]).components[0].options[0].default, true);
});

test('every giveaway button answers Discord before reading the database (no 3-second timeouts)', async () => {
  for (const [name, args, ack] of [
    ['giveaway_enter', [], 'deferUpdate'],
    ['giveaway_leave', [], 'deferUpdate'],
    ['giveaway_manage', [], 'deferReply'],
    ['giveaway_admin', ['panel', MESSAGE], 'deferUpdate'],
    ['giveaway_admin', ['participants', MESSAGE], 'deferReply'],
    ['giveaway_admin', ['end', MESSAGE], 'deferUpdate'],
  ]) {
    clearAllRateLimits();
    const w = world({ [MESSAGE]: activeGiveaway({ participants: ['member'] }) });
    const order = [];
    const read = w.client.db.get;
    w.client.db.get = async (...params) => { order.push('database'); return read(...params); };
    const click = w.interaction('member', { staff: true });
    const original = click[ack];
    click[ack] = async (...params) => { order.push('acknowledged'); return original(...params); };
    await button(name).execute(click, w.client, args);
    assert.equal(order[0], 'acknowledged', `${name} ${args[0] || ''}`);
  }
});

test('every giveaway notice disappears after exactly 10 seconds; the giveaway itself never does', async t => {
  clearAllRateLimits();
  const w = world({ [MESSAGE]: activeGiveaway() });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Enter: the Success follow-up is removed, not the giveaway message.
  const enter = w.interaction('member');
  await button('giveaway_enter').execute(enter, w.client);
  t.mock.timers.tick(9_999);
  await settle();
  assert.deepEqual(enter.deleted, []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(enter.deleted, ['follow-up-1']);

  // A warning answered directly is removed too.
  const outsider = w.interaction('member');
  await button('giveaway_manage').execute(outsider, w.client);
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(outsider.deleted, ['@original']);

  // A failed Reroll shows a Warning (never another template title) and disappears.
  const ended = world({ [MESSAGE]: activeGiveaway({ ended: true, isEnded: true, participants: [] }) });
  const reroll = ended.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(reroll, ended.client, ['reroll', MESSAGE]);
  assert.equal(json(reroll.replies.at(-1).embeds[0]).title, 'Warning');
  // Warnings have a red side line, never yellow.
  assert.equal(json(reroll.replies.at(-1).embeds[0]).color, 0x7A1712);
  assert.match(json(reroll.replies.at(-1).embeds[0]).description, /no entries to reroll/);
  t.mock.timers.tick(10_000);
  await settle();
  assert.ok(reroll.deleted.length === 1 && reroll.deleted[0] !== '@original');

  // The private Manage panel becomes a Success notice after End, then disappears.
  const active = world({ [MESSAGE]: activeGiveaway({ participants: ['winner'] }) });
  const end = active.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(end, active.client, ['end', MESSAGE]);
  assert.equal(json(end.edited.embeds[0]).title, 'Success');
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(end.deleted, ['@original']);

  // The participants list disappears after 10 seconds too.
  const list = active.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(list, active.client, ['participants', MESSAGE]);
  assert.equal(list.edited.embeds[0].title, 'Participants — 1 month vip');
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(list.deleted, ['@original']);

  // Giveaway Builder notices follow the same rule.
  const expired = Object.assign(active.interaction('staff', { staff: true }), { customId: 'gbuilder:post:unknown-session' });
  await handleGiveawayBuilderInteraction(expired, active.client);
  assert.match(JSON.stringify(json(expired.replies[0].embeds[0])), /expired/);
  assert.equal(json(expired.replies[0].embeds[0]).color, 0x7A1712);
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(expired.deleted, ['@original']);
});
