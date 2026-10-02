import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { AiError, aiIdentityAnswer, authorizeAiRequest, createAiGate, parseAiRequest, redactAiText } from './aiSafety.js';
import { answerExplicitAi, getAiProvider } from './explicitAiProvider.js';
import { logger } from '../utils/logger.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const gate = createAiGate();
export const AI_HELP = [
  'Ask a question directly. In the Owner Fix Guide, Cloudy can use relevant readable server history automatically. Other entry points do not add server context automatically.',
  '`scan CHANNEL_ID 20 | question`: admins or owners, only that channel (1 to 50 messages).',
  '`history CHANNEL_ID 500 | question`: admins or owners, searches up to 500 recent messages and sends only relevant bounded evidence.',
  '`code | question`: configured bot owners only, searches the current local bot source for relevant snippets.',
  '`analyze src/path.js | question`: configured bot owners only, one local source file.',
  '`prepare src/path.js | requested change` or `fix ...`: configured bot owners only, an unapplied proposal.',
  'Proposals are not executed. Review and test them in GitHub before applying. No live web access.',
  'The configured AI processes your question and permitted context. Do not submit secrets.',
].join('\n');

export async function readAiSource(relative, root = ROOT) {
  if (!/^(?:src\/[\w/-]+\.js|(?:package\.json|README\.md))$/.test(relative)
    || /(?:secret|credential|token|password)/i.test(relative)) throw new AiError('file_not_allowed');
  const base = await fs.realpath(root);
  // Reject every symlink component, directories, oversized files and path escapes.
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw new AiError('file_not_allowed');
  }
  const resolved = await fs.realpath(current);
  if (!resolved.startsWith(base + path.sep)) throw new AiError('file_not_allowed');
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 12_000) throw new AiError('file_too_large');
    const buffer = Buffer.alloc(12_001);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 12_000) throw new AiError('file_too_large');
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    return { path: relative, sha256: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'), content: redactAiText(content) };
  } finally { await handle.close(); }
}

