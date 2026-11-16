// Console commands for Rust Console Edition community servers (syntax from
// the community server command reference). RCON runs a command exactly like a
// line typed in the server console, so every value is checked first: nothing
// a player or a form can type may close a quoted argument or start a second
// command.

export class RceCommandError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'RceCommandError';
    this.code = code;
  }
}

// Xbox gamertags and PSN IDs: letters, digits, spaces, "_", "-", "#" and ".".
// No quotes, backslashes, semicolons or line breaks.
const PLAYER_NAME = /^[\p{L}\p{N} _.#-]{1,32}$/u;
const ITEM_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const KIT_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ZONE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

export function safePlayerName(value) {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(String(value ?? ''))) throw new RceCommandError('Enter a valid gamertag or PSN ID.', 'invalid_player');
  const text = String(value ?? '').trim().replace(/ {2,}/g, ' ');
  if (!PLAYER_NAME.test(text) || !/[\p{L}\p{N}]/u.test(text)) throw new RceCommandError('Enter a valid gamertag or PSN ID.', 'invalid_player');
  return text;
}

export function safeItemName(value) {
  const text = String(value ?? '').trim();
  if (!ITEM_NAME.test(text)) throw new RceCommandError('Enter a valid item short name, for example rifle.ak.', 'invalid_item');
  return text.toLowerCase();
}

export function safeKitName(value) {
  const text = String(value ?? '').trim();
  if (!KIT_NAME.test(text)) throw new RceCommandError('Kit names may only use letters, digits, - and _.', 'invalid_kit');
  return text;
}

export function safeZoneName(value) {
  const text = String(value ?? '').trim();
  if (!ZONE_NAME.test(text)) throw new RceCommandError('Invalid zone name.', 'invalid_zone');
  return text;
}

export function safeAmount(value, max = 1_000_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new RceCommandError(`Enter an amount from 1 to ${max}.`, 'invalid_amount');
  return number;
}

/** Text for chat and reasons: double quotes become single ones, no ; or control characters. */
export function safeText(value, max = 200) {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/"/g, "'").replace(/[;\\]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
  if (!text) throw new RceCommandError('The message is empty.', 'invalid_text');
  return text;
}

export function safePosition(position) {
  const values = [position?.x, position?.y, position?.z].map(Number);
  if (!values.every(Number.isFinite) || values.some(value => Math.abs(value) > 10_000)) throw new RceCommandError('Enter a valid position.', 'invalid_position');
  return values.map(value => Math.round(value * 100) / 100);
}

/** A single console line typed by staff (their own server): one line, no NUL. */
export function safeConsoleLine(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 500 || /[\r\n\0]/.test(text)) throw new RceCommandError('Enter one console command (up to 500 characters).', 'invalid_command');
  return text;
}

const quote = value => `"${value}"`;

export const rceCommand = Object.freeze({
  say: message => `global.say ${quote(safeText(message, 220))}`,
  kick: player => `global.kick ${quote(safePlayerName(player))}`,
  ban: (player, reason = 'Banned by staff', seconds = null) => {
    const parts = ['global.banid', quote(safePlayerName(player)), quote(safeText(reason || 'Banned by staff', 120))];
    if (seconds != null) parts.push(quote(String(safeAmount(seconds, 10 * 365 * 86_400))));
    return parts.join(' ');
  },
  unban: player => `global.unban ${quote(safePlayerName(player))}`,
  kit: (kit, player) => `kit givetoplayer ${quote(safeKitName(kit))} ${quote(safePlayerName(player))}`,
  giveItem: (player, item, amount = 1) => `inventory.giveto ${quote(safePlayerName(player))} ${quote(safeItemName(item))} ${safeAmount(amount)}`,
  teleport: (player, position) => `global.teleportpos (${safePosition(position).join(',')}) ${quote(safePlayerName(player))}`,
  printPosition: player => `server.printpos ${quote(safePlayerName(player))}`,
  addVip: player => `VIPID ${quote(safePlayerName(player))}`,
  removeVip: player => `RemoveVIP ${quote(safePlayerName(player))}`,
  playerList: () => 'playerlist',
  serverInfo: () => 'serverinfo',
  teamInfo: () => 'relationshipmanager.teaminfoall',
  listZones: () => 'zones.listcustomzones',
  createZone: (name, position, radius, { pvp = true, npcDamage = true, buildingDamage = true, building = true } = {}) => {
    const size = safeAmount(radius, 500);
    return `zones.createcustomzone ${quote(safeZoneName(name))} (${safePosition(position).join(',')}) 0 Sphere ${size} ${pvp ? 1 : 0} ${npcDamage ? 1 : 0} 0 ${buildingDamage ? 1 : 0} ${building ? 1 : 0}`;
  },
  editZone: (name, setting, value) => {
    if (!/^(enabled|showarea|color|allowbuildingdamage|allowpvpdamage|allownpcdamage|allowbuilding|showchatmessage|entermessage|leavemessage)$/.test(setting)) {
      throw new RceCommandError('Unknown zone setting.', 'invalid_zone_setting');
    }
    let text;
    if (setting === 'color') {
      const rgb = (Array.isArray(value) ? value : []).map(Number);
      if (rgb.length !== 3 || !rgb.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) throw new RceCommandError('Invalid colour.', 'invalid_color');
      text = `(${rgb.join(',')})`;
    } else if (setting === 'entermessage' || setting === 'leavemessage') {
      text = quote(safeText(value, 120));
    } else {
      text = value ? '1' : '0';
    }
    return `zones.editcustomzone ${quote(safeZoneName(name))} ${setting} ${text}`;
  },
  deleteZone: name => `zones.deletecustomzone ${quote(safeZoneName(name))}`,
});

/**
 * A staff command template for shop items and emote actions, such as
 * `inventory.giveto "{player}" "wood" 1000`. Only {player} is filled in, with
 * a checked gamertag; the template itself is staff input for their own server.
 */
export function renderCommandTemplate(template, player) {
  const line = safeConsoleLine(template);
  if (!line.includes('{player}')) throw new RceCommandError('The command must contain {player}.', 'invalid_template');
  return line.split('{player}').join(safePlayerName(player));
}
