import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import vote, { submitVoteForm } from '../src/commands/Tools/vote.js';
import voteButton from '../src/interactions/buttons/vote/vote.js';
import votePreview from '../src/interactions/buttons/vote/voteMedia.js';
import votePick from '../src/interactions/selectMenus/vote/votePick.js';
import voteManageSelects from '../src/interactions/selectMenus/vote/voteManage.js';
import voteManageButtons from '../src/interactions/buttons/vote/voteManage.js';
import voteMessageDelete from '../src/events/voteMessageDelete.js';
import voteMessageBulkDelete from '../src/events/voteMessageBulkDelete.js';
import voteChannelDelete from '../src/events/voteChannelDelete.js';
import { withCloudyFooter } from '../src/utils/cloudyFooter.js';
import { forgetVotePreviews, shrinkVotePicture } from '../src/services/votePreviewService.js';
import { spawnSync } from 'node:child_process';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const keepAsIs = async (buffer, name) => ({ attachment: buffer, name });
import { CLOUDY_FOOTER, buildVoteMessage, castVote, deleteVote, endDueVotes, endVoteNow, loadVote, refreshVoteSoon, voteBarPicture } from '../src/services/voteService.js';
import { isPlayerCommand } from '../src/config/playerCommands.js';

const GUILD = '191919191919191919';
const CLOUDY_LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const CHANNEL = '202020202020202020';
const json = value => value?.toJSON?.() || value;

// All text of a vote: the embed text, or the text of the card (votes with pictures).
// The counts on the vote buttons (number + count, like a classic map poll).
function countsOf(payload) {
  const row = (payload.components || []).map(json).find(component => component.type === 1);
  return row ? row.components.map(button => button.label) : [];
}

function textOf(payload) {
  if (payload.embeds?.length) return payload.embeds[0].description;
  const texts = [];
  const walk = component => {
    const data = json(component);
    if (data.type === 10) texts.push(data.content);
    for (const child of data.components || []) walk(child);
  };
  for (const component of payload.components || []) walk(component);
  return texts.join('\n');
}

function world() {
  const store = new Map();
  const sent = [];
  const channel = {
    id: CHANNEL,
    send: async payload => {
      const message = { id: String(210000000000000000n + BigInt(sent.length)), ...payload, edits: [],
        edit: async next => { message.edits.push(next); }, delete: async () => {},
        reply: async next => { const answer = await channel.send(next); message.reply = answer; return answer; },
        startThread: async options => {
          const thread = { name: options.name, posts: [], locked: false,
            send: async post => { thread.posts.push(post); return { url: `https://discord.com/channels/${GUILD}/thread/${thread.posts.length}` }; },
            setLocked: async value => { thread.locked = value; } };
          message.thread = thread;
          return thread;
        } };
      sent.push(message);
      return message;
    },
    messages: { fetch: async id => sent.find(message => message.id === id) || null },
  };
  const guild = { id: GUILD, channels: { cache: new Collection([[CHANNEL, channel]]) } };
  const client = {
    guilds: { cache: new Collection([[GUILD, guild]]) },
    db: {
      get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    },
  };
  let ids = 0;
  const command = (values, extra = {}) => {
    ids += 1;
    const interaction = {
      id: `run-${ids}`, client, guildId: GUILD, channelId: CHANNEL, channel, user: { id: 'host' }, inGuild: () => true,
      options: { getSubcommand: () => 'start', getString: name => values[name] ?? null, getRole: name => values[name] ?? null },
      reply: async payload => { interaction.answer = payload; },
      showModal: async modal => { interaction.modal = modal; },
      deleteReply: async () => {},
      ...extra,
    };
    return interaction;
  };
  // The media form after /vote: `files` holds the picture per field (media1..3).
  const form = (run, files = {}, user = run.user) => {
    const interaction = {
      client, guild, guildId: GUILD, channelId: CHANNEL, channel, user, inGuild: () => true,
      fields: { getUploadedFiles: name => (files[name] ? new Collection([['file', files[name]]]) : null) },
      reply: async payload => { interaction.answer = payload; },
      deferReply: async () => { interaction.deferred = true; },
      editReply: async payload => { interaction.answer = payload; }, deleteReply: async () => {},
    };
    return interaction;
  };
  return { client, sent, command, form };
}

// /vote, then the media form is sent (with the given pictures, or none).
async function create(w, values, { files = {}, deps = {} } = {}) {
  const run = w.command(values);
  await vote.execute(run);
  assert.ok(run.modal, 'the media form opens after the command');
  const form = w.form(run, files);
  // The Preview copies are made in the background; tests that need them make them themselves.
  // No 2-second redraw in tests unless a test asks for it.
  await submitVoteForm(form, run.id, { shrink: keepAsIs, refreshVote: () => {}, ...deps });
  // The pictures are stored in the background, right after the vote is posted.
  await new Promise(resolve => { setImmediate(resolve); });
  return { run, form };
}

test('/poll is now /vote, with buttons, live counts and an optional end time', async () => {
  const data = vote.data.toJSON();
  assert.equal(data.name, 'vote');
  assert.deepEqual(data.options.map(option => [option.name, option.type]), [['start', 1], ['manage', 1]]);
  assert.deepEqual(data.options[0].options.map(option => [option.name, Boolean(option.required)]),
    [['question', true], ['option1', true], ['option2', true], ['option3', false], ['duration', false], ['role', false]],
    'question, choices, description, duration and a role to tag; no media next to the options');
  assert.equal(isPlayerCommand('vote'), true);
  assert.equal(isPlayerCommand('poll'), false);
  const w = world();
  const { form } = await create(w, { question: 'Next map?', option1: 'Procedural', option2: 'Barren', duration: '1h' });
  const posted = w.sent[0];
  assert.equal(form.deferred, undefined, 'answered at once: no "thinking"');
  assert.equal(posted.flags, 32768, 'every vote is the card, also without pictures');
  const card = json(posted.components[0]);
  const [head] = card.components;
  assert.equal(head.type, 9, 'the title and the question beside the logo');
  assert.deepEqual(head.components.map(part => part.content), ['### The vote has started!', '**Question**\nNext map?']);
  assert.equal(head.accessory.media.url, CLOUDY_LOGO, 'the Cloudy logo (owner\'s choice)');
  assert.deepEqual(card.components.slice(1, 5).map(part => part.type === 10 ? part.content : part.type),
    [14, '**Choices**\n1️⃣ **Procedural**\n2️⃣ **Barren**', 14,
      '<:W87205667glowingdotwhite:1543291335036108830> Press a number below to vote.\n<:W87205667glowingdotwhite:1543291335036108830> Press any number to change your vote.\nIn the event of a tie, the outcome will be determined by a random selection among the winning responses.'],
    'choices tight under their heading, like Results; then the how-to (owner\'s choice: where the description was)');
  const text = textOf(posted);
  assert.match(text, /\*\*Choices\*\*\n1️⃣ \*\*Procedural\*\*\n2️⃣ \*\*Barren\*\*\n<:W87205667glowingdotwhite:1543291335036108830> Press a number below to vote\.\n<:W87205667glowingdotwhite:1543291335036108830> Press any number to change your vote\.\nIn the event of a tie, the outcome will be determined by a random selection among the winning responses\.\n\*\*Vote ends\*\*\n<t:\d+:f>$/);
  assert.doesNotMatch(text, /[▰▱]|<t:\d+:R>|Mode/, 'no bars, no countdown, no mode');
  assert.equal(card.components.some(part => part.type === 9 && part.accessory?.type === 2), false, 'no Preview without pictures');
  assert.deepEqual(json(posted.components[1]).components.map(button => [button.custom_id, button.emoji?.name, button.label]),
    [['vote_cast:0', '1️⃣', '0'], ['vote_cast:1', '2️⃣', '0']], 'number and count on each button');
  assert.equal(json(form.answer.embeds[0]).title, 'Success');
  assert.equal((await loadVote(w.client, GUILD, posted.id)).options.length, 2);
});

