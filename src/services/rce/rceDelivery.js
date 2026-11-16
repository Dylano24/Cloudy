// Store deliveries in the KAOSBOT format, so a Tip4Serv (or any) store that
// already posts KAOS delivery lines works with Cloudy unchanged:
//
//   [KAOS][ADD][<@discord_id>][1]=[ITEM][rifle.ak][2]
//   [KAOS][ADD][<@discord_id>][1,2]=[KIT][elitekit][1]
//   [KAOS][ADD][<@discord_id>][ALL]=[POINTS][5000]
//   [KAOS][ADD|DEL][<@discord_id>][1]=[ZORPLIST]
//   [KAOS][ADD|DEL][<@discord_id>][1]=[KITLIST][elitekit, elitekit2]
//   [KAOS][ADD|DEL][<@discord_id>][1]=[RIDER]
//   [KAOS][ADD][<@discord_id>][1]=[CLAIMWIPE][elitekit]
//   [KAOS][ADD|DEL][<@discord_id>][1]=[VIP]          ([VIP][30] = 30 days)
//
// [CLOUDY] works the same as [KAOS]. Servers are numbered in the order of
// /rce server list (1 = the first), or named by their id. Lines are read in
// the delivery channel only, from bots, webhooks or Manage Server members.
// Every line is handled once (message id + line), and an in-game delivery is
// sent at most once: a command that may have reached the server without an
// answer becomes "needs review" instead of being sent again.
import { createHash } from 'node:crypto';
import { RconError } from '../rustConsole/rconClient.js';
import { rceCommand, safeItemName, safeKitName } from './rceCommands.js';
import { discordForPlayer, getDeliveries, getLinks, linkForDiscord, mutateDeliveries, mutateLists, playerKey } from './rceData.js';
import { getRceConfig } from './rceStore.js';
import { code, plain, rceEmbed, RCE_COLORS } from './rceEmbeds.js';

// Arguments stay on the same line and stop before the next [KAOS]/[CLOUDY] line.
const LINE = /\[(KAOS|CLOUDY)\][ \t]*\[(ADD|DEL)\][ \t]*\[<@!?(\d{17,20})>\][ \t]*\[([^\]\n]+)\][ \t]*=[ \t]*\[([A-Za-z_]+)\]((?:[ \t]*\[(?!(?:KAOS|CLOUDY)\])[^\]\n]*\])*)/gi;
const ARG = /\[([^\]]*)\]/g;
const MAX_WAIT_MS = 14 * 86_400_000;
const MAX_UNITS = 50;
export const DELIVERY_TYPES = Object.freeze(['ITEM', 'KIT', 'POINTS', 'ZORPLIST', 'KITLIST', 'RIDER', 'CLAIMWIPE', 'VIP']);

/** All delivery lines in a text, parsed (invalid ones carry `error`). */
export function parseDeliveryLines(text) {
  const result = [];
  let m;
  LINE.lastIndex = 0;
  while ((m = LINE.exec(String(text || '')))) {
    const args = [];
    let a;
    ARG.lastIndex = 0;
    while ((a = ARG.exec(m[6] || ''))) args.push(a[1].trim());
    const type = m[5].toUpperCase();
    const entry = { raw: m[0], prefix: m[1].toUpperCase(), action: m[2].toUpperCase(), discordId: m[3], servers: m[4].trim(), type, args };
    if (!DELIVERY_TYPES.includes(type)) entry.error = `unknown type ${type}`;
    result.push(entry);
  }
  return result;
}

/** Server ids for "1", "1,2,3", "ALL" or server ids, in the order of the settings. */
export function resolveServers(config, spec) {
  const text = String(spec || '').trim();
  if (/^all$/i.test(text)) return config.servers.map(server => server.id);
  const ids = [];
  for (const part of text.split(',').map(value => value.trim()).filter(Boolean)) {
    const index = /^\d+$/.test(part) ? Number(part) - 1 : -1;
    const server = index >= 0 ? config.servers[index] : config.servers.find(entry => entry.id === part.toLowerCase());
    if (server && !ids.includes(server.id)) ids.push(server.id);
  }
  return ids;
}

const listArg = value => String(value || '').split(',').map(part => part.trim()).filter(Boolean);
const quantity = value => {
  const number = Number(value ?? 1);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, MAX_UNITS) : null;
};

