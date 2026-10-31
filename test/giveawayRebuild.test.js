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
  parseDuration,
} from '../src/services/giveawayService.js';
import { checkGiveaways, finishGiveaway, loadGiveaway } from '../src/services/giveawayActions.js';
import buttons from '../src/interactions/buttons/giveaway/giveaway.js';
import timerModal from '../src/interactions/modals/giveawayTimer.js';
import textModal from '../src/interactions/modals/giveawayText.js';
import create from '../src/commands/Giveaway/gcreate.js';
import { handleGiveawayBuilderInteraction } from '../src/services/giveawayBuilderService.js';

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
    send: async payload => { const message = { id: `sent-${sent.length}`, ...payload, delete: async () => { deleted.push(message.id); } }; sent.push(message); return message; } };
  const guild = { id: GUILD, ownerId: 'owner', channels: { cache: new Collection([[channel.id, channel]]) } };
  client.guilds.cache.set(GUILD, guild);
  const member = (id, permissions = 0n) => ({ id, permissions: { has: flag => (BigInt(permissions) & BigInt(flag)) === BigInt(flag) }, roles: { cache: new Collection() } });
  function interaction(user = 'member', { staff = false, args = {} } = {}) {
    const result = { guildId: GUILD, guild, user: { id: user }, member: {
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
    '<a:W89gift:1557507008284987442> **Giveaway time !**',
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
    '1 winner',
    '',
    '<a:W89timer:1557506643372146778> **Giveaway ends**',
    '<t:1800000000:F> (<t:1800000000:R>)',
    '',
    'Good luck to everyone!',
  ].join('\n'));
  assert.equal(embed.color, 0xFFFFFF);
  // A personal description and requirements replace the defaults.
  const custom = createGiveawayEmbed(activeGiveaway({ description: 'Win big!', requirements: 'Level 5' }), 'active');
  assert.match(custom.description, /\*\*Giveaway time !\*\*\n\nWin big!\n/);
  assert.match(custom.description, /\*\*Requirements\*\*\nLevel 5\n/);
  // Ended: winners tagged, green, ended time.
  const ended = createGiveawayEmbed(activeGiveaway({ endedAt: new Date(1_800_000_000_000).toISOString() }), 'ended', ['a', 'b']);
  assert.match(ended.description, /\*\*Winners\*\*\n<@a>, <@b>\n/);
  assert.ok(ended.description.includes('Thank you to everyone who participated!'));
  assert.ok(ended.description.includes('The winner(s) have been announced and tagged below!'));
  assert.match(ended.description, /\*\*Giveaway ended\*\*\n<t:1800000000:F>/);
  assert.equal(ended.color, 0xFFFFFF);
});