test('one vote per member: another option changes it, the same option keeps it; counts show, voters do not', async () => {
  const w = world();
  await create(w, { question: 'Wipe day?', option1: 'Thursday', option2: 'Friday', option3: 'Saturday' });
  const messageId = w.sent[0].id;
  assert.equal((await castVote(w.client, GUILD, messageId, 'a', 1)).status, 'voted');
  assert.equal((await castVote(w.client, GUILD, messageId, 'b', 1)).status, 'voted');
  assert.equal((await castVote(w.client, GUILD, messageId, 'a', 0)).status, 'changed');
  const again = await castVote(w.client, GUILD, messageId, 'b', 1);
  assert.equal(again.status, 'unchanged', 'a second click (e.g. to see the picture again) keeps the vote');
  const payload = buildVoteMessage((await castVote(w.client, GUILD, messageId, 'c', 0)).vote);
  const text = textOf(payload);
  assert.deepEqual(countsOf(payload), ['2', '1', '0']);
  assert.doesNotMatch(text, /<@/);
});

test('a vote click changes the vote in one step (no separate acknowledge and edit) and shows a private notice', async () => {
  const w = world();
  await create(w, { question: 'Q', option1: 'A', option2: 'B' });
  const click = {
    guildId: GUILD, user: { id: 'member' }, message: { id: w.sent[0].id },
    update: async payload => { click.updated = payload; },
    deferUpdate: async () => { click.acked = true; },
    editReply: async payload => { click.edited = payload; },
    followUp: async payload => { click.notice = payload; return { id: 'notice' }; },
    deleteReply: async () => {},
  };
  await voteButton.execute(click, w.client, ['1']);
  assert.deepEqual(countsOf(click.updated), ['0', '1']);
  assert.equal(click.acked, undefined, 'no acknowledge before the change');
  assert.equal(click.edited, undefined, 'no second edit');
  assert.equal(click.notice.flags, 64);
  assert.match(JSON.stringify(json(click.notice.embeds[0])), /You voted for \*\*B\*\*/);
});

