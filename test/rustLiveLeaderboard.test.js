import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ChannelType } from 'discord.js';
import {
  buildRustLiveBoard, getLiveRankings, getRustLiveBoardConfig,
  leaderboardLines, liveRustStatus,
  startRustLiveBoard, stopRustLiveBoard, refreshRustLiveBoardMirrors,
  resetRustLiveBoardTimers,
} from '../src/services/rustLiveLeaderboardService.js';

afterEach(() => resetRustLiveBoardTimers());

function fixture() {
  const db = new Map();
  const targetGuildId = '1565734585508303029';
  const sourceGuildId = '1532882647838228723';
  const channelId = '1569331885098799107';
  const sent = [];
  const edited = [];
  let id = 0;
  const channel = {
    id: channelId,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      const msg = {
        id: String(++id),
        author: { id: '1534506224312389863' },
        url: 'https://discord.com/channels/' + targetGuildId + '/' + channelId + '/' + id,
        edit: async newPayload => { edited.push(newPayload); },
      };
      sent.push(payload);
      channel.messages.fetch = async i => i === msg.id ? msg : null;
      return msg;
    },
    messages: { fetch: async () => null },
  };
  const guild = { id: targetGuildId, channels: { fetch: async i => i === channelId ? channel : null } };
  const source = { id: sourceGuildId };
  const client = {
    user: { id: '1534506224312389863' },
    guilds: { cache: new Map([[guild.id, guild], [source.id, source]]) },
    db: {
      get: async key => db.get(key) || null,
      set: async (key, value) => { db.set(key, structuredClone(value)); return true; },
    },
  };
  return { client, guild, channel, sent, edited, db, sourceGuildId };
}

test('Sorts real players and sanitizes their names', () => {
  const state = { leaderboard: { Rust: { players: {
    'A<@everyone>': { kills: 5, deaths: 1 },
    B: { kills: 17, deaths: 0 },
    C: { kills: 9, deaths: 9 },
  } } } };
  const ranking = getLiveRankings(state, 'Rust')[0];
  assert.equal(ranking.players[0].name, 'B');
  assert.equal(ranking.players[0].kd, 17);
  assert.equal(ranking.players[2].kills, 5);
  assert.doesNotMatch(ranking.players[2].name, /[<>@]/);
});

test('Uses live status only when fresh and never invents players or kills', () => {
  const now = Date.parse('2026-11-09T13:00:00Z');
  const empty = buildRustLiveBoard({}, null, now);
  assert.match(empty.description, /No recorded kills yet/);
  assert.match(empty.description, /⚪ \*\*Not connected\*\*/);
  assert.match(empty.thumbnail.url, /cloudy-c-logo/);
  assert.match(empty.footer.text, /Cloudy Inc/);

  const state = {
    leaderboard: { Rust: { since: now - 60_000, players: { Alpha: { kills: 7, deaths: 2 } } } },
    servers: { Rust: { online: true, players: 14, max: 50, map: 'Custom map', updatedAt: now - 10_000 } },
    daily: { Rust: { date: '2026-11-09', kills: { Alpha: 4 } } },
  };
  const live = buildRustLiveBoard(state, 'Rust', now);
  assert.match(live.description, /🟢 \*\*Live\*\*/);
  assert.match(live.fields[0].value, /14\/50/);
  assert.match(live.description, /3.50 K\/D/);
  assert.match(live.fields[2].value, /Alpha.*4 kills/);
  assert.match(buildRustLiveBoard(state, 'Rust', now + 600_000).description, /🟠 \*\*Delayed\*\*/);
  assert.match(buildRustLiveBoard(state, 'Rust', now + 86_400_000).fields[2].value, /No recorded kills today/);
});

test('Top three receive medals, rank four onward stays compact', () => {
  const players = Array.from({ length: 10 }, (_, i) => ({
    name: i === 0 ? 'Serseny' : i === 1 ? 'Mindzset' : 'Player' + (i + 1),
    kills: 100 - i, deaths: 10, kd: (100 - i) / 10,
  }));
  const lines = leaderboardLines(players);
  assert.match(lines, /🥇 \*\*Serseny\*\*/);
  assert.match(lines, /🥈 \*\*Mindzset\*\*/);
  assert.match(lines, /🥉 \*\*Player3\*\*/);
  assert.match(lines, /\*\*4\.\*\* \*\*Player4\*\*/);
  assert.doesNotMatch(lines, /Rank 01|Rank 06/);
});

test('Live status never claims live without a recent online event', () => {
  const now = Date.parse('2026-11-09T13:00:00Z');
  assert.equal(liveRustStatus(null, now).label, 'Not connected');
  assert.equal(liveRustStatus({ online: true, updatedAt: now - 1_000 }, now).label, 'Live');
  assert.equal(liveRustStatus({ online: false, updatedAt: now - 1_000 }, now).label, 'Offline');
  assert.equal(liveRustStatus({ online: true, updatedAt: now - 600_000 }, now).label, 'Delayed');
});

test('Posts once, edits existing Cloudy-owned message, and pauses', async () => {
  const { client, guild, channel, sent, edited, sourceGuildId, db } = fixture();
  db.set('guild:' + sourceGuildId + ':gameserver:boards:v1', {
    leaderboard: { Rust: { players: { Alpha: { kills: 4, deaths: 2 } } } },
  });
  const first = await startRustLiveBoard(client, guild, channel, sourceGuildId, 'Rust');
  assert.equal(sent.length, 1);
  assert.equal(first.config.messageId, '1');
  assert.match(sent[0].embeds[0].description, /Alpha/);
  await startRustLiveBoard(client, guild, channel, sourceGuildId, 'Rust');
  assert.equal(sent.length, 1);
  assert.equal(edited.length, 0);
  db.set('guild:' + sourceGuildId + ':gameserver:boards:v1', {
    leaderboard: { Rust: { players: { Alpha: { kills: 5, deaths: 2 } } } },
  });
  await startRustLiveBoard(client, guild, channel, sourceGuildId, 'Rust');
  assert.equal(edited.length, 1);
  assert.equal((await getRustLiveBoardConfig(client, guild.id)).enabled, true);
  await stopRustLiveBoard(client, guild.id);
  assert.equal((await getRustLiveBoardConfig(client, guild.id)).enabled, false);
  await refreshRustLiveBoardMirrors(client, sourceGuildId);
  assert.equal(edited.length, 1);
});

test('Requires post permissions; cannot silently create a live board', async () => {
  const { client, guild, channel, sourceGuildId } = fixture();
  channel.permissionsFor = () => ({ has: () => false });
  await assert.rejects(startRustLiveBoard(client, guild, channel, sourceGuildId), /cannot post/);
});
