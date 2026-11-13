// Console commands for Rust Console Edition community servers.
//
// RCON treats a command exactly like a line in server.cfg, so every value that
// goes into one is checked against a strict allow-list first: no quotes,
// semicolons, line breaks or other characters that could end the argument or
// start a second command. Kit syntax (Rust Console Edition community server
// docs, Kit Management): kit givetoplayer "kitname" "ID", where ID is the
// player's in-game name (Xbox gamertag or PSN online ID).

export const PLATFORMS = Object.freeze(['xbox', 'playstation']);

// Xbox: letters, digits and single spaces, up to 15 characters, optionally
// with the modern "#1234" suffix. PSN online ID: 3-16 characters, starts with
// a letter; letters, digits, hyphen and underscore.
const XBOX_GAMERTAG = /^[A-Za-z0-9](?:[A-Za-z0-9]| (?! )){0,14}(?:#\d{1,5})?$/;
const PSN_ONLINE_ID = /^[A-Za-z][A-Za-z0-9_-]{2,15}$/;
const KIT_NAME = /^[A-Za-z0-9_-]{1,32}$/;

export class RustCommandError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RustCommandError';
    this.code = code;
  }
}

export function normalizePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['xbox', 'xb', 'xbl', 'microsoft'].includes(text)) return 'xbox';
  if (['playstation', 'ps', 'ps4', 'ps5', 'psn'].includes(text)) return 'playstation';
  return null;
}

/** Returns the gamertag as the server knows it, or throws RustCommandError. */
export function normalizeGamertag(value, platform) {
  const text = String(value ?? '').trim();
  const valid = platform === 'xbox' ? XBOX_GAMERTAG.test(text) : platform === 'playstation' ? PSN_ONLINE_ID.test(text) : false;
  if (!valid) throw new RustCommandError(platform === 'playstation' ? 'Enter a valid PSN online ID.' : 'Enter a valid Xbox gamertag.', 'invalid_gamertag');
  return text;
}

export function normalizeKitName(value) {
  const text = String(value ?? '').trim();
  if (!KIT_NAME.test(text)) throw new RustCommandError('Invalid kit name.', 'invalid_kit');
  return text;
}

/** Case-insensitive identity of a player on one platform. */
export function playerKey(platform, gamertag) {
  return `${platform}:${gamertag.toLowerCase()}`;
}

export function buildKitCommand(kit, gamertag, platform) {
  const safeKit = normalizeKitName(kit);
  const safeName = normalizeGamertag(gamertag, platform);
  return `kit givetoplayer "${safeKit}" "${safeName}"`;
}
