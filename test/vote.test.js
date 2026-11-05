import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import vote, { submitVoteForm } from '../src/commands/Tools/vote.js';
import voteButton from '../src/interactions/buttons/vote/vote.js';
import { buildVoteMessage, castVote, endDueVotes, loadVote } from '../src/services/voteService.js';
import { isPlayerCommand } from '../src/config/playerCommands.js';

const GUILD = '191919191919191919';
const CHANNEL = '202020202020202020';
const json = value => value?.toJSON?.() || value;

function world() {
  const store = new Map();
  const sent = [];
  const channel = {
    id: CHANNEL,
    send: async payload => {
      const message = { id: String(210000000000000000n + BigInt(sent.length)), ...payload, edits: [],
        edit: async next => { message.edits.push(next); }, delete: async () => {},
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
      options: { getString: name => values[name] ?? null },
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
  await submitVoteForm(form, run.id, deps);
  return { run, form };
}

test('/poll is now /vote, with buttons, live counts and an optional end time', async () => {
  const data = vote.data.toJSON();
  assert.equal(data.name, 'vote');
  assert.deepEqual(data.options.map(option => [option.name, Boolean(option.required)]),
    [['question', true], ['option1', true], ['option2', true], ['option3', false], ['duration', false]], 'no media next to the options');
  assert.equal(isPlayerCommand('vote'), true);
  assert.equal(isPlayerCommand('poll'), false);
  const w = world();
  const { form } = await create(w, { question: 'Next map?', option1: 'Procedural', option2: 'Barren', duration: '1h' });
  const posted = w.sent[0];
  const embed = posted.embeds[0];
  assert.equal(embed.title, 'Vote');
  assert.match(embed.description, /^\*\*Next map\?\*\*\n\n1️⃣ \*\*Procedural\*\*\n▱{6} \*\*0%\*\* · 0 votes\n2️⃣ \*\*Barren\*\*\n/);
  assert.match(embed.description, /\*\*Total votes:\*\* 0\n\n\*\*Ends:\*\* <t:\d+:f> \(<t:\d+:R>\)$/);
  assert.equal(embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.ok(embed.thumbnail.url);
  assert.deepEqual(json(posted.components[0]).components.map(button => [button.custom_id, button.emoji?.name, button.label]),
    [['vote_cast:0', '1️⃣', 'Procedural'], ['vote_cast:1', '2️⃣', 'Barren']]);
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
  const text = buildVoteMessage((await castVote(w.client, GUILD, messageId, 'c', 0)).vote).embeds[0].description;
  assert.match(text, /1️⃣ \*\*Thursday\*\*\n▱{6} \*\*2%\*\* · 2 votes/);
  assert.match(text, /2️⃣ \*\*Friday\*\*\n▱{6} \*\*1%\*\* · 1 vote/);
  assert.match(text, /\*\*Total votes:\*\* 3/);
  assert.doesNotMatch(text, /<@/);
});

test('a vote button answers first, refreshes the counts and shows a private notice', async () => {
  const w = world();
  await create(w, { question: 'Q', option1: 'A', option2: 'B' });
  const click = {
    guildId: GUILD, user: { id: 'member' }, message: { id: w.sent[0].id },
    deferUpdate: async () => { click.acked = true; },
    editReply: async payload => { click.edited = payload; },
    followUp: async payload => { click.notice = payload; return { id: 'notice' }; },
    deleteReply: async () => {},
  };
  await voteButton.execute(click, w.client, ['1']);
  assert.equal(click.acked, true);
  assert.match(click.edited.embeds[0].description, /2️⃣ \*\*B\*\*\n▱{6} \*\*1%\*\* · 1 vote/);
  assert.equal(click.notice.flags, 64);
  assert.match(JSON.stringify(json(click.notice.embeds[0])), /You voted for \*\*B\*\*/);
});

test('an ended vote shows the winner and disabled buttons', async () => {
  const w = world();
  await create(w, { question: 'Q', option1: 'A', option2: 'B', duration: '1m' });
  const messageId = w.sent[0].id;
  await castVote(w.client, GUILD, messageId, 'a', 1);
  const stored = await loadVote(w.client, GUILD, messageId);
  await w.client.db.set(`guild:${GUILD}:votes`, { [messageId]: { ...stored, endsAt: Date.now() - 1000 } });
  await endDueVotes(w.client);
  const edited = w.sent[0].edits.at(-1);
  assert.equal(edited.embeds[0].title, 'Vote ended');
  assert.match(edited.embeds[0].description, /\*\*Total votes:\*\* 1\n\n\*\*Winner:\*\* B\n\*\*Ended:\*\* <t:\d+:f>$/);
  assert.ok(json(edited.components[0]).components.every(button => button.disabled));
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

test('every vote counts as 1%: 50 votes fill half the bar', () => {
  const vote = { question: 'Q', options: ['A', 'B'], votes: Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`u${n}`, 0])) };
  const text = buildVoteMessage(vote).embeds[0].description;
  assert.match(text, /1️⃣ \*\*A\*\*\n▰{3}▱{3} \*\*50%\*\* · 50 votes/);
});

test('an option with a picture becomes a blue link to the picture on Discord; no buttons, no thread', async () => {
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
  const text = posted.embeds[0].description;
  assert.match(text, /\*\*\[DZ West\]\(https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/option1\.png\?ex=1\)\*\*/);
  assert.match(text, /\*\*DZ East\*\*/, 'no picture: plain white text');
  assert.match(text, /\*\*\[DZ South\]\(https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/option3\.jpg\?ex=1\)\*\*/);
  assert.doesNotMatch(text, /railway|cloudy-embed-media/);
  assert.match(text, /\*\*Total votes:\*\* 0\n\n\*\*Ends:\*\*/, 'empty line before the end');
  assert.equal(posted.components.length, 1, 'only the vote buttons');
  assert.equal(posted.thread, undefined, 'no thread on the vote');
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

test('the option button votes and shows its picture privately for 30 seconds; without a picture the usual 10-second notice', async t => {
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
  assert.deepEqual(json(posted.components[0]).components.map(button => [button.custom_id, button.label]),
    [['vote_cast:0', 'DZ West'], ['vote_cast:1', 'DZ East']], 'one button per option: digit and name');
  assert.equal(posted.components.length, 1);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const click = (index, user = 'member') => {
    const state = { deleted: 0 };
    const interaction = { id: `i-${index}-${user}-${Math.random()}`, guildId: GUILD, user: { id: user }, message: { id: posted.id },
      deferUpdate: async () => {}, editReply: async payload => { state.edited = payload; },
      followUp: async payload => { state.notice = payload; return { id: 'notice' }; },
      deleteReply: async () => { state.deleted += 1; } };
    return voteButton.execute(interaction, w.client, [String(index)]).then(() => state);
  };
  const first = await click(0);
  const embed = first.notice.embeds[0];
  assert.equal(embed.image.url, 'https://cdn.discordapp.com/attachments/1/2/option1.png?ex=1');
  assert.equal(embed.description, 'You voted for **DZ West**.');
  assert.equal(embed.title, undefined);
  assert.equal(embed.thumbnail, undefined);
  assert.match(first.edited.embeds[0].description, /\[DZ West\]\(https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/option1\.png\?ex=1\)\*\*\n▱{6} \*\*1%\*\* · 1 vote/);
  t.mock.timers.tick(10_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(first.deleted, 0, 'the picture stays longer than 10 seconds');
  t.mock.timers.tick(20_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(first.deleted, 1, 'gone after 30 seconds');

  const again = await click(0);
  assert.equal(again.edited, undefined, 'a second look keeps the vote and changes nothing');
  assert.equal(again.notice.embeds[0].image.url, embed.image.url);
  assert.equal((await loadVote(w.client, GUILD, posted.id)).votes.member, 0);

  const plain = await click(1, 'other');
  assert.equal(json(plain.notice.embeds[0]).title, 'Success');
  t.mock.timers.tick(10_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(plain.deleted, 1, 'no picture: gone after 10 seconds');
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
  assert.match(w.sent[0].embeds[0].description, /1️⃣ \*\*Procedural\*\*/);
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
