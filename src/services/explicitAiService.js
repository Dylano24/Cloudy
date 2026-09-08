import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { AiError, authorizeAiRequest, createAiGate, parseAiRequest, redactAiText } from './aiSafety.js';
import { answerExplicitAi, getAiProvider } from './explicitAiProvider.js';
import { logger } from '../utils/logger.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const gate = createAiGate();
export const AI_HELP = [
  'Ask a question directly: no server or file context is read.',
  '`scan CHANNEL_ID 20 | question` — admins/owners, only that channel (1–50 messages).',
  '`analyze src/path.js | question` — configured bot owners only, one local source file.',
  '`prepare src/path.js | requested change` — configured bot owners only, an unapplied proposal.',
  'Proposals are not executed. Review and test them in GitHub before applying. No live web access.',
  'The configured AI processes your question and explicitly selected context. Do not submit secrets.',
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
  const messages = await channel.messages.fetch({ limit: request.limit, cache: false });
  const rows = [...messages.values()].slice(0, request.limit).reverse().map(message => ({
    id: message.id,
    // Do not follow URLs, replies, attachments, mentions, or instructions in messages.
    text: redactAiText([message.content || '', ...(message.embeds || []).map(embed =>
      [embed.title, embed.description, ...(embed.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n'))].join('\n')).slice(0, 1500),
  }));
  let text = JSON.stringify({ channelId: channel.id, messages: rows });
  while (Buffer.byteLength(text) > 12_000 && rows.length) { rows.shift(); text = JSON.stringify({ channelId: channel.id, messages: rows }); }
  return { text, count: rows.length };
}

export function createExplicitAiService({ answer = answerExplicitAi, reserve = gate, source = readAiSource, scan = readAiChannel, provider = getAiProvider, audit = entry => logger.warn(`[CLOUDY_AI] ${JSON.stringify(entry)}`) } = {}) {
  return async (actor, input) => {
    let release;
    let action = 'invalid';
    const identity = { guildId: actor?.guild?.id, userId: actor?.user?.id || actor?.author?.id };
    try {
      const request = parseAiRequest(input);
      action = request.action;
      // Validate deployment settings before any sensitive read.
      const member = await authorizeAiRequest(actor, request);
      if (action === 'help') return { text: AI_HELP, diagnostics: {} };
      const config = provider();
      release = reserve(`${identity.guildId}:${identity.userId}`);
      let evidence = '';
      let sourceInfo;
      const diagnostics = { readableChannelsScanned: 0, evidenceItems: 0, githubFilesRead: 0, runtimeLogLines: 0 };
      if (action === 'scan') {
        const result = await scan(actor, request, member);
        evidence = result.text;
        diagnostics.readableChannelsScanned = 1; diagnostics.evidenceItems = result.count;
      } else if (action === 'analyze' || action === 'prepare') {
        sourceInfo = await source(request.path);
        evidence = JSON.stringify(sourceInfo);
        diagnostics.githubFilesRead = 1; // Existing footer; source is the deployed checkout, not remote HEAD.
      }
      const result = await answer({ question: request.question, evidence, action, config });
      // Explicit label is application-owned, never dependent on the model obeying instructions.
      const label = sourceInfo ? `Local source: ${sourceInfo.path}\nSHA-256: ${sourceInfo.sha256}\n${action === 'prepare' ? 'UNAPPLIED PROPOSAL — review and test before applying.\n' : ''}\n` : '';
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
