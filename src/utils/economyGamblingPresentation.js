// Presentation policy for Economy and Gambling command responses only.
// Do not apply to manual Embed Builder messages or unrelated Cloudy embeds.
import { GAMBLING_GAME_COMMANDS } from '../config/gamblingCommands.js';
import { CLOUDY_LOGO_URL } from '../services/cloudyLogoService.js';
import {
  CLOUDY_GREEN_COLOR,
  CLOUDY_RED_COLOR,
  CLOUDY_NEUTRAL_COLOR,
} from './embedColorPolicy.js';

const ACTIVE_COMMANDS = new Set([
  ...GAMBLING_GAME_COMMANDS.map(command => command.name),
  'gamble', 'game', 'economy',
]);

// Only known UI copy is recased. Usernames, customized proper names,
// Discord mentions, code, URLs and opaque dynamic values are left alone.
const UI_WORDS = new Set([
  'a', 'about', 'account', 'action', 'added', 'after', 'again', 'all', 'amount',
  'and', 'are', 'available', 'balance', 'bank', 'banker', 'bet', 'bets',
  'blocked', 'bust', 'by', 'can', 'card', 'cards', 'cash', 'check', 'chosen',
  'claim', 'claimed', 'coins', 'completed', 'cooldown', 'cost', 'current',
  'daily', 'dealer', 'deposit', 'deposited', 'down', 'draw', 'earned',
  'error', 'expired', 'failed', 'failure', 'fee', 'fine', 'for', 'from',
  'funds', 'game', 'games', 'hand', 'hands', 'has', 'have', 'in', 'income',
  'information', 'insufficient', 'invalid', 'inventory', 'is', 'item',
  'items', 'leaderboard', 'left', 'limit', 'loss', 'lost', 'money', 'new',
  'next', 'not', 'of', 'on', 'out', 'paid', 'pay', 'payment', 'payout',
  'player', 'points', 'received', 'remaining', 'result', 'returned',
  'reward', 'rewards', 'robbery', 'roulette', 'saved', 'score', 'stand',
  'status', 'stolen', 'success', 'successful', 'successfully', 'the',
  'tie', 'to', 'too', 'total', 'transaction', 'transfer', 'updated',
  'value', 'wallet', 'was', 'were', 'win', 'winner', 'winning', 'withdraw',
  'withdrawal', 'won', 'work', 'you', 'your',
]);

// Never change a URL, Discord mention or code literal while formatting copy.
const PROTECTED_PARTS = /(https?:\/\/[^\s]+|<[^>]+>|\x60[^\x60]*\x60)/g;
const WORD = /[\p{L}]+(?:['’][\p{L}]+)?/gu;
const ERROR_TITLE = /\b(?:error|failed|failure|lost|loss|bust|blocked|denied|invalid|insufficient|rejected|unsuccessful|too fast|cooldown|not enough|unable|expired)\b/i;
const SUCCESS_TITLE = /\b(?:success|successful|won|win|winning|completed|earned|received|deposited|withdrawn|paid|added|claimed|transferred|payment|reward claimed)\b/i;
const NEUTRAL_TITLE = /\b(?:balance|inventory|leaderboard|bet|bets|overview|information|guide)\b/i;
const RED_COLORS = new Set([0x7A1712, 0xED4245, 0x670102, 0xFF0000]);
const GREEN_COLORS = new Set([0x00C49D, 0x57F287, 0x00FF00, 0x2ECC71]);

export function economySentenceCase(value) {
  if (typeof value !== 'string') return value;
  return value.split('\n').map(line => {
    let firstWord = true;
    return line.split(PROTECTED_PARTS).map(part => {
      if (part.startsWith('http://') || part.startsWith('https://')
          || part.startsWith('<') || part.startsWith('\x60')) return part;
      return part.replace(WORD, word => {
        const lower = word.toLocaleLowerCase('en');
        const isLabel = UI_WORDS.has(lower);
        if (firstWord) {
          firstWord = false;
          // Keep a username/opaque dynamic token unchanged.
          return isLabel ? lower[0].toLocaleUpperCase('en') + lower.slice(1) : word;
        }
        return isLabel ? lower : word;
      });
    }).join('');
  }).join('\n');
}

function statusColor(source) {
  const title = String(source.title || '');
  // The outcome name is stronger evidence than a stale saved template color.
  if (ERROR_TITLE.test(title)) return CLOUDY_RED_COLOR;
  if (SUCCESS_TITLE.test(title)) return CLOUDY_GREEN_COLOR;
  // Checking an account or placing an unresolved bet is neutral, even when
  // an old saved response reused a colored status template.
  if (NEUTRAL_TITLE.test(title)) return CLOUDY_NEUTRAL_COLOR;
  const color = Number(source.color);
  if (RED_COLORS.has(color)) return CLOUDY_RED_COLOR;
  if (GREEN_COLORS.has(color)) return CLOUDY_GREEN_COLOR;
  return CLOUDY_NEUTRAL_COLOR;
}

export function normalizeEconomyEmbed(sourceEmbed) {
  if (!sourceEmbed || typeof sourceEmbed !== 'object') return sourceEmbed;
  const source = typeof sourceEmbed.toJSON === 'function'
    ? sourceEmbed.toJSON() : sourceEmbed;
  if (!source || (source.type && source.type !== 'rich')) return sourceEmbed;
  const normalized = {
    ...source,
    ...(typeof source.title === 'string'
      ? { title: economySentenceCase(source.title) } : {}),
    ...(typeof source.description === 'string'
      ? { description: economySentenceCase(source.description) } : {}),
    ...(Array.isArray(source.fields)
      ? { fields: source.fields.map(field => ({
        ...field,
        name: economySentenceCase(field.name),
        value: economySentenceCase(field.value),
      })) } : {}),
    color: statusColor(source),
    thumbnail: { url: CLOUDY_LOGO_URL },
  };
  // Keep discord.js builders and their existing metadata intact.
  if (sourceEmbed.data && typeof sourceEmbed.setTitle === 'function'
      && typeof sourceEmbed.toJSON === 'function') {
    sourceEmbed.data = normalized;
    return sourceEmbed;
  }
  return normalized;
}

export function normalizeEconomyPayload(payload) {
  if (!payload || !Array.isArray(payload.embeds) || !payload.embeds.length) return payload;
  return { ...payload, embeds: payload.embeds.map(normalizeEconomyEmbed) };
}

export function normalizeEconomyInteractionPayload(interaction, payload) {
  const name = String(interaction?.commandName || interaction?._commandName || '').toLowerCase();
  // No implicit channel-wide edits: a different command in a gambling channel
  // must never accidentally become an economy message.
  return ACTIVE_COMMANDS.has(name) ? normalizeEconomyPayload(payload) : payload;
}