test('when saving a vote takes longer than 2 seconds the click is acknowledged first', async t => {
  const w = world();
  await create(w, { question: 'Q', option1: 'A', option2: 'B' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const get = w.client.db.get;
  w.client.db.get = async (...args) => { await gate; return get(...args); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order = [];
  const click = { id: 'slow', guildId: GUILD, user: { id: 'member' }, message: { id: w.sent[0].id },
    update: async () => { order.push('update'); },
    deferUpdate: async () => { order.push('ack'); },
    editReply: async payload => { order.push('edit'); click.edited = payload; },
    followUp: async () => { order.push('notice'); return { id: 'n' }; },
    deleteReply: async () => {} };
  const running = voteButton.execute(click, w.client, ['0']);
  await new Promise(resolve => { setImmediate(resolve); });
  t.mock.timers.tick(2_000);
  await new Promise(resolve => { setImmediate(resolve); });
  release();
  await running;
  assert.deepEqual(order, ['ack', 'edit', 'notice']);
  assert.deepEqual(countsOf(click.edited), ['1', '0']);
  t.mock.timers.reset();
});

test('an ended vote stays as it was without buttons; the result is a message under it', async () => {
  const w = world();
  await create(w, { question: 'Q', option1: 'A', option2: 'B', duration: '1m' });
  const messageId = w.sent[0].id;
  await castVote(w.client, GUILD, messageId, 'a', 1);
  const stored = await loadVote(w.client, GUILD, messageId);
  await w.client.db.set(`guild:${GUILD}:votes`, { [messageId]: { ...stored, endsAt: Date.now() - 1000 } });
  await endDueVotes(w.client);
  const edited = w.sent[0].edits.at(-1);
  assert.match(textOf(edited), /^### The vote has started!\n/, 'the vote stays as it was');
  assert.equal(edited.components.length, 1, 'only the card: the vote buttons are gone (owner\'s choice)');
  const result = w.sent[0].reply;
  assert.equal(result, w.sent[1], 'the result is a new message, a reply to the vote');
  assert.match(textOf(result), /^### The vote has ended!\nIn the event of a tie, the outcome will be determined by a random selection among the winning responses\.\n\*\*Question\*\*\nQ\n\*\*Results\*\*\n2️⃣ \*\*B\*\* · 1 vote · 100%\n1️⃣ \*\*A\*\* · 0 votes · 0%\n\*\*Most votes\*\*\n2️⃣ \*\*B\*\* · 1 vote · 100%\n\*\*Total votes\*\*\n1 vote\n\*\*Vote ended\*\*\n<t:\d+:f>$/, 'Results above Most votes');
  assert.equal((await loadVote(w.client, GUILD, messageId)).resultMessageId, result.id);
  // The normal layout (older votes) loses its buttons too.
  const classic = buildVoteMessage({ question: 'Q', options: ['A', 'B'], votes: { a: 1 }, ended: true, endedAt: Date.now() });
  assert.deepEqual(classic.components, []);
  assert.equal((await castVote(w.client, GUILD, messageId, 'z', 0)).status, 'ended');
});

test('duplicate options and a bad duration are refused before anything is posted', async () => {
  const w = world();
  const same = w.command({ question: 'Q', option1: 'A', option2: 'a' });
  await vote.execute(same);
  assert.match(JSON.stringify(json(same.answer.embeds[0])), /must be different/);
  assert.equal(same.answer.flags, 64);
  assert.equal(same.modal, undefined, 'no form for a wrong vote');
  const bad = w.command({ question: 'Q', option1: 'A', option2: 'B', duration: 'soon' });
  await vote.execute(bad);
  assert.match(JSON.stringify(json(bad.answer.embeds[0])), /Invalid duration|duration/i);
  assert.equal(w.sent.length, 0);
});

test('every vote counts as 1%: 50 votes fill half the bar (plain text, no pictures)', () => {
  const vote = { question: 'Q', options: ['A', 'B'], votes: Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`u${n}`, 0])) };
  const text = buildVoteMessage(vote).embeds[0].description;
  assert.match(text, /1️⃣ \*\*A\*\*\n▰{3}▱{3} \*\*50%\*\* · 50 votes/);
});

test('an option with a picture gets a small Preview button right next to it; plain name, no link, no thread', async () => {
  const w = world();
  const uploads = [];
  const deps = {
    fetchImpl: async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer }),
    uploadPictures: async (client, guild, channel, files) => {
      uploads.push(files.map(file => file?.name || null));
      return {
        links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/1/2/${file.name}?ex=1` : null)),
        media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
      };
    },
  };
  const west = { url: 'https://cdn.discordapp.com/a/west.png', name: 'west.png', contentType: 'image/png', size: 2000 };
  const south = { url: 'https://cdn.discordapp.com/a/south.jpg', name: 'south.jpg', contentType: 'image/jpeg', size: 2000 };
  await create(w, { question: 'Choose your map', option1: 'DZ West', option2: 'DZ East', option3: 'DZ South', duration: '1h' },
    { files: { media1: west, media3: south }, deps });
  assert.deepEqual(uploads, [['option1.png', null, 'option3.jpg']], 'each picture stays with its own option');
  const posted = w.sent[0];
  const text = textOf(posted);
  assert.match(text, /1️⃣ \*\*DZ West\*\*\n2️⃣ \*\*DZ East\*\*\n3️⃣ \*\*DZ South\*\*\n/);
  assert.doesNotMatch(text, /\]\(|cdn\.discordapp\.com/, 'no links in the card: the Preview button shows the picture');
  assert.doesNotMatch(text, /railway|cloudy-embed-media/);
  assert.equal(posted.flags, 32768, "Discord's newer layout: a button can stand next to text");
  const [card, row] = posted.components.map(json);
  assert.equal(card.type, 17);
  assert.equal(card.accent_color, 0xFFFFFF, 'white side line');
  assert.equal(card.components[0].type, 9, 'the title and the question beside the logo');
  assert.equal(card.components[0].components[0].content, '### The vote has started!');
  assert.ok(card.components.some(part => part.content === '<:W87205667glowingdotwhite:1543291335036108830> Press a number below to vote.\n<:W87205667glowingdotwhite:1543291335036108830> Press any number to change your vote.\n<:W87205667glowingdotwhite:1543291335036108830> Press **Preview** to see the pictures.\nIn the event of a tie, the outcome will be determined by a random selection among the winning responses.'),
    'the how-to with the Preview line, under the choices');
  assert.equal(card.components[0].components[1].content, '**Question**\nChoose your map');
  assert.equal(card.components[0].accessory.media.url, CLOUDY_LOGO, 'the Cloudy logo (owner\'s choice)');
  // All choices tight in one block, like Results, with one Preview beside them.
  const previews = card.components.flatMap(part => (part.type === 9 && part.accessory?.type === 2
    ? [[part.components[0].content, part.accessory.custom_id, part.accessory.label]] : []));
  assert.deepEqual(previews, [['**Choices**\n1️⃣ **DZ West**\n2️⃣ **DZ East**\n3️⃣ **DZ South**', 'vote_media:all', 'Preview']]);
  assert.doesNotMatch(JSON.stringify(card), /vote-bars/, 'no bars');
  const footer = card.components.at(-1);
  assert.equal(footer.type, 12, 'footer: a thin white picture (small grey text was the only text option)');
  assert.equal(footer.items[0].media.url, 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@43d4c3420b7941344631efc0f6a8a2bb38528081/assets/vote-footer.png');
  assert.equal(footer.items[0].description, undefined, 'no ALT label (it showed as a black line)');
  assert.deepEqual(row.components.map(button => button.custom_id), ['vote_cast:0', 'vote_cast:1', 'vote_cast:2'], 'vote buttons stay under the vote');
  assert.equal(posted.components.length, 2);
  assert.equal(posted.thread, undefined, 'no thread on the vote');
  assert.equal((await loadVote(w.client, GUILD, posted.id)).layout, 'preview');
  assert.equal((await loadVote(w.client, GUILD, posted.id)).optionMedia.messageId, 'm1');

  const { form: video } = await create(w, { question: 'Q', option1: 'A', option2: 'B' },
    { files: { media1: { ...west, contentType: 'video/mp4' } }, deps });
  assert.match(JSON.stringify(json(video.answer.embeds[0])), /must be a picture/);
  assert.equal(w.sent.length, 1, 'nothing posted for a video');
});

test('Discord picture links of recent votes are renewed every 12 hours', async () => {
  const { refreshVotePictureLinks } = await import('../src/services/voteService.js');
  const w = world();
  const now = Date.parse('2026-11-05T20:00:00Z');
  const stored = {
    messageId: '210000000000000000', channelId: CHANNEL, guildId: GUILD, question: 'Q', options: ['A', 'B'], votes: {},
    optionLinks: ['https://cdn.discordapp.com/old/a.png?ex=1', null],
    optionMedia: { channelId: 'thread', messageId: 'store', names: ['option1.png', null] },
    mediaRefreshedAt: now - 13 * 60 * 60_000, createdAt: new Date(now - 60_000).toISOString(),
  };
  await w.client.db.set(`guild:${GUILD}:votes`, { [stored.messageId]: stored });
  const edits = [];
  w.client.guilds.cache.get(GUILD).channels.cache.get(CHANNEL).messages.fetch = async () => ({ edit: async payload => { edits.push(payload); } });
  w.client.channels = { fetch: async () => ({ messages: { fetch: async () => ({
    attachments: new Collection([['x', { name: 'option1.png', url: 'https://cdn.discordapp.com/new/a.png?ex=2' }]]),
  }) } }) };
  await refreshVotePictureLinks(w.client, now);
  const after = await loadVote(w.client, GUILD, stored.messageId);
  assert.deepEqual(after.optionLinks, ['https://cdn.discordapp.com/new/a.png?ex=2', null]);
  assert.equal(after.mediaRefreshedAt, now);
  assert.match(edits[0].embeds[0].description, /\[A\]\(https:\/\/cdn\.discordapp\.com\/new\/a\.png\?ex=2\)/);
  await refreshVotePictureLinks(w.client, now + 60_000);
  assert.equal(edits.length, 1, 'not again within 12 hours');
});

test('the option button only votes: the picture opens from the blue link, the notice is the usual 10-second Success', async t => {
  const w = world();
  const deps = {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    uploadPictures: async (client, guild, channel, files) => ({
      links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/1/2/${file.name}?ex=1` : null)),
      media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
    }),
  };
  await create(w, { question: 'Choose your map', option1: 'DZ West', option2: 'DZ East' },
    { files: { media1: { url: 'https://cdn.discordapp.com/a/w.png', name: 'w.png', contentType: 'image/png', size: 10 } }, deps });
  const posted = w.sent[0];
  const row = posted.components.map(json).find(component => component.type === 1);
  assert.deepEqual(row.components.map(button => [button.custom_id, button.label]),
    [['vote_cast:0', '0'], ['vote_cast:1', '0']], 'one button per option: number and count');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const click = (index, user = 'member') => {
    const state = { deleted: 0 };
    const interaction = { id: `i-${index}-${user}-${Math.random()}`, guildId: GUILD, user: { id: user }, message: { id: posted.id },
      update: async payload => { state.updated = payload; },
      deferUpdate: async () => { state.acked = true; },
      editReply: async payload => { state.edited = payload; },
      followUp: async payload => { state.notice = payload; return { id: 'notice' }; },
      deleteReply: async () => { state.deleted += 1; } };
    return voteButton.execute(interaction, w.client, [String(index)]).then(() => state);
  };
  const first = await click(0);
  const embed = json(first.notice.embeds[0]);
  assert.equal(embed.title, 'Success');
  assert.equal(embed.description, 'You voted for **DZ West**.');
  assert.equal(embed.image, undefined, 'no picture behind the button');
  assert.equal(first.updated.flags, 32768, 'the card stays a card');
  assert.deepEqual(countsOf(first.updated), ['1', '0']);
  t.mock.timers.tick(10_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(first.deleted, 1, 'gone after 10 seconds');

  const again = await click(0);
  assert.equal(again.updated, undefined, 'the same option again changes nothing');
  assert.equal(again.acked, true);
  assert.equal((await loadVote(w.client, GUILD, posted.id)).votes.member, 0, 'and keeps the vote');
  t.mock.timers.reset();
});