export function createDeliveries(runtime) {
  const { client, now, log } = runtime;
  let running = false;

  async function queue(guildId, entries) {
    if (!entries.length) return;
    await mutateDeliveries(client, guildId, state => {
      const known = new Set(state.pending.map(entry => entry.id));
      for (const entry of entries) if (!known.has(entry.id)) state.pending.push(entry);
    });
  }

  /** Handles one Discord message in the delivery channel. */
  async function handleMessage(message) {
    const guildId = message.guildId;
    if (!guildId || !message.channelId) return null;
    const config = await getRceConfig(client, guildId);
    if (!config.delivery.channelId || config.delivery.channelId !== message.channelId) return null;
    const text = [message.content || '', ...(message.embeds || []).map(embed => `${embed.title || ''}\n${embed.description || ''}`)].join('\n');
    if (!/\[(KAOS|CLOUDY)\]/i.test(text)) return null;
    const trusted = message.author?.bot || message.webhookId
      || message.member?.permissions?.has?.('ManageGuild') || message.member?.permissions?.has?.('Administrator');
    if (!trusted || message.author?.id === client.user?.id) return null;

    const lines = parseDeliveryLines(text);
    if (!lines.length) return null;
    const fresh = await mutateDeliveries(client, guildId, state => {
      if (state.processed.includes(message.id)) return false;
      state.processed.push(message.id);
      return true;
    });
    if (!fresh) return { duplicate: true };

    const results = [];
    for (const [index, line] of lines.entries()) {
      try {
        if (line.error) throw new Error(line.error);
        results.push(await apply(guildId, config, line, `${message.id}:${index}`));
      } catch (error) {
        results.push({ ok: false, line, note: error?.message || 'failed' });
      }
    }
    const ok = results.every(result => result.ok);
    await message.react?.(ok ? '✅' : '⚠️').catch(() => undefined);
    await runtime.post(guildId, 'shop', rceEmbed(ok ? 'Store delivery received' : 'Store delivery with problems', results.map(result =>
      `${result.ok ? '•' : '✗'} <@${result.line.discordId}> ${result.line.action} ${result.line.type}${result.line.args.length ? ` ${plain(result.line.args.join(' '), 80)}` : ''}: ${plain(result.note || 'done', 120)}`),
    { color: ok ? RCE_COLORS.green : RCE_COLORS.red, time: now() }));
    await processDue(guildId).catch(() => undefined);
    return { results };
  }

  async function apply(guildId, config, line, baseId) {
    const servers = resolveServers(config, line.servers);
    const needsServer = ['ITEM', 'KIT', 'VIP'].includes(line.type);
    if (needsServer && !servers.length) throw new Error(`unknown server ${line.servers}`);
    const add = line.action === 'ADD';
    const id = suffix => createHash('sha256').update(`${baseId}:${suffix}`).digest('hex').slice(0, 24);
    const delivery = (serverId, kind, value, amount, unit) => ({
      id: id(`${serverId}:${unit}`), discordId: line.discordId, serverId, kind, value, amount,
      status: 'pending', attempts: 0, createdAt: now(), source: line.prefix,
    });

    switch (line.type) {
      case 'ITEM': {
        if (!add) return { ok: true, line, note: 'items cannot be taken back automatically' };
        const item = safeItemName(line.args[0]);
        const amount = quantity(line.args[1]);
        if (!amount) throw new Error('invalid quantity');
        await queue(guildId, servers.map(serverId => delivery(serverId, 'item', item, amount, 0)));
        return { ok: true, line, note: `queued for ${servers.length} server(s)` };
      }
      case 'KIT': {
        if (!add) return { ok: true, line, note: 'kits cannot be taken back automatically' };
        const kit = safeKitName(line.args[0]);
        const units = quantity(line.args[1]);
        if (!units) throw new Error('invalid quantity');
        const entries = [];
        for (const serverId of servers) for (let unit = 0; unit < units; unit++) entries.push(delivery(serverId, 'kit', kit, 1, unit));
        await queue(guildId, entries);
        return { ok: true, line, note: `${units} kit(s) queued for ${servers.length} server(s)` };
      }
      case 'POINTS': {
        const amount = Number(line.args[0]);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('invalid amount');
        if (add) await runtime.economy.addMoney(client, guildId, line.discordId, amount, 'rce:store-points');
        else await runtime.economy.removeMoney(client, guildId, line.discordId, amount, 'rce:store-points').catch(() => undefined);
        return { ok: true, line, note: `${add ? '+' : '-'}${amount.toLocaleString('en-US')} points` };
      }
      case 'ZORPLIST':
      case 'RIDER': {
        const listName = line.type === 'ZORPLIST' ? 'zorp' : 'rider';
        await mutateLists(client, guildId, lists => {
          const set = new Set(lists[listName]);
          if (add) set.add(line.discordId); else set.delete(line.discordId);
          lists[listName] = [...set];
        });
        return { ok: true, line, note: add ? 'added to the list' : 'removed from the list' };
      }
      case 'KITLIST': {
        const kits = listArg(line.args[0]);
        if (!kits.length) throw new Error('no kit name');
        const names = kits.some(kit => /^all$/i.test(kit)) ? [...new Set(config.emotes.filter(entry => entry.kitList).map(entry => entry.value))] : kits.map(safeKitName);
        await mutateLists(client, guildId, lists => {
          for (const kit of names) {
            const set = new Set(lists.kitLists[kit] || []);
            if (add) set.add(line.discordId); else set.delete(line.discordId);
            lists.kitLists[kit] = [...set];
          }
        });
        return { ok: true, line, note: `${add ? 'added to' : 'removed from'} ${names.length} kit list(s)` };
      }
      case 'CLAIMWIPE': {
        const kits = listArg(line.args[0]);
        const all = !kits.length || kits.some(kit => /^all$/i.test(kit));
        const bindings = config.emotes.filter(entry => all || kits.some(kit => kit.toLowerCase() === String(entry.value).toLowerCase()));
        const links = await getLinks(client, guildId);
        const gamertag = linkForDiscord(links, line.discordId)?.gamertag;
        await mutateLists(client, guildId, lists => {
          for (const binding of bindings) {
            const claims = lists.claims[binding.id];
            if (!claims) continue;
            delete claims[line.discordId];
            if (gamertag) delete claims[playerKey(gamertag)];
          }
        });
        return { ok: true, line, note: `kit claims reset (${bindings.length})` };
      }
      case 'VIP': {
        const days = line.args[0] ? Number(line.args[0]) : 0;
        if (add && (!Number.isInteger(days) || days < 0 || days > 3650)) throw new Error('invalid number of days');
        await mutateLists(client, guildId, lists => {
          if (!add) { delete lists.vip[line.discordId]; return; }
          const current = lists.vip[line.discordId];
          const base = Math.max(now(), Number(current?.until) || 0);
          lists.vip[line.discordId] = { gamertag: current?.gamertag || null, until: days ? base + days * 86_400_000 : null, servers: [...new Set([...(current?.servers || []), ...servers])] };
        });
        await queue(guildId, servers.map(serverId => delivery(serverId, add ? 'vip' : 'unvip', null, 1, 0)));
        return { ok: true, line, note: `${add ? 'VIP' : 'VIP removal'} queued for ${servers.length} server(s)` };
      }
      default:
        throw new Error(`unknown type ${line.type}`);
    }
  }

  function commandFor(entry, gamertag) {
    if (entry.kind === 'item') return rceCommand.giveItem(gamertag, entry.value, entry.amount);
    if (entry.kind === 'kit') return rceCommand.kit(entry.value, gamertag);
    if (entry.kind === 'vip') return rceCommand.addVip(gamertag);
    return rceCommand.removeVip(gamertag);
  }

  async function finish(guildId, id, change) {
    await mutateDeliveries(client, guildId, state => {
      const index = state.pending.findIndex(entry => entry.id === id);
      if (index < 0) return;
      const entry = { ...state.pending[index], ...change, updatedAt: now() };
      if (['delivered', 'failed', 'needs_review'].includes(entry.status)) {
        state.pending.splice(index, 1);
        state.done.push(entry);
      } else {
        state.pending[index] = entry;
      }
    });
  }

  async function deliverOne(guildId, entry, links) {
    const link = linkForDiscord(links, entry.discordId);
    if (now() - entry.createdAt > MAX_WAIT_MS) {
      await finish(guildId, entry.id, { status: 'failed', lastError: link ? 'player was not online within 14 days' : 'member never linked a gamertag' });
      return 'failed';
    }
    if (!link) return 'waiting';
    const session = runtime.session(guildId, entry.serverId);
    if (!session?.online) return 'waiting';
    if ((entry.kind === 'item' || entry.kind === 'kit') && !session.isOnline(link.gamertag)) return 'waiting';
    let command;
    try { command = commandFor(entry, link.gamertag); } catch (error) {
      await finish(guildId, entry.id, { status: 'failed', lastError: error?.message || 'invalid' });
      return 'failed';
    }
    // Saved before sending: a restart in between becomes "needs review".
    await finish(guildId, entry.id, { status: 'delivering', attempts: (entry.attempts || 0) + 1, gamertag: link.gamertag });
    try {
      const reply = await session.send(command);
      await finish(guildId, entry.id, { status: 'delivered', deliveredAt: now(), lastReply: String(reply || '').slice(0, 160) });
      if (entry.kind === 'vip' || entry.kind === 'unvip') {
        await mutateLists(client, guildId, lists => { if (lists.vip[entry.discordId]) lists.vip[entry.discordId].gamertag = link.gamertag; });
      }
      await runtime.post(guildId, 'shop', rceEmbed('Store item delivered', [
        `**Member:** <@${entry.discordId}>`, `**Gamertag:** ${code(link.gamertag)}`,
        `**Delivery:** ${entry.kind === 'item' ? `${entry.amount} x ${plain(entry.value, 60)}` : entry.kind === 'kit' ? `Kit ${plain(entry.value, 40)}` : entry.kind === 'vip' ? 'VIP' : 'VIP removed'}`,
        `**Server:** ${plain(session.name, 60)}`,
      ], { color: RCE_COLORS.green, time: now() }));
      return 'delivered';
    } catch (error) {
      const unsure = !(error instanceof RconError) || ['timeout', 'closed'].includes(error.code);
      await finish(guildId, entry.id, unsure
        ? { status: 'needs_review', lastError: 'no answer from the server after sending: check in game' }
        : { status: 'pending', lastError: error.code });
      if (unsure) log.warn(`[RCE] Delivery ${entry.id} needs review (guild ${guildId})`);
      return unsure ? 'needs_review' : 'waiting';
    }
  }

  async function processGuild(guildId, filter = null) {
    const state = await getDeliveries(client, guildId);
    if (!state.pending.length) return 0;
    const links = await getLinks(client, guildId);
    let delivered = 0;
    for (const entry of state.pending) {
      if (entry.status === 'delivering') continue;
      if (filter && !filter(entry, links)) continue;
      if (await deliverOne(guildId, entry, links) === 'delivered') delivered += 1;
    }
    return delivered;
  }

  async function processDue(guildId = null) {
    if (running && !guildId) return 0;
    if (!guildId) running = true;
    try {
      const guilds = guildId ? [guildId] : [...new Set([...runtime.sessions.values()].map(session => session.guildId))];
      let total = 0;
      for (const id of guilds) total += await processGuild(id).catch(error => { log.warn('[RCE] Deliveries failed:', error?.message); return 0; });
      return total;
    } finally {
      if (!guildId) running = false;
    }
  }

  async function onPlayerOnline(session, player) {
    return processGuild(session.guildId, (entry, links) => entry.serverId === session.id && discordForPlayer(links, player) === entry.discordId);
  }

  async function onLinked(guildId, discordId) {
    return processGuild(guildId, entry => entry.discordId === discordId);
  }

  /** At start: a delivery interrupted while sending is never sent again. */
  async function recoverInterrupted(guildId) {
    await mutateDeliveries(client, guildId, state => {
      for (const entry of state.pending) if (entry.status === 'delivering') entry.status = 'needs_review';
      const review = state.pending.filter(entry => entry.status === 'needs_review');
      state.pending = state.pending.filter(entry => entry.status !== 'needs_review');
      state.done.push(...review);
    });
  }

  async function staffAction(guildId, id, action) {
    return mutateDeliveries(client, guildId, state => {
      const index = state.done.findIndex(entry => entry.id === id);
      if (index < 0) throw new Error('Delivery not found.');
      const entry = state.done[index];
      if (action === 'retry') {
        if (!['failed', 'needs_review'].includes(entry.status)) throw new Error('Only failed or reviewed deliveries can be retried.');
        state.done.splice(index, 1);
        state.pending.push({ ...entry, status: 'pending', attempts: 0, createdAt: now(), lastError: null });
        return 'queued again';
      }
      if (action === 'done') {
        if (entry.status !== 'needs_review') throw new Error('Only reviewed deliveries can be marked delivered.');
        state.done[index] = { ...entry, status: 'delivered', deliveredAt: now(), confirmedByStaff: true };
        return 'marked delivered';
      }
      throw new Error('Unknown action.');
    });
  }

  return { handleMessage, processDue, onPlayerOnline, onLinked, recoverInterrupted, staffAction, apply };
}