export async function readAiChannel(actor, request, member) {
  const channel = await actor.guild.channels.fetch(request.channelId).catch(() => null);
  if (!channel || channel.guildId !== actor.guild.id || !channel.isTextBased?.() || channel.isThread?.() || !channel.messages?.fetch) throw new AiError('channel_not_allowed');
  const me = await actor.guild.members.fetchMe({ force: true }).catch(() => null);
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  if (!me || !channel.permissionsFor(member)?.has(required) || !channel.permissionsFor(me)?.has(required)) throw new AiError('forbidden');
  const collected = [];
  let before;
  while (collected.length < request.limit) {
    const limit = Math.min(100, request.limit - collected.length);
    const batch = await channel.messages.fetch({ limit, cache: false, ...(before ? { before } : {}) });
    if (!batch?.size) break;
    const values = [...batch.values()];
    collected.push(...values);
    before = values.at(-1)?.id;
    if (batch.size < limit || !before) break;
  }
  const tokens = String(request.question || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length > 2);
  const rows = collected.map(message => ({
    id: message.id,
    // Do not follow URLs, replies, attachments, mentions, or instructions in messages.
    text: redactAiText([message.content || '', ...(message.embeds || []).map(embed =>
      [embed.title, embed.description, ...(embed.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n'))].join('\n')).slice(0, 1500),
  })).map(row => ({ ...row, score: tokens.reduce((score, token) => score + (row.text.toLowerCase().includes(token) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score).map(({ score: _score, ...row }) => row).slice(0, 50).reverse();
  let text = JSON.stringify({ channelId: channel.id, messages: rows });
  while (Buffer.byteLength(text) > 12_000 && rows.length) { rows.shift(); text = JSON.stringify({ channelId: channel.id, messages: rows }); }
  return { text, count: rows.length };
}

export async function readAiGuildContext(actor, request, member) {
  const me = await actor.guild.members.fetchMe({ force: true }).catch(() => null);
  if (!me) throw new AiError('forbidden');

  const fetchedChannels = await actor.guild.channels.fetch().catch(() => actor.guild.channels.cache);
  const channels = [...(fetchedChannels?.values?.() || [])].filter(channel =>
    channel
    && channel.guildId === actor.guild.id
    && channel.isTextBased?.()
    && !channel.isThread?.()
    && channel.messages?.fetch
  );

  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const tokens = String(request.question || '').toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(token => token.length > 2);
  const channelScore = channel => {
    const name = String(channel.name || '').toLowerCase();
    return tokens.reduce((score, token) => score + (name.includes(token) ? 2 : 0), 0);
  };

  channels.sort((left, right) =>
    channelScore(right) - channelScore(left)
    || (left.rawPosition ?? left.position ?? 0) - (right.rawPosition ?? right.position ?? 0)
  );

  const rows = [];
  let readableChannelsScanned = 0;
  let fetchedMessages = 0;
  const maxChannels = 50;
  const maxMessages = 3000;

  for (const channel of channels.slice(0, maxChannels)) {
    if (fetchedMessages >= maxMessages) break;
    if (!channel.permissionsFor(member)?.has(required) || !channel.permissionsFor(me)?.has(required)) continue;

    readableChannelsScanned += 1;
    const perChannelLimit = Math.min(channelScore(channel) > 0 ? 300 : 100, maxMessages - fetchedMessages);
    const collected = [];
    let before;

    while (collected.length < perChannelLimit) {
      const limit = Math.min(100, perChannelLimit - collected.length);
      const batch = await channel.messages.fetch({ limit, cache: false, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch?.size) break;
      const values = [...batch.values()];
      collected.push(...values);
      before = values.at(-1)?.id;
      if (batch.size < limit || !before) break;
    }

    fetchedMessages += collected.length;
    for (const message of collected) {
      const messageText = redactAiText([
        message.content || '',
        ...(message.embeds || []).map(embed =>
          [embed.title, embed.description, ...(embed.fields || []).map(field => `${field.name}: ${field.value}`)]
            .filter(Boolean)
            .join('\n')
        ),
      ].join('\n')).slice(0, 1500);
      if (!messageText.trim()) continue;

      const lower = messageText.toLowerCase();
      const score = channelScore(channel)
        + tokens.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0);
      rows.push({
        channelId: channel.id,
        channelName: String(channel.name || channel.id),
        id: message.id,
        createdTimestamp: Number(message.createdTimestamp || 0),
        text: messageText,
        score,
      });
    }
  }

  const hasRelevant = rows.some(row => row.score > 0);
  const selected = rows
    .filter(row => !hasRelevant || row.score > 0)
    .sort((left, right) => right.score - left.score || right.createdTimestamp - left.createdTimestamp)
    .slice(0, 60)
    .map(({ score: _score, createdTimestamp: _createdTimestamp, ...row }) => row)
    .reverse();

  let text = JSON.stringify({
    guildId: actor.guild.id,
    channelsScanned: readableChannelsScanned,
    messages: selected,
  });
  while (Buffer.byteLength(text) > 12_000 && selected.length) {
    selected.shift();
    text = JSON.stringify({
      guildId: actor.guild.id,
      channelsScanned: readableChannelsScanned,
      messages: selected,
    });
  }

  return {
    text,
    count: selected.length,
    channels: readableChannelsScanned,
  };
}

export async function searchAiSource(question, root = ROOT) {
  const tokens = String(question || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(token => token.length > 2);
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
  }
  await walk(path.join(root, 'src'));
  const matches = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    if (stat.size > 200_000) continue;
    const content = redactAiText(await fs.readFile(file, 'utf8'));
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
      if (score) matches.push({ score, path: path.relative(root, file).replace(/\\/g, '/'), line: index + 1, text: line.slice(0, 500) });
    });
  }
  const selected = matches.sort((a, b) => b.score - a.score).slice(0, 40);
  let result = JSON.stringify({ query: question, matches: selected });
  while (Buffer.byteLength(result) > 12_000 && selected.length) {
    selected.pop();
    result = JSON.stringify({ query: question, matches: selected });
  }
  return result;
}

export function createExplicitAiService({
  answer = answerExplicitAi,
  reserve = gate,
  source = readAiSource,
  sourceSearch = searchAiSource,
  scan = readAiChannel,
  guildScan = readAiGuildContext,
  provider = getAiProvider,
  audit = entry => logger.warn(`[CLOUDY_AI] ${JSON.stringify(entry)}`),
  defaultGuildContext = false,
  askEvidence = null,
} = {}) {
  return async (actor, input) => {
    let release;
    let action = 'invalid';
    const identity = { guildId: actor?.guild?.id, userId: actor?.user?.id || actor?.author?.id };
    try {
      const parsedRequest = parseAiRequest(input);
      const identityAnswer = parsedRequest.action === 'ask' ? aiIdentityAnswer(parsedRequest.question) : null;
      if (identityAnswer) return { text: identityAnswer, diagnostics: {} };
      const request = defaultGuildContext && parsedRequest.action === 'ask' && !actor?.author
        ? { ...parsedRequest, action: 'server' }
        : parsedRequest;
      action = request.action;
      // Validate deployment settings before any sensitive read.
      const member = await authorizeAiRequest(actor, request);
      if (action === 'help') return { text: AI_HELP, diagnostics: {} };
      const config = provider();
      release = reserve(`${identity.guildId}:${identity.userId}`);
      let evidence = '';
      let sourceInfo;
      const diagnostics = { readableChannelsScanned: 0, evidenceItems: 0, githubFilesRead: 0, runtimeLogLines: 0 };
      if (action === 'ask' && typeof askEvidence === 'function') {
        const result = await askEvidence(actor, request);
        evidence = result?.text || '';
        diagnostics.readableChannelsScanned = Number(result?.channels || 0);
        diagnostics.evidenceItems = Number(result?.count || 0);
      } else if (action === 'scan') {
        const result = await scan(actor, request, member);
        evidence = result.text;
        diagnostics.readableChannelsScanned = 1; diagnostics.evidenceItems = result.count;
      } else if (action === 'server') {
        const result = await guildScan(actor, request, member);
        evidence = result.text;
        diagnostics.readableChannelsScanned = result.channels;
        diagnostics.evidenceItems = result.count;
      } else if (action === 'analyze' || action === 'prepare') {
        sourceInfo = await source(request.path);
        evidence = JSON.stringify(sourceInfo);
        diagnostics.githubFilesRead = 1; // Existing footer; source is the deployed checkout, not remote HEAD.
      } else if (action === 'code') {
        evidence = await sourceSearch(request.question);
        diagnostics.githubFilesRead = JSON.parse(evidence).matches.length;
      }
      const result = await answer({ question: request.question, evidence, action, config });
      // Explicit label is application-owned, never dependent on the model obeying instructions.
      const label = sourceInfo ? `Local source: ${sourceInfo.path}\nSHA-256: ${sourceInfo.sha256}\n${action === 'prepare' ? 'UNAPPLIED PROPOSAL: review and test before applying.\n' : ''}\n` : '';
      audit({ ...identity, action, outcome: 'success', provider: config.provider, contextBytes: Buffer.byteLength(evidence) });
      return { text: label + result.text, diagnostics: { ...diagnostics, ...result.diagnostics } };
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError('unavailable');
      audit({ ...identity, action, outcome: safe.code });
      throw safe;
    } finally { release?.(); }
  };
}

export const runExplicitAi = createExplicitAiService();
export const runOwnerContextAi = createExplicitAiService({ defaultGuildContext: true });