test('after /vote a form asks for an optional picture per option; empty posts the vote without pictures', async () => {
  const w = world();
  const run = w.command({ question: 'Next map?', option1: 'Procedural', option2: 'Barren', option3: 'Hapis' });
  await vote.execute(run);
  const modal = json(run.modal);
  assert.equal(modal.title, 'Add media');
  assert.equal(modal.custom_id, `vote_media_form:${run.id}`);
  assert.deepEqual(modal.components.map(label => [label.type, label.label, label.component.type, label.component.custom_id, label.component.required]),
    [[18, '1. Procedural', 19, 'media1', false], [18, '2. Barren', 19, 'media2', false], [18, '3. Hapis', 19, 'media3', false]]);
  assert.equal(w.sent.length, 0, 'nothing is posted before the form is sent');

  const stranger = w.form(run, {}, { id: 'someone-else' });
  await submitVoteForm(stranger, run.id);
  assert.match(JSON.stringify(json(stranger.answer.embeds[0])), /expired/);

  const again = w.command({ question: 'Next map?', option1: 'Procedural', option2: 'Barren' });
  await vote.execute(again);
  const empty = w.form(again);
  await submitVoteForm(empty, again.id, { uploadPictures: async () => { throw new Error('no upload without pictures'); } });
  assert.equal(json(empty.answer.embeds[0]).title, 'Success');
  assert.match(textOf(w.sent[0]), /1️⃣ \*\*Procedural\*\*/);
  assert.equal((await loadVote(w.client, GUILD, w.sent[0].id)).optionMedia, undefined);
  const twice = w.form(again);
  await submitVoteForm(twice, again.id);
  assert.match(JSON.stringify(json(twice.answer.embeds[0])), /expired/, 'one form posts one vote');
  assert.equal(w.sent.length, 1);
});

test('vote pictures go to a private thread in a text channel: #botlog first, else the vote channel', async () => {
  const { uploadVotePictures } = await import('../src/services/voteMediaService.js');
  const made = [];
  const textChannel = (id, name) => ({
    id, name, type: 0, send: async () => { throw new Error('not here'); },
    threads: { create: async options => {
      const thread = { id: `${id}-thread`, options, send: async payload => ({ id: 'stored',
        attachments: new Collection(payload.files.map(file => [file.name, { name: file.name, url: `https://cdn.discordapp.com/attachments/${id}/${file.name}` }])) }) };
      made.push([id, options.type, options.name]);
      return thread;
    } },
  });
  const store = new Map();
  const client = { db: { get: async (key, fallback) => store.get(key) ?? fallback, set: async (key, value) => { store.set(key, value); } },
    channels: { fetch: async () => null } };
  const voice = { id: 'v', name: 'botlog', type: 2, send: async () => {} };
  const general = textChannel('general', '💬 | general');
  const guild = { id: GUILD, channels: { cache: new Collection([['v', voice], ['general', general]]) } };
  const files = [{ attachment: Buffer.from('a'), name: 'option1.png' }, null];
  const result = await uploadVotePictures(client, guild, general, files);
  assert.deepEqual(made, [['general', 12, 'vote-media']], 'a voice channel named botlog is skipped: private thread in the vote channel');
  assert.deepEqual(result.links, ['https://cdn.discordapp.com/attachments/general/option1.png', null]);

  made.length = 0;
  store.clear();
  const botlog = textChannel('botlog-id', '📜│botlog-commands');
  guild.channels.cache.set('botlog-id', botlog);
  await uploadVotePictures(client, guild, general, files);
  assert.deepEqual(made, [['botlog-id', 12, 'vote-media']], '#botlog first');
});

