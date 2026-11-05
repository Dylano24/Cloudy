import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import vote from '../src/commands/Tools/vote.js';
import voteButton from '../src/interactions/buttons/vote/vote.js';
import voteMedia from '../src/interactions/buttons/vote/voteMedia.js';
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
  const command = (values, extra = {}) => {
    const interaction = {
      client, guildId: GUILD, channelId: CHANNEL, channel, user: { id: 'host' }, inGuild: () => true,
      options: { getString: name => values[name] ?? null },
      deferReply: async () => {}, editReply: async payload => { interaction.reply = payload; }, deleteReply: async () => {},
      ...extra,
    };
    return interaction;
  };
  return { client, sent, command };
}

test('/poll is now /vote, with buttons, live counts and an optional end time', async () => {
  const data = vote.data.toJSON();
  assert.equal(data.name, 'vote');
  assert.deepEqual(data.options.map(option => option.name),
    ['question', 'option1', 'media1', 'option2', 'media2', 'option3', 'media3', 'duration']);
  assert.equal(isPlayerCommand('vote'), true);
  assert.equal(isPlayerCommand('poll'), false);
  const w = world();
  const run = w.command({ question: 'Next map?', option1: 'Procedural', option2: 'Barren', duration: '1h' });
  await vote.execute(run);
  const posted = w.sent[0];
  const embed = posted.embeds[0];
  assert.equal(embed.title, 'Vote');
  assert.match(embed.description, /^\*\*Next map\?\*\*\n\n1️⃣ \*\*Procedural\*\*\n▱{6} \*\*0%\*\* · 0 votes\n2️⃣ \*\*Barren\*\*\n/);
  assert.match(embed.description, /\*\*Total votes:\*\* 0\n\n\*\*Ends:\*\* <t:\d+:f> \(<t:\d+:R>\)$/);
  assert.equal(embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.ok(embed.thumbnail.url);
  assert.deepEqual(json(posted.components[0]).components.map(button => [button.custom_id, button.emoji?.name, button.label]),
    [['vote_cast:0', '1️⃣', undefined], ['vote_cast:1', '2️⃣', undefined]]);
  assert.equal(json(run.reply.embeds[0]).title, 'Success');
  assert.equal((await loadVote(w.client, GUILD, posted.id)).options.length, 2);
});

test('one vote per member: change or remove it; counts show, voters do not', async () => {
  const w = world();
  await vote.execute(w.command({ question: 'Wipe day?', option1: 'Thursday', option2: 'Friday', option3: 'Saturday' }));
  const messageId = w.sent[0].id;
  assert.equal((await castVote(w.client, GUILD, messageId, 'a', 1)).status, 'voted');
  assert.equal((await castVote(w.client, GUILD, messageId, 'b', 1)).status, 'voted');
  assert.equal((await castVote(w.client, GUILD, messageId, 'a', 0)).status, 'changed');
  const removed = await castVote(w.client, GUILD, messageId, 'b', 1);
  assert.equal(removed.status, 'removed');
  const text = buildVoteMessage((await castVote(w.client, GUILD, messageId, 'c', 0)).vote).embeds[0].description;
  assert.match(text, /1️⃣ \*\*Thursday\*\*\n▱{6} \*\*2%\*\* · 2 votes/);
  assert.match(text, /\*\*Total votes:\*\* 2/);
  assert.doesNotMatch(text, /<@/);
});

test('a vote button answers first, refreshes the counts and shows a private notice', async () => {
  const w = world();
  await vote.execute(w.command({ question: 'Q', option1: 'A', option2: 'B' }));
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
  await vote.execute(w.command({ question: 'Q', option1: 'A', option2: 'B', duration: '1m' }));
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
  assert.match(JSON.stringify(json(same.reply.embeds[0])), /must be different/);
  const bad = w.command({ question: 'Q', option1: 'A', option2: 'B', duration: 'soon' });
  await vote.execute(bad);
  assert.match(JSON.stringify(json(bad.reply.embeds[0])), /Invalid duration|duration/i);
  assert.equal(w.sent.length, 0);
});

test('every vote counts as 1%: 50 votes fill half the bar', () => {
  const vote = { question: 'Q', options: ['A', 'B'], votes: Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`u${n}`, 0])) };
  const text = buildVoteMessage(vote).embeds[0].description;
  assert.match(text, /1️⃣ \*\*A\*\*\n▰{3}▱{3} \*\*50%\*\* · 50 votes/);
});

test('an option with a picture gets a button that shows it privately for 30 seconds; no thread, no link', async t => {
  const w = world();
  const deps = {
    fetchImpl: async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer }),
    storeMedia: async buffer => `https://cloudy.example/cloudy-embed-media/${Buffer.from(buffer).toString('hex').slice(-12)}.png`,
  };
  const west = { url: 'https://cdn.discordapp.com/a/west.png', name: 'west.png', contentType: 'image/png', size: 2000 };
  const south = { url: 'https://cdn.discordapp.com/a/south.png', name: 'south.png', contentType: 'image/png', size: 2000 };
  const run = w.command({ question: 'Choose your map', option1: 'DZ West', option2: 'DZ East', option3: 'DZ South', duration: '1h' });
  run.options.getAttachment = name => ({ media1: west, media3: south }[name] || null);
  await vote.execute(run, deps);
  const posted = w.sent[0];
  assert.equal(posted.thread, undefined, 'no thread');
  const text = posted.embeds[0].description;
  assert.doesNotMatch(text, /\]\(/, 'options stay plain white text');
  assert.match(text, /\*\*Total votes:\*\* 0\n\n\*\*Ends:\*\*/, 'empty line before the end');
  assert.equal(posted.embeds[0].title, 'Vote');
  const rows = posted.components.map(row => json(row).components);
  assert.deepEqual(rows[1].map(button => [button.custom_id, button.label]), [['vote_media:0', 'DZ West'], ['vote_media:2', 'DZ South']]);
  const stored = await loadVote(w.client, GUILD, posted.id);
  assert.notEqual(stored.optionImages[0], stored.optionImages[2], 'each option keeps its own picture');
  assert.equal(stored.optionImages[1], null);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const click = { id: 'click-1', guildId: GUILD, message: { id: posted.id },
    deferReply: async () => {}, editReply: async payload => { click.reply = payload; return { id: 'view' }; },
    deleteReply: async () => { click.deleted = true; } };
  await voteMedia.execute(click, w.client, ['2']);
  assert.equal(click.reply.embeds[0].image.url, stored.optionImages[2]);
  assert.equal(click.reply.embeds[0].title, undefined);
  assert.equal(click.reply.embeds[0].thumbnail, undefined);
  t.mock.timers.tick(29_000);
  assert.equal(click.deleted, undefined);
  t.mock.timers.tick(1_000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(click.deleted, true, 'gone after 30 seconds');
  t.mock.timers.reset();

  const lonely = w.command({ question: 'Q', option1: 'A', option2: 'B' });
  lonely.options.getAttachment = name => (name === 'media3' ? west : null);
  await vote.execute(lonely, deps);
  assert.match(JSON.stringify(json(lonely.reply.embeds[0])), /Media 3 has no option 3/);
  const video = w.command({ question: 'Q', option1: 'A', option2: 'B' });
  video.options.getAttachment = name => (name === 'media1' ? { ...west, contentType: 'video/mp4' } : null);
  await vote.execute(video, deps);
  assert.match(JSON.stringify(json(video.reply.embeds[0])), /must be a picture/);
});
