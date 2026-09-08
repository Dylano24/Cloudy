import { PermissionFlagsBits } from 'discord.js';

export class AiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function aiErrorMessage(error) {
  const messages = {
    invalid_request: 'Use help, ask QUESTION, scan CHANNEL_ID 20 | QUESTION, analyze src/path.js | QUESTION, or prepare src/path.js | CHANGE. Applying code is not supported inside Discord.',
    forbidden: 'This action requires administrator rights (channel scans) or an OWNER_IDS bot owner (source files), plus access to the selected channel.',
    private_form_required: 'Use the private Fix Guide Ask form for scans and source analysis.',
    configuration: 'AI is not configured. Ask the bot owner to configure local Ollama or explicitly enable Groq in CLOUDY_AI_PROVIDER.',
    disabled: 'AI is disabled by the bot owner.',
    rate_limit: 'AI is at capacity. Wait at least one minute and try again.',
    file_not_allowed: 'Choose one src/*.js file, package.json or README.md. Secret files and links are not allowed.',
    file_too_large: 'The selected file exceeds the 12 KB analysis limit. Choose a smaller source file.',
    channel_not_allowed: 'Choose a text channel in this server. Threads and inaccessible channels are not supported.',
    timeout: 'The AI request timed out. Try again later.',
  };
  return messages[error?.code || error?.message] || 'AI is temporarily unavailable. No server settings or code were changed.';
}

export function redactAiText(value) {
  let text = String(value || '');
  // Defense in depth, not a guarantee that arbitrary documents contain no secrets.
  for (const [name, secret] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|POSTGRES_URL/i.test(name) && secret?.length >= 8) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:sk-[\w-]{16,}|gsk_[\w-]{16,}|gh[pousr]_[\w-]{16,}|github_pat_[\w-]{16,}|AIza[\w-]{25,})\b/g, '[REDACTED]')
    .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{24,}\.[\w-]{6,}\.[\w-]{20,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_ -]?key)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi, '[REDACTED]');
}

export function aiOwner(actor) {
  const id = actor?.user?.id || actor?.author?.id;
  return Boolean(id && (process.env.OWNER_IDS || '').split(',').map(x => x.trim()).includes(id));
}

export function parseAiRequest(input) {
  const text = String(input || '').trim();
  if (!text || text.length > 4000) throw new AiError('invalid_request');
  if (text === 'help') return { action: 'help' };
  const scan = /^scan\s+(\d{17,20})\s+(\d{1,2})\s*\|\s*([\s\S]+)$/.exec(text);
  if (scan) {
    const limit = Number(scan[2]);
    if (limit < 1 || limit > 50) throw new AiError('invalid_request');
    return { action: 'scan', channelId: scan[1], limit, question: scan[3] };
  }
  const file = /^(analyze|prepare)\s+(\S+)\s*\|\s*([\s\S]+)$/.exec(text);
  if (file) return { action: file[1], path: file[2], question: file[3] };
  if (/^(scan|analyze|prepare|apply|execute)\b/i.test(text)) throw new AiError('invalid_request');
  return { action: 'ask', question: text.replace(/^ask\s+/, '') };
}

export async function authorizeAiRequest(actor, request) {
  if (!actor?.guild || actor.user?.bot || actor.author?.bot || actor.webhookId) throw new AiError('forbidden');
  if (request.action === 'ask' || request.action === 'help') return null;
  if (actor.author) throw new AiError('private_form_required');
  // Force a fresh membership lookup; role names and model output never grant rights.
  const id = actor.user?.id || actor.author?.id;
  const member = await actor.guild.members.fetch({ user: id, force: true }).catch(() => null);
  if (!member) throw new AiError('forbidden');
  if (request.action === 'scan') {
    if (!aiOwner(actor) && !member.permissions.has(PermissionFlagsBits.Administrator)) throw new AiError('forbidden');
  } else if (!aiOwner(actor)) throw new AiError('forbidden');
  return member;
}

export function createAiGate(now = Date.now) {
  const users = new Map();
  let active = 0;
  let window = 0;
  let count = 0;
  return (key) => {
    const time = now();
    for (const [id, expires] of users) if (expires <= time) users.delete(id);
    if (time >= window) { window = time + 60_000; count = 0; }
    if (users.has(key) || active >= 2 || count >= 10 || users.size >= 1000) throw new AiError('rate_limit');
    users.set(key, time + 20_000); count++; active++;
    let released = false;
    return () => { if (!released) { released = true; active--; } };
  };
}