test('Preview shows the picture privately under the vote with the option name, for 30 seconds', async t => {
  const w = world();
  const deps = {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    uploadPictures: async (client, guild, channel, files) => ({
      links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/1/2/${file.name}?ex=1` : null)),
      media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
    }),
  };
  await create(w, { question: 'Choose your map', option1: 'DZ West', option2: 'DZ East' },
    { files: { media2: { url: 'https://cdn.discordapp.com/a/e.png', name: 'e.png', contentType: 'image/png', size: 10 } }, deps });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const click = id => {
    const preview = { id, guildId: GUILD, user: { id: 'member' }, message: { id: w.sent[0].id }, deleted: 0,
      reply: async payload => { preview.answer = payload; },
      deferReply: async () => { preview.deferred = true; },
      editReply: async payload => { preview.edited = payload; },
      deleteReply: async () => { preview.deleted += 1; } };
    return preview;
  };
  const preview = click('p1');
  const fetched = [];
  const fetchImpl = async url => { fetched.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('png').buffer }; };
  forgetVotePreviews();
  await votePreview.execute(preview, w.client, ['1'], { fetchImpl, shrink: keepAsIs });
  assert.equal(preview.answer.flags, 64, 'private');
  assert.equal(preview.deferred, undefined, 'answered in one step: no thinking reply that is filled in later');
  const embed = preview.answer.embeds[0];
  assert.equal(embed.description, '2️⃣ **DZ East**', 'its number and name');
  assert.deepEqual(fetched, ['https://cdn.discordapp.com/attachments/1/2/option2.png?ex=1']);
  assert.equal(embed.image.url, 'attachment://option2.png', 'sent as a file: Discord knows its size at once');
  assert.equal(preview.answer.files[0].name, 'option2.png');
  assert.equal(embed.title, undefined);
  assert.equal(embed.thumbnail, undefined);
  t.mock.timers.tick(29_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(preview.deleted, 0);
  t.mock.timers.tick(1_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(preview.deleted, 1, 'gone after 30 seconds');
  assert.equal((await loadVote(w.client, GUILD, w.sent[0].id)).votes.member, undefined, 'a preview is not a vote');
  const again = click('p2');
  await votePreview.execute(again, w.client, ['1'], { fetchImpl, shrink: keepAsIs });
  assert.equal(fetched.length, 1, 'the second Preview uses the kept picture: instant');
  assert.equal(again.answer.files[0].name, 'option2.png');
  t.mock.timers.reset();
});

test('when the picture takes longer than 2 seconds, Preview is acknowledged first and filled in after', async t => {
  const w = world();
  const stored = {
    messageId: '210000000000000088', channelId: CHANNEL, guildId: GUILD, question: 'Q', options: ['A', 'B'], votes: {},
    optionLinks: ['https://cdn.discordapp.com/slow/option1.png?ex=1', null],
    optionMedia: { channelId: 'thread', messageId: 'store', names: ['option1.png', null] }, layout: 'preview',
  };
  await w.client.db.set(`guild:${GUILD}:votes`, { [stored.messageId]: stored });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { await gate; return { ok: true, arrayBuffer: async () => new ArrayBuffer(3) }; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order = [];
  const preview = { id: 'p3', guildId: GUILD, user: { id: 'member' }, message: { id: stored.messageId },
    reply: async () => { order.push('reply'); },
    deferReply: async () => { order.push('ack'); },
    editReply: async payload => { order.push('picture'); preview.edited = payload; },
    deleteReply: async () => {} };
  forgetVotePreviews();
  const running = votePreview.execute(preview, w.client, ['0'], { fetchImpl, shrink: keepAsIs });
  await new Promise(resolve => { setImmediate(resolve); });
  t.mock.timers.tick(2_000);
  await new Promise(resolve => { setImmediate(resolve); });
  release();
  await running;
  assert.deepEqual(order, ['ack', 'picture']);
  assert.equal(preview.edited.embeds[0].image.url, 'attachment://option1.png');
  t.mock.timers.reset();
});

test('if Discord refuses the card, the vote is posted in the normal layout with blue links', async () => {
  const w = world();
  const send = w.sent;
  const channel = w.client.guilds.cache.get(GUILD).channels.cache.get(CHANNEL);
  const original = channel.send;
  channel.send = async payload => {
    if (payload.flags) throw new Error('Invalid Form Body');
    return original(payload);
  };
  const deps = {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    uploadPictures: async (client, guild, ch, files) => ({
      links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/1/2/${file.name}?ex=1` : null)),
      media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
    }),
  };
  const { form } = await create(w, { question: 'Q', option1: 'A', option2: 'B' },
    { files: { media1: { url: 'https://cdn.discordapp.com/a/a.png', name: 'a.png', contentType: 'image/png', size: 10 } }, deps });
  assert.equal(json(form.answer.embeds[0]).title, 'Success');
  assert.equal(send.length, 1);
  assert.match(send[0].embeds[0].description, /\*\*\[A\]\(https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/option1\.png\?ex=1\)\*\*/);
  assert.equal((await loadVote(w.client, GUILD, send[0].id)).layout, undefined);
});

test('an expired picture link is renewed before the preview is shown', async () => {
  const w = world();
  const stored = {
    messageId: '210000000000000077', channelId: CHANNEL, guildId: GUILD, question: 'Q', options: ['A', 'B'], votes: {},
    optionLinks: ['https://cdn.discordapp.com/old/option1.png?ex=1', null],
    optionMedia: { channelId: 'thread', messageId: 'store', names: ['option1.png', null] }, layout: 'preview',
  };
  await w.client.db.set(`guild:${GUILD}:votes`, { [stored.messageId]: stored });
  w.client.channels = { fetch: async () => ({ messages: { fetch: async () => ({
    attachments: new Collection([['x', { name: 'option1.png', url: 'https://cdn.discordapp.com/new/option1.png?ex=2' }]]),
  }) } }) };
  const fetched = [];
  const fetchImpl = async url => {
    fetched.push(url);
    return url.includes('/old/') ? { ok: false } : { ok: true, arrayBuffer: async () => new ArrayBuffer(3) };
  };
  const preview = { id: 'p4', guildId: GUILD, user: { id: 'member' }, message: { id: stored.messageId },
    reply: async payload => { preview.answer = payload; },
    deferReply: async () => {}, editReply: async () => {}, deleteReply: async () => {} };
  forgetVotePreviews();
  await votePreview.execute(preview, w.client, ['0'], { fetchImpl, shrink: keepAsIs });
  assert.deepEqual(fetched, ['https://cdn.discordapp.com/old/option1.png?ex=1', 'https://cdn.discordapp.com/new/option1.png?ex=2']);
  assert.equal(preview.answer.embeds[0].image.url, 'attachment://option1.png');
});

test('the small Preview copies are made when the vote is posted, so the first Preview needs no download', async () => {
  forgetVotePreviews();
  const w = world();
  const shrunk = [];
  const deps = {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    uploadPictures: async (client, guild, channel, files) => ({
      links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/9/9/${file.name}?ex=1` : null)),
      media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
    }),
    shrink: async (buffer, name) => {
      shrunk.push(name);
      return { attachment: Buffer.from('small'), name: name.replace(/\.\w+$/, '.jpg') };
    },
  };
  await create(w, { question: 'Map?', option1: 'A', option2: 'B' },
    { files: { media2: { url: 'https://cdn.discordapp.com/a/b.png', name: 'b.png', contentType: 'image/png', size: 10 } }, deps });
  assert.deepEqual(shrunk, ['option2.png'], 'only options with a picture');
  assert.deepEqual((await loadVote(w.client, GUILD, w.sent[0].id)).optionLinks,
    [null, 'https://cdn.discordapp.com/attachments/9/9/option2.jpg?ex=1'], 'the small copy is what Cloudy stores');
  const fetched = [];
  const preview = { id: 'p9', guildId: GUILD, user: { id: 'member' }, message: { id: w.sent[0].id },
    reply: async payload => { preview.answer = payload; }, deferReply: async () => {}, editReply: async () => {}, deleteReply: async () => {} };
  await votePreview.execute(preview, w.client, ['1'], { fetchImpl: async url => { fetched.push(url); return { ok: false }; } });
  assert.deepEqual(fetched, [], 'no download: the small copy was ready');
  assert.equal(preview.answer.files[0].name, 'option2.jpg');
  assert.equal(preview.answer.embeds[0].image.url, 'attachment://option2.jpg');
});

test('when a vote with pictures ends, the result message shows Most votes with its picture', async () => {
  forgetVotePreviews();
  const w = world();
  const deps = {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    uploadPictures: async (client, guild, channel, files) => ({
      links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/8/8/${file.name}?ex=1` : null)),
      media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
    }),
  };
  await create(w, { question: 'Which map?', option1: 'DZ West', option2: 'DZ East', duration: '1m' }, {
    files: {
      media1: { url: 'https://cdn.discordapp.com/a/w.png', name: 'w.png', contentType: 'image/png', size: 10 },
      media2: { url: 'https://cdn.discordapp.com/a/e.png', name: 'e.png', contentType: 'image/png', size: 10 },
    },
    deps,
  });
  const messageId = w.sent[0].id;
  await castVote(w.client, GUILD, messageId, 'a', 1);
  await castVote(w.client, GUILD, messageId, 'b', 1);
  await castVote(w.client, GUILD, messageId, 'c', 0);
  const stored = await loadVote(w.client, GUILD, messageId);
  await w.client.db.set(`guild:${GUILD}:votes`, { [messageId]: { ...stored, endsAt: Date.now() - 1000 } });
  await endDueVotes(w.client);
  const result = w.sent[0].reply;
  assert.deepEqual(result.files.map(file => file.name), ['most-votes-2.png'], 'the winner\'s picture goes with the result');
  const card = json(result.components[0]);
  const parts = card.components.filter(part => part.type !== 14);
  assert.equal(parts[0].components[0].content, '### The vote has ended!');
  assert.equal(parts[0].components[1].content, 'In the event of a tie, the outcome will be determined by a random selection among the winning responses.', 'directly under the title (owner\'s choice)');
  assert.equal(parts[0].accessory.media.url, CLOUDY_LOGO, 'the Cloudy logo on the result too (owner\'s choice)');
  assert.match(parts[1].content, /^\*\*Results\*\*\n2️⃣ \*\*DZ East\*\* · 2 votes · 67%\n1️⃣ \*\*DZ West\*\* · 1 vote · 33%$/);
  assert.equal(parts[2].content, '**Most votes**\n2️⃣ **DZ East** · 2 votes · 67%');
  assert.equal(parts[3].items[0].media.url, 'attachment://most-votes-2.png', 'the winner\'s picture right under it');
  assert.ok(card.components.filter(part => part.type === 14).length >= 4, 'a little room between sections');
  assert.equal(w.sent[0].edits.at(-1).components.length, 1, 'the vote itself has no buttons anymore');
});