test('public buttons are neutral Enter and Leave only', () => {
  const rows = createGiveawayButtons(activeGiveaway({ participants: ['a', 'b', 'c'] })).map(json);
  const [entry] = rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(entry.components.map(component => component.label), ['Enter giveaway (3)', 'Leave giveaway']);
  assert.equal(entry.components[0].emoji.id, '1543303914152001536');
  assert.equal(entry.components[1].emoji.id, '1565742837453029516');
  assert.equal(entry.components[1].emoji.animated, true);
  assert.equal(entry.components[0].style, 2);
  assert.equal(entry.components[1].style, 2);
  const [endedEntry] = createGiveawayButtons(activeGiveaway({ participants: ['a'], ended: true })).map(json);
  assert.deepEqual(endedEntry.components.map(component => [component.label, component.disabled]), [['Enter giveaway (1)', true]]);
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
  assert.equal(json(enter.edited.components[0]).components[0].label, 'Enter giveaway (1)');
  assert.equal(json(enter.replies[0].embeds[0]).title, 'Success');

  clearAllRateLimits();
  const again = w.interaction('member');
  await button('giveaway_enter').execute(again, w.client);
  assert.equal(again.edited, undefined);
  assert.match(JSON.stringify(json(again.replies[0].embeds[0])), /already entered/);

  clearAllRateLimits();
  const leave = w.interaction('member');
  await button('giveaway_leave').execute(leave, w.client);
  assert.deepEqual((await loadGiveaway(w.client, GUILD, MESSAGE)).participants, []);
  assert.equal(json(leave.edited.components[0]).components[0].label, 'Enter giveaway (0)');

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

test('Manage is staff only and opens the private controls', async () => {
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
  assert.equal(json(staff.edited.embeds[0]).title, 'Success');
  // The default claim text is used when none was given: 24 hours.
  assert.equal(DEFAULT_GIVEAWAY_CLAIM, 'Please open a support ticket within 24 hours to claim your prize.');
  assert.match(createWinnerAnnouncement(activeGiveaway(), ['x']).embeds[0].description, new RegExp(DEFAULT_GIVEAWAY_CLAIM));
});

test('Reroll draws someone new and announces them; nobody new left is an error', async () => {
  const w = world({ [MESSAGE]: activeGiveaway({ participants: ['first', 'second'], ended: true, isEnded: true, winnerIds: ['first'] }) });
  const staff = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(staff, w.client, ['reroll', MESSAGE]);
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.deepEqual(stored.winnerIds, ['second']);
  assert.match(w.sent.at(-1).embeds[0].description, /New winner!/);
  assert.equal(w.sent.at(-1).content, '<@second>');

  const again = w.interaction('staff', { staff: true });
  await button('giveaway_admin').execute(again, w.client, ['reroll', MESSAGE]);
  assert.match(JSON.stringify(json(again.replies.at(-1).embeds[0])), /already won/);
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
  assert.equal(json(builder.embeds[1]).title, 'Giveaway builder');
  const controls = builder.components.map(json);
  const sessionId = controls[2].components[0].custom_id.split(':')[2];
  assert.deepEqual(controls.slice(2).map(row => row.components.map(component => [component.label, component.style])), [
    [['Edit text', 2], ['Edit claim', 2], ['Duration & winners', 2]],
    [['Post giveaway', 3], ['Cancel', 2]],
  ]);
  assert.equal(controls[1].components[0].options[0].label, '@everyone');
  const postButton = controls[3].components[0];
  assert.equal(postButton.emoji.name, '📤');
  assert.equal(postButton.disabled, true);

  const click = (customId, extra = {}) => Object.assign(w.interaction('staff', { staff: true }), { guild: command.guild, customId, ...extra });
  // Edit text form: prize, description, requirements, claim.
  const openText = click(`gbuilder:text:${sessionId}`);
  await handleGiveawayBuilderInteraction(openText, w.client);
  assert.deepEqual(openText.modal.components.map(row => row.components[0].custom_id), ['introTitle', 'description', 'prize', 'requirements', 'closingText']);
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
  assert.equal(json(textForm.updated.components[3]).components[0].disabled, false);
  const claimForm = click(`gbuilder:claimform:${sessionId}`, { fields: { getTextInputValue: () => 'DM the owner.' } });
  await handleGiveawayBuilderInteraction(claimForm, w.client);
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
  assert.match(timing.updated.embeds[0].description, /\*\*Winners\*\*\n2 winners/);
  // Tag a role with the role picker, then post.
  const role = click(`gbuilder:role:${sessionId}`, { values: ['giveaway-role'], isRoleSelectMenu: () => true });
  await handleGiveawayBuilderInteraction(role, w.client);
  assert.equal(json(role.updated.embeds[1]).fields.find(field => field.name === 'Tag').value, '<@&giveaway-role>');
  const post = click(`gbuilder:post:${sessionId}`);
  await handleGiveawayBuilderInteraction(post, w.client);
  const posted = w.sent[0];
  assert.equal(posted.content, '<@&giveaway-role>');
  assert.deepEqual(posted.allowedMentions, { parse: [], roles: ['giveaway-role'] });
  assert.match(posted.embeds[0].description, /\*\*Giveaway time !\*\*\n\nWin big!\nGood luck\n/);
  assert.match(posted.embeds[0].description, /\*\*Hosted by\*\*\n<@staff>/);
  const stored = await loadGiveaway(w.client, GUILD, posted.id);
  assert.equal(stored.requirements, 'Level 5');
  assert.equal(stored.claim, 'DM the owner.');
  assert.equal(stored.winnerCount, 2);
  assert.ok(stored.endsAt > Date.now() + 7_100_000);
  assert.equal(json(post.edited.embeds[0]).title, 'Success');
  // The builder is closed once posted.
  const late = click(`gbuilder:post:${sessionId}`);
  await handleGiveawayBuilderInteraction(late, w.client);
  assert.match(JSON.stringify(json(late.replies[0].embeds[0])), /expired/);
  assert.equal(w.sent.length, 1);
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
  assert.equal(json(everyone.updated.embeds[1]).fields.find(field => field.name === 'Tag').value, '@everyone');
  assert.equal(json(everyone.updated.components[1]).components[0].options[0].default, true);
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
  assert.match(list.edited.embeds[0].title, /^Participants/);
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