test('a big picture becomes a small JPG of at most 1024 px wide for Preview', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'vote-preview-test-'));
  try {
    const big = path.join(directory, 'big.png');
    spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2400x1350', '-frames:v', '1', big]);
    const original = await readFile(big);
    const small = await shrinkVotePicture(original, 'option1.png');
    assert.equal(small.name, 'option1.jpg');
    assert.ok(small.attachment.length < original.length, 'smaller to send');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: small.attachment });
    assert.equal(String(probe.stdout).trim(), '1024,576');
    const gif = await shrinkVotePicture(Buffer.from('GIF89a'), 'option2.gif');
    assert.equal(gif.name, 'option2.gif', 'GIFs keep the original');
    const broken = await shrinkVotePicture(Buffer.from('not a picture'), 'option3.png');
    assert.equal(broken.name, 'option3.png', 'unreadable pictures keep the original');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the card bar is a picture in steps of 5%: the same picture (and link) until the next step', () => {
  const name = share => voteBarPicture(share).split('/').pop();
  assert.equal(name(0), 'bar_00.png');
  assert.equal(name(0.02), 'bar_00.png');
  assert.equal(name(0.03), 'bar_01.png');
  assert.equal(name(0.5), 'bar_10.png');
  assert.equal(name(1), 'bar_20.png');
  assert.match(voteBarPicture(0.5), /^https:\/\/cdn\.jsdelivr\.net\/gh\/Dylano24\/Cloudy@[0-9a-f]{40}\/assets\/vote-bars\/bar_10\.png$/, 'a fixed link');
});

test('Preview opens a dropdown of the choices with a picture; a choice shows only its picture, without logo', async t => {
  forgetVotePreviews();
  const w = world();
  const deps = {
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    uploadPictures: async (client, guild, channel, files) => ({
      links: files.map(file => (file ? `https://cdn.discordapp.com/attachments/7/7/${file.name}?ex=1` : null)),
      media: { channelId: 't1', messageId: 'm1', names: files.map(file => file?.name || null) },
    }),
  };
  await create(w, { question: 'Map?', option1: 'West', option2: 'East', option3: 'South' }, {
    files: {
      media1: { url: 'https://cdn.discordapp.com/a/w.png', name: 'w.png', contentType: 'image/png', size: 10 },
      media3: { url: 'https://cdn.discordapp.com/a/s.png', name: 's.png', contentType: 'image/png', size: 10 },
    },
    deps,
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tick = async ms => { t.mock.timers.tick(ms); await new Promise(resolve => { setImmediate(resolve); }); };
  const preview = { id: 'pall', guildId: GUILD, user: { id: 'member' }, message: { id: w.sent[0].id }, deleted: 0,
    reply: async payload => { preview.answer = payload; }, deferReply: async () => {}, editReply: async () => {},
    deleteReply: async () => { preview.deleted += 1; } };
  await votePreview.execute(preview, w.client, ['all'], { fetchImpl: async () => ({ ok: false }), shrink: keepAsIs });
  assert.equal(preview.answer.flags, 64, 'private');
  assert.equal(preview.answer.embeds, undefined, 'first only the dropdown');
  const menu = json(preview.answer.components[0]).components[0];
  assert.equal(menu.custom_id, `vote_pick:${w.sent[0].id}:pall`);
  assert.equal(menu.placeholder, 'Choices preview');
  assert.deepEqual(menu.options.map(option => [option.label, option.value, option.emoji.name, Boolean(option.default)]), [
    ['West', '0', '1️⃣', false],
    ['South', '2', '3️⃣', false],
  ], 'only the choices with a picture, each with its number');
  await tick(20_000);
  const pick = { guildId: GUILD, values: ['2'], message: { id: 'private' }, deleted: 0,
    update: async payload => { pick.answer = payload; }, deferUpdate: async () => {}, editReply: async () => {},
    deleteReply: async () => { pick.deleted += 1; } };
  await votePick.execute(pick, w.client, [w.sent[0].id, 'pall'], { fetchImpl: async () => ({ ok: false }), shrink: keepAsIs });
  assert.equal(pick.answer.embeds.length, 1, 'only the chosen picture');
  const [embed] = pick.answer.embeds;
  assert.equal(embed.description, undefined, 'no name above the picture: the dropdown shows the choice');
  assert.equal(embed.image.url, 'attachment://option3.png');
  assert.equal(embed.footer.text, CLOUDY_FOOTER);
  assert.equal(withCloudyFooter({ embeds: pick.answer.embeds }).embeds[0].thumbnail, undefined, 'no logo: it has its own footer');
  assert.deepEqual(pick.answer.files.map(file => file.name), ['option3.png']);
  assert.deepEqual(pick.answer.attachments, [], 'the picture shown before is replaced');
  const chosen = json(pick.answer.components[0]).components[0].options.filter(option => option.default);
  assert.deepEqual(chosen.map(option => option.value), ['2'], 'the dropdown stays to switch, with the choice selected');
  await tick(29_000);
  assert.deepEqual([preview.deleted, pick.deleted], [0, 0], 'a choice restarts the 30 seconds');
  await tick(1_000);
  assert.deepEqual([preview.deleted, pick.deleted], [0, 1], 'gone 30 seconds after the last choice, once');
  t.mock.timers.reset();
});

test('the vote can tag a role; the how-to sits under the choices and there is no description', async () => {
  const w = world();
  const role = { id: '303030303030303030', mentionable: true };
  await create(w, { question: 'Map?', option1: 'West', option2: 'East', role });
  // The tag is its own message right above the vote, never edited (owner's choice).
  const tagMessage = w.sent[0];
  assert.equal(tagMessage.content, '<@&303030303030303030>', 'the tag above the vote');
  assert.deepEqual(tagMessage.allowedMentions, { parse: [], roles: ['303030303030303030'] }, 'only that role is pinged');
  const posted = w.sent[1];
  assert.deepEqual(posted.allowedMentions, { parse: [] }, 'the vote itself pings nobody');
  assert.equal(json(posted.components[0]).type, 17, 'the vote has no tag inside it');
  const card = json(posted.components[0]);
  assert.deepEqual(card.components.flatMap(part => (part.type === 9 ? part.components : part.type === 10 ? [part] : []))
    .map(part => part.content.split('\n')[0]),
    ['### The vote has started!', '**Question**', '**Choices**', '<:W87205667glowingdotwhite:1543291335036108830> Press a number below to vote.', '**Vote ends**'],
    'Question, Choices, then the how-to (owner\'s choice: where the description was)');
  assert.doesNotMatch(JSON.stringify(card), /Description/);
  const stored = await loadVote(w.client, GUILD, posted.id);
  assert.equal(stored.tagMessageId, tagMessage.id);
  assert.equal(json(buildVoteMessage({ ...stored, ended: true }).components[0]).type, 17, 'a redraw never touches the tag');
  // Older votes (tag inside the vote) keep it there.
  const { tagMessageId, ...older } = stored;
  assert.equal(json(buildVoteMessage(older).components[0]).content, '<@&303030303030303030>');
  // The result under the vote tags the same role when the vote ends.
  await endVoteNow(w.client, w.client.guilds.cache.get(GUILD), posted.id);
  // The tag is its own message (a reply to the vote), the result right under it
  // without a tag, so Discord highlights only the tag (owner's choice).
  const resultTag = w.sent.at(-2);
  const result = w.sent.at(-1);
  assert.equal(posted.reply, resultTag, 'the tag message is the reply to the vote');
  assert.equal(resultTag.content, '<@&303030303030303030>', 'the tag above the result too');
  assert.deepEqual(resultTag.allowedMentions, { parse: [], roles: ['303030303030303030'] }, 'the role is pinged for the result');
  assert.match(textOf(result), /### The vote has ended!/);
  assert.equal(json(result.components[0]).type, 17, 'the result has no tag inside it');
  assert.deepEqual(result.allowedMentions, { parse: [] });
  // Delete keeps the result's tag message (owner's choice).
  const deletedIds = [];
  for (const message of w.sent) { const original = message.delete; message.delete = async () => { deletedIds.push(message.id); return original?.(); }; }
  await deleteVote(w.client, w.client.guilds.cache.get(GUILD), posted.id);
  assert.ok(!deletedIds.includes(resultTag.id), 'the result tag stays');
  const plain = w.sent.length;
  await create(w, { question: 'No tag', option1: 'A', option2: 'B' });
  assert.equal(json(w.sent[plain].components[0]).type, 17, 'without a role the card comes first');
  assert.deepEqual(w.sent[plain].allowedMentions, { parse: [] });
});

test('tagging @everyone or a role that cannot be mentioned needs Mention Everyone', async () => {
  const w = world();
  const everyone = w.command({ question: 'Q', option1: 'A', option2: 'B', role: { id: GUILD, mentionable: true } });
  await vote.execute(everyone);
  assert.match(JSON.stringify(json(everyone.answer.embeds[0])), /cannot tag this role/);
  assert.equal(everyone.modal, undefined);
  const allowed = w.command({ question: 'Q', option1: 'A', option2: 'B', role: { id: GUILD } },
    { memberPermissions: { has: () => true } });
  await vote.execute(allowed);
  assert.ok(allowed.modal, 'staff may tag everyone');
  await submitVoteForm(w.form(allowed), allowed.id, { shrink: keepAsIs });
  assert.equal(w.sent[0].content, '@everyone');
  assert.deepEqual(w.sent[0].allowedMentions, { parse: ['everyone'] });
});

test('/vote manage: choose Active or Ended, then a vote; End closes it, Delete removes it for good', async () => {
  const w = world();
  await create(w, { question: 'Map?', option1: 'West', option2: 'East' });
  await create(w, { question: 'Old one', option1: 'A', option2: 'B' });
  const [open, old] = [w.sent[0].id, w.sent[1].id];
  const guild = w.client.guilds.cache.get(GUILD);
  const handler = (list, name) => list.find(entry => entry.name === name).execute;
  const staff = { has: () => true };
  const click = (extra = {}) => {
    const interaction = { id: `i${Math.random()}`, client: w.client, guildId: GUILD, guild, inGuild: () => true,
      user: { id: 'staff' }, memberPermissions: staff, options: { getSubcommand: () => 'manage' },
      reply: async payload => { interaction.answer = payload; }, deferUpdate: async () => { interaction.acked = true; },
      editReply: async payload => { interaction.answer = payload; }, deleteReply: async () => {}, ...extra };
    return interaction;
  };
  const data = vote.data.toJSON();
  assert.equal(data.default_member_permissions, undefined, 'members can start votes; Manage Server is checked by the manager');
  // End the old one first, so there is one of each status.
  const first = click();
  await vote.execute(first);
  assert.equal(first.answer.flags, 64, 'private');
  assert.match(first.answer.embeds[0].description, /1 active · 0 ended|2 active · 0 ended/);
  const status = json(first.answer.components[0]).components[0];
  assert.equal(status.custom_id, 'vmanage_status:staff');
  assert.deepEqual(status.options.map(option => option.label), ['Active votes', 'Ended votes']);
  const active = click({ values: ['active'] });
  await handler(voteManageSelects, 'vmanage_status')(active, w.client, ['staff']);
  const list = json(active.answer.components[1]).components[0];
  assert.deepEqual(list.options.map(option => option.value).sort(), [open, old].sort(), 'both votes are open');
  const pick = click({ values: [old] });
  await handler(voteManageSelects, 'vmanage_vote')(pick, w.client, ['staff']);
  assert.match(pick.answer.embeds[0].description, /\*\*Old one\*\*/);
  assert.deepEqual(json(pick.answer.components[0]).components.map(button => button.label), ['End', 'Delete', 'Back']);
  const end = click();
  await handler(voteManageButtons, 'vmanage_btn')(end, w.client, ['end', 'staff', old]);
  assert.equal(end.acked, true, 'acknowledged before any database work');
  assert.equal(json(end.answer.embeds[0]).title, 'Success');
  assert.equal((await loadVote(w.client, GUILD, old)).ended, true);
  assert.match(textOf(w.sent.at(-1)), /^### The vote has ended!\nIn the event of a tie[^\n]*\n\*\*Question\*\*\nOld one/, 'its result under it, as at its end time');
  // Ended votes: only Delete and Back.
  const ended = click({ values: ['ended'] });
  await handler(voteManageSelects, 'vmanage_status')(ended, w.client, ['staff']);
  assert.deepEqual(json(ended.answer.components[1]).components[0].options.map(option => option.value), [old]);
  const panel = click({ values: [old] });
  await handler(voteManageSelects, 'vmanage_vote')(panel, w.client, ['staff']);
  assert.deepEqual(json(panel.answer.components[0]).components.map(button => button.label), ['Delete', 'Back']);
  const ask = click();
  await handler(voteManageButtons, 'vmanage_btn')(ask, w.client, ['delete', 'staff', old]);
  assert.equal(ask.answer.embeds[0].title, 'Delete vote?');
  const deleted = [];
  for (const message of w.sent) message.delete = async () => { deleted.push(message.id); };
  const result = w.sent.at(-1).id;
  const confirm = click();
  await handler(voteManageButtons, 'vmanage_btn')(confirm, w.client, ['confirmdelete', 'staff', old]);
  assert.equal(json(confirm.answer.embeds[0]).title, 'Success');
  assert.equal(await loadVote(w.client, GUILD, old), null, 'gone from the store');
  assert.deepEqual(deleted.sort(), [old, result].sort(), 'the vote and its result message are removed');
  // Only the staff member who opened it, and only staff.
  const other = click({ user: { id: 'someone' } });
  await handler(voteManageButtons, 'vmanage_btn')(other, w.client, ['end', 'staff', open]);
  assert.match(JSON.stringify(json(other.answer.embeds[0])), /Manage Server/);
  assert.equal((await loadVote(w.client, GUILD, open)).ended, false);
  const member = click({ memberPermissions: { has: () => false } });
  await vote.execute(member);
  assert.match(JSON.stringify(json(member.answer.embeds[0])), /Manage Server/);
});

test('/vote manage lists only votes still in a channel: a vote deleted in Discord is forgotten', async () => {
  const w = world();
  w.client.user = { id: 'bot' };
  for (const question of ['Kept', 'Deleted by hand', 'Deleted while offline', 'Purged']) {
    await create(w, { question, option1: 'A', option2: 'B' });
  }
  const [kept, byHand, offline, purged] = w.sent.map(message => message.id);
  const guild = w.client.guilds.cache.get(GUILD);
  // Deleted in Discord while Cloudy is online: forgotten at once.
  await voteMessageDelete.execute({ id: byHand, guildId: GUILD, client: w.client, author: { id: 'bot' } });
  assert.equal(await loadVote(w.client, GUILD, byHand), null);
  // A member's own deleted message is not a vote: nothing changes.
  await voteMessageDelete.execute({ id: kept, guildId: GUILD, client: w.client, author: { id: 'member' } });
  assert.ok(await loadVote(w.client, GUILD, kept));
  // A purge.
  await voteMessageBulkDelete.execute(new Collection([[purged, { id: purged, guildId: GUILD, client: w.client }]]));
  assert.equal(await loadVote(w.client, GUILD, purged), null);
  // Deleted while Cloudy was offline: /vote manage checks the message and forgets it.
  const channel = guild.channels.cache.get(CHANNEL);
  const fetchMessage = channel.messages.fetch;
  channel.messages.fetch = async id => {
    if (id === offline) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    return fetchMessage(id);
  };
  const open = () => {
    const run = { id: `vm${Math.random()}`, client: w.client, guildId: GUILD, guild, inGuild: () => true,
      user: { id: 'staff' }, memberPermissions: { has: () => true }, options: { getSubcommand: () => 'manage' },
      reply: async payload => { run.answer = payload; }, deleteReply: async () => {} };
    return run;
  };
  const first = open();
  await vote.execute(first);
  assert.match(first.answer.embeds[0].description, /1 active · 0 ended/, 'only the vote that is still in its channel');
  assert.equal(await loadVote(w.client, GUILD, offline), null, 'forgotten for good');
  // A message Cloudy cannot check (no access) stays listed: never forgotten by guess.
  channel.messages.fetch = async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); };
  const second = open();
  await vote.execute(second);
  assert.match(second.answer.embeds[0].description, /1 active · 0 ended/);
  // A deleted channel takes its votes with it.
  await voteChannelDelete.execute({ id: CHANNEL, guildId: GUILD }, w.client);
  assert.equal(await loadVote(w.client, GUILD, kept), null);
});

test('the vote buttons use a still copy of each number badge (animated ones sometimes stayed empty in a button)', async () => {
  const { existsSync } = await import('node:fs');
  for (let number = 1; number <= 10; number += 1) {
    assert.ok(existsSync(new URL(`../assets/vote-emojis/key_${number}_still.png`, import.meta.url)), `still badge ${number}`);
  }
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/services/voteService.js', import.meta.url), 'utf8'));
  assert.equal((source.match(/\.setEmoji\(buttonIcon\(index\)\)/g) || []).length, 2, 'both layouts use the still badge in their buttons');
  assert.doesNotMatch(source, /\.setEmoji\(numberIcon\(/, 'no animated badge in a button');
});

test('2 seconds after posting the vote is redrawn once with its current counts, so a missed emoji loads again', async t => {
  const w = world();
  const scheduled = [];
  await create(w, { question: 'Q', option1: 'A', option2: 'B' }, { deps: { refreshVote: (...args) => scheduled.push(args) } });
  assert.equal(scheduled.length, 1, 'one redraw is planned when the vote is posted');
  const posted = w.sent[0];
  assert.equal(scheduled[0][2], posted, 'for the posted vote');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  refreshVoteSoon(w.client, GUILD, posted);
  await castVote(w.client, GUILD, posted.id, 'member', 1);
  t.mock.timers.tick(1_999);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(posted.edits.length, 0, 'not before 2 seconds');
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(posted.edits.length, 1, 'redrawn once');
  assert.deepEqual(countsOf(posted.edits[0]), ['0', '1'], 'with the vote cast in the meantime');
  t.mock.timers.reset();
});

test('a tie: Cloudy picks one tied option at random and says so under Most votes', async () => {
  const { buildVoteResultMessage: result, voteWinners, TIE_TEXT } = await import('../src/services/voteService.js');
  const vote = { guildId: GUILD, question: 'Map?', options: ['Map 1', 'Map 2', 'Map 3'], votes: { a: 0, b: 1 }, layout: 'preview', tieWinner: 1 };
  assert.deepEqual(voteWinners(vote), [1], 'only the picked option');
  const text = JSON.stringify(json(result(vote).components[0]));
  assert.match(text, /\*\*Random selection result\*\*\\n[^"]*Map 2[^"]*\\nThe result was randomly selected from the most-voted responses due to a tie\./);
  assert.equal(TIE_TEXT, 'The result was randomly selected from the most-voted responses due to a tie.');
  assert.doesNotMatch(text, /Most votes/, 'the heading is Random selection result on a tie');
  // No tie: the one winner and no sentence.
  const clear = { ...vote, votes: { a: 0, b: 0, c: 1 }, tieWinner: undefined };
  assert.deepEqual(voteWinners(clear), [0]);
  assert.doesNotMatch(JSON.stringify(json(result(clear).components[0])), /due to a tie|Random selection result/);
  assert.match(JSON.stringify(json(result(clear).components[0])), /\*\*Most votes\*\*/);
});
