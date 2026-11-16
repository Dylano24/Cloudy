// Parser for Rust Console Edition (RCE) server console lines received over
// WebRCON. Pure functions only: every line becomes at most one event object.
//
// The line formats follow what RCE community servers print (the same strings
// the open-source rce.js library matches): kills ("<victim> was killed by
// <killer>"), respawns ("<name> [SCARLETT] has entered the game"), quick chat
// ("[CHAT LOCAL] <name> : d11_quick_chat_..."), notes, teams, kits, items,
// roles, bans, world events and custom zones. Joins and leaves are not logged
// by the game: they come from comparing two `playerlist` answers.

export const KILLER_TYPES = Object.freeze({ player: 'player', npc: 'npc', entity: 'entity', natural: 'natural' });

// Killer and victim names that are not players (lower-case id -> name, type).
const NON_PLAYERS = new Map(Object.entries({
  thirst: ['Thirst', 'natural'],
  hunger: ['Hunger', 'natural'],
  'pee pee 9000': ['Pee Pee 9000', 'natural'],
  cold: ['Cold', 'natural'],
  bleeding: ['Bleeding', 'natural'],
  fall: ['Fall', 'natural'],
  'fall!': ['Fall', 'natural'],
  drowned: ['Drowned', 'natural'],
  radiation: ['Radiation', 'natural'],
  heat: ['Heat', 'natural'],
  poison: ['Poison', 'natural'],
  suicide: ['Suicide', 'natural'],
  bear: ['Bear', 'npc'],
  'bear (bear)': ['Bear', 'npc'],
  boar: ['Boar', 'npc'],
  'boar (boar)': ['Boar', 'npc'],
  wolf: ['Wolf', 'npc'],
  'wolf (wolf)': ['Wolf', 'npc'],
  'bradleyapc (entity)': ['Bradley APC', 'npc'],
  'patrolhelicopter (entity)': ['Patrol Helicopter', 'npc'],
  'guntrap.deployed': ['Shotgun Trap', 'entity'],
  'guntrap.deployed (entity)': ['Shotgun Trap', 'entity'],
  'barricade.wood': ['Wooden Barricade', 'entity'],
  'barricade.wood (entity)': ['Wooden Barricade', 'entity'],
  'barricade.woodwire (entity)': ['Wooden Barricade', 'entity'],
  'barricade.metal (entity)': ['Metal Barricade', 'entity'],
  'wall.external.high.stone': ['High External Stone Wall', 'entity'],
  'wall.external.high.stone (entity)': ['High External Stone Wall', 'entity'],
  'wall.external.high': ['High External Wooden Wall', 'entity'],
  'wall.external.high (entity)': ['High External Wooden Wall', 'entity'],
  'wall.external.high.wood (entity)': ['High External Wooden Wall', 'entity'],
  'wall.external.high.ice (entity)': ['High External Ice Wall', 'entity'],
  'wall.external.high.adobe (entity)': ['High External Adobe Wall', 'entity'],
  'gates.external.high.wood': ['High External Wooden Gate', 'entity'],
  'gates.external.high.wood (entity)': ['High External Wooden Gate', 'entity'],
  'gates.external.high.stone': ['High External Stone Gate', 'entity'],
  'gates.external.high.stone (entity)': ['High External Stone Gate', 'entity'],
  'gates.external.high.adobe (entity)': ['High External Adobe Gate', 'entity'],
  'flameturret_fireball (entity)': ['Flame Turret', 'entity'],
  'flameturret.deployed (entity)': ['Flame Turret', 'entity'],
  'icewall (entity)': ['Ice Wall', 'entity'],
  autoturret_deployed: ['Auto Turret', 'entity'],
  'autoturret_deployed (entity)': ['Auto Turret', 'entity'],
  'lock.code (entity)': ['Code Lock', 'entity'],
  'spikes.floor (entity)': ['Floor Spikes', 'entity'],
  'sentry.bandit.static (entity)': ['Bandit Sentry', 'entity'],
  'sentry.scientist.static (entity)': ['Scientist Sentry', 'entity'],
  'landmine (entity)': ['Landmine', 'entity'],
  'beartrap (entity)': ['Bear Trap', 'entity'],
  'oilfireballsmall (entity)': ['Small Oil Fire', 'entity'],
  'napalm (entity)': ['Napalm', 'entity'],
  'fireball (entity)': ['Fireball', 'entity'],
  'fireball_small (entity)': ['Fireball', 'entity'],
  'cargoshipdynamic1 (entity)': ['Cargo Ship', 'entity'],
  'cargoshipdynamic2 (entity)': ['Cargo Ship', 'entity'],
  'campfire (entity)': ['Campfire', 'entity'],
  'rocket_crane_lift_trigger (entity)': ['Crane Lift', 'entity'],
  'rowboat (entity)': ['Rowboat', 'entity'],
  'teslacoil.deployed (entity)': ['Tesla Coil', 'entity'],
  'hotairballoon (entity)': ['Hot Air Balloon', 'entity'],
  'minicopter.entity (entity)': ['Minicopter', 'entity'],
  'attackhelicopter.entity (entity)': ['Attack Helicopter', 'entity'],
  'scraptransporthelicopter (entity)': ['Scrap Transport Helicopter', 'entity'],
  'sam_site_turret_deployed (entity)': ['SAM Site', 'entity'],
  'sam_static (entity)': ['SAM Site', 'entity'],
  'ch47scientists.entity (entity)': ['Chinook Scientist', 'entity'],
  'submarinesolo.entity (entity)': ['Submarine', 'entity'],
  'submarineduo.entity (entity)': ['Submarine', 'entity'],
  'graveyardfence (entity)': ['Graveyard Fence', 'entity'],
}));
for (let i = 1; i <= 7; i++) NON_PLAYERS.set(`cactus-${i} (entity)`, ['Cactus', 'entity']);

/** Classifies one side of a kill line: a player, an NPC, an entity or a natural cause. */
export function classifyKillParty(raw) {
  const id = String(raw ?? '').trim();
  const known = NON_PLAYERS.get(id.toLowerCase());
  if (known) return { id, name: known[0], type: known[1] };
  // NPCs (scientists) are printed as their numeric network id.
  if (/^\d+$/.test(id) && id !== '0') return { id, name: 'Scientist', type: KILLER_TYPES.npc };
  if (/^(?:scientistnpc|npc_|murderer|scarecrow|tunneldweller|underwaterdweller)/i.test(id)) {
    return { id, name: /murderer|scarecrow/i.test(id) ? 'Scarecrow' : 'Scientist', type: KILLER_TYPES.npc };
  }
  if (/\s\(entity\)$/i.test(id)) {
    const base = id.replace(/\s\(entity\)$/i, '').replace(/\.(deployed|entity|static)$/i, '').replace(/[._]+/g, ' ').trim();
    return { id, name: base.replace(/\b\w/g, c => c.toUpperCase()) || 'Entity', type: KILLER_TYPES.entity };
  }
  return { id, name: id, type: KILLER_TYPES.player };
}

// Quick chat codes as the game logs them, with the text players see.
export const QUICK_CHAT = Object.freeze({
  d11_quick_chat_combat_slot_0: "We're under attack!",
  d11_quick_chat_combat_slot_1: 'Retreat!',
  d11_quick_chat_combat_slot_2: 'Move out!',
  d11_quick_chat_combat_slot_3: "Don't shoot!",
  d11_quick_chat_combat_slot_4: 'Be careful!',
  d11_quick_chat_combat_slot_5: "They're better armed!",
  d11_quick_chat_combat_slot_6: "I'm out of ammo!",
  d11_quick_chat_combat_slot_7: "I'm hurt!",
  d11_quick_chat_building_slot_0: 'Upgrade the walls',
  d11_quick_chat_building_slot_1: 'We need beds',
  d11_quick_chat_building_slot_2: 'I need building permission',
  d11_quick_chat_building_slot_3: "What's the door code?",
  d11_quick_chat_building_slot_4: 'Can I have a key?',
  d11_quick_chat_building_slot_5: 'We need a better door',
  d11_quick_chat_building_slot_6: 'Upkeep is running low',
  d11_quick_chat_building_slot_7: 'Which chest is free game?',
  'd11_quick_chat_activities_phrase_format d11_Stone': 'Going for stone',
  'd11_quick_chat_activities_phrase_format d11_Wood': 'Going for wood',
  'd11_quick_chat_activities_phrase_format d11_Metal': 'Going for metal',
  'd11_quick_chat_activities_phrase_format d11_Food': 'Going for food',
  'd11_quick_chat_activities_phrase_format d11_Water': 'Going for water',
  'd11_quick_chat_activities_phrase_format d11_Scrap': 'Going for scrap',
  'd11_quick_chat_activities_phrase_format d11_Metal_Fragments': 'Going for metal fragments',
  'd11_quick_chat_activities_phrase_format d11_Medicine': 'Going for medicine',
  d11_quick_chat_questions_slot_0: 'Are you friendly?',
  d11_quick_chat_questions_slot_1: 'Can I build around here?',
  d11_quick_chat_questions_slot_2: 'Do you want to team up?',
  d11_quick_chat_questions_slot_3: 'Do you need anything?',
  d11_quick_chat_questions_slot_4: 'Could you help me?',
  d11_quick_chat_questions_slot_5: 'Want to trade?',
  d11_quick_chat_questions_slot_6: "Who's there?",
  d11_quick_chat_questions_slot_7: 'Can I enter?',
  d11_quick_chat_responses_slot_0: 'Yes',
  d11_quick_chat_responses_slot_1: 'No',
  d11_quick_chat_responses_slot_2: 'OK',
  d11_quick_chat_responses_slot_3: 'Thank you',
  d11_quick_chat_responses_slot_4: 'No problem',
  d11_quick_chat_responses_slot_5: 'Hello',
  d11_quick_chat_responses_slot_6: 'Goodbye',
  d11_quick_chat_responses_slot_7: "I'm sorry",
  d11_quick_chat_orders_slot_0: 'Follow me',
  d11_quick_chat_orders_slot_1: 'Go away',
  d11_quick_chat_orders_slot_2: 'Repair this',
  d11_quick_chat_orders_slot_3: 'Wait here',
  d11_quick_chat_orders_slot_4: 'Come in',
  d11_quick_chat_orders_slot_5: "Let's go",
  d11_quick_chat_orders_slot_6: 'Here, take this',
  d11_quick_chat_orders_slot_7: 'Hurry up',
  d11_quick_chat_location_slot_0: 'North',
  d11_quick_chat_location_slot_1: 'North east',
  d11_quick_chat_location_slot_2: 'East',
  d11_quick_chat_location_slot_3: 'South east',
  d11_quick_chat_location_slot_4: 'South',
  d11_quick_chat_location_slot_5: 'South west',
  d11_quick_chat_location_slot_6: 'West',
  d11_quick_chat_location_slot_7: 'North west',
  'd11_quick_chat_i_need_phrase_format d11_Scrap': 'I need scrap',
  'd11_quick_chat_i_need_phrase_format lowgradefuel': 'I need low grade fuel',
  'd11_quick_chat_i_need_phrase_format d11_Food': 'I need food',
  'd11_quick_chat_i_need_phrase_format d11_Water': 'I need water',
  'd11_quick_chat_i_need_phrase_format d11_Wood': 'I need wood',
  'd11_quick_chat_i_need_phrase_format stones': 'I need stone',
  'd11_quick_chat_i_need_phrase_format d11_Metal_Fragments': 'I need metal fragments',
  'd11_quick_chat_i_need_phrase_format metal.refined': 'I need high quality metal',
  'd11_quick_chat_i_have_phrase_format d11_Scrap': 'I have scrap',
  'd11_quick_chat_i_have_phrase_format lowgradefuel': 'I have low grade fuel',
  'd11_quick_chat_i_have_phrase_format d11_Food': 'I have food',
  'd11_quick_chat_i_have_phrase_format d11_Water': 'I have water',
  'd11_quick_chat_i_have_phrase_format bow.hunting': 'I have a hunting bow',
  'd11_quick_chat_i_have_phrase_format pickaxe': 'I have a pickaxe',
  'd11_quick_chat_i_have_phrase_format hatchet': 'I have a hatchet',
  'd11_quick_chat_i_have_phrase_format metal.refined': 'I have high quality metal',
});

// Quick chat codes Cloudy itself listens to.
export const QUICK_CHAT_CODES = Object.freeze({
  canIBuild: 'd11_quick_chat_questions_slot_1',
  yes: 'd11_quick_chat_responses_slot_0',
  no: 'd11_quick_chat_responses_slot_1',
  goodbye: 'd11_quick_chat_responses_slot_6',
});

const QUICK_CHAT_BY_TEXT = new Map(Object.entries(QUICK_CHAT).map(([code, label]) => [label.toLowerCase().replace(/[!?.,']/g, ''), code]));

/** The quick chat code for a logged message: the code itself, or its (English) text. */
export function quickChatCode(message) {
  const text = String(message ?? '').trim();
  if (Object.hasOwn(QUICK_CHAT, text)) return text;
  const lower = text.toLowerCase();
  const exact = Object.keys(QUICK_CHAT).find(code => code.toLowerCase() === lower);
  if (exact) return exact;
  return QUICK_CHAT_BY_TEXT.get(lower.replace(/[!?.,']/g, '')) || null;
}

export function quickChatLabel(message) {
  const code = quickChatCode(message);
  return code ? QUICK_CHAT[code] : String(message ?? '').trim();
}

export const WORLD_EVENTS = Object.freeze({
  event_airdrop: 'Airdrop',
  event_cargoship: 'Cargo Ship',
  event_cargoheli: 'Chinook',
  event_helicopter: 'Patrol Helicopter',
  event_halloween: 'Halloween',
  event_xmas: 'Christmas',
  event_easter: 'Easter',
});

const RX = Object.freeze({
  commandExecuting: /Executing console system command '([^']+)'/,
  vendingName: /\[VENDING MACHINE\] Player \[ ([^\]]+) \] changed name from \[ ([^\]]*) \] to \[ ([^\]]*) \]/,
  chat: /^\[CHAT (TEAM|SERVER|LOCAL|GLOBAL)\]\s+(.+?)\s+:\s+(.+)$/,
  zoneCreated: /Successfully created zone \[([^\]]+)\]/,
  zoneRemoved: /Successfully removed zone \[([^\]]+)\]/,
  roleAdd: /\[([^\]]+)\] Added \[([^\]]+)\] to Group \[([^\]]+)\]/,
  roleRemove: /\[([^\]]+)\] Removed \[([^\]]+)\] from Group \[([^\]]+)\]/,
  banned: /\[([^\]]+)\] Added \[([^\]]+)\] to \[Banned\]/,
  unbanned: /\[([^\]]+)\] Removed \[([^\]]+)\] from \[Banned\]/,
  itemSpawn: /\bgiving ([^\r\n]+?) (\d+(?:\.\d+)?) x ([\w\s._-]+?)\s*$/,
  note: /\[NOTE PANEL\] Player \[ ([^\]]+) \] changed name from \[\s*([\s\S]*?)\s*\] to \[\s*([\s\S]*?)\s*\]/,
  teamCreate: /\[([^\]]+)\] created a new team, ID: \[?(\d+)\]?/,
  teamJoin: /\[([^\]]+)\] has joined \[([^\]]+)\]s team, ID: \[(\d+)\]/,
  teamLeave: /\[([^\]]+)\] has left \[([^\]]+)\]s team, ID: \[(\d+)\]/,
  teamPromoted: /\[([^\]]+)\] promoted \[([^\]]+)\] as their new leader of the team, ID: \[(\d+)\]/,
  kitGive: /\[ServerVar\] ([^\r\n]+?) giving ([^\r\n]+?) kit ([\w-]+)/,
  kitSpawn: /SERVER giving (.+?) kit ([\w-]+)/,
  save: /^\[ SAVE \] Saved (\d+) ents$/,
});

function cleanLine(raw) {
  return String(raw ?? '').replaceAll('\u0000', '').trim();
}

const firstNoteLine = value => String(value ?? '').trim().split('\\n')[0].split('\n')[0].trim();

/**
 * Turns one console line into an event, or null when Cloudy does not use it.
 * Every event has `type` and `line` (the original text, for the console log).
 */
export function parseConsoleLine(raw) {
  const line = cleanLine(raw);
  if (!line) return null;
  let m;

  if ((m = RX.chat.exec(line))) {
    const message = m[3].trim();
    return { type: 'chat', channel: m[1].toLowerCase(), player: m[2].trim(), message, code: quickChatCode(message), label: quickChatLabel(message), line };
  }
  if ((m = RX.note.exec(line))) {
    const before = firstNoteLine(m[2]);
    const after = firstNoteLine(m[3]);
    if (!after || after === before) return null;
    return { type: 'note', player: m[1].trim(), before, text: after, line };
  }
  if (line.includes(' was killed by ')) {
    const index = line.indexOf(' was killed by ');
    const victim = classifyKillParty(line.slice(0, index));
    const killer = classifyKillParty(line.slice(index + ' was killed by '.length));
    if (!victim.id || !killer.id) return null;
    return { type: 'kill', victim, killer, line };
  }
  if (line.includes(' was suicide by Suicide')) {
    return { type: 'suicide', player: line.split(' was suicide by Suicide')[0].trim(), line };
  }
  if (line.includes('has entered the game')) {
    const player = line.split(' [')[0].replace(/\s*has entered the game.*$/, '').trim();
    if (!player) return null;
    const platform = /\[SCARLETT\]|\[XBOX/i.test(line) ? 'xbox' : /\[PS|\[PROSPERO\]|\[ORBIS\]/i.test(line) ? 'playstation' : null;
    return { type: 'respawn', player, platform, line };
  }
  if (line.startsWith('[EVENT') || line.startsWith('[event')) {
    const key = Object.keys(WORLD_EVENTS).find(name => line.toLowerCase().includes(name));
    if (key) return { type: 'worldEvent', event: WORLD_EVENTS[key], key, special: ['event_halloween', 'event_xmas', 'event_easter'].includes(key), line };
    return null;
  }
  if ((m = RX.teamPromoted.exec(line))) return { type: 'teamPromoted', previous: m[1].trim(), leader: m[2].trim(), team: m[3], line };
  if ((m = RX.teamJoin.exec(line))) return { type: 'teamJoin', player: m[1].trim(), leader: m[2].trim(), team: m[3], line };
  if ((m = RX.teamLeave.exec(line))) return { type: 'teamLeave', player: m[1].trim(), leader: m[2].trim(), team: m[3], line };
  if ((m = RX.teamCreate.exec(line))) return { type: 'teamCreate', player: m[1].trim(), team: m[2], line };
  if ((m = RX.banned.exec(line))) return { type: 'ban', by: m[1] === 'SERVER' ? null : m[1].trim(), player: m[2].trim(), line };
  if ((m = RX.unbanned.exec(line))) return { type: 'unban', by: m[1] === 'SERVER' ? null : m[1].trim(), player: m[2].trim(), line };
  if ((m = RX.roleAdd.exec(line))) return { type: 'roleAdd', by: m[1] === 'SERVER' ? null : m[1].trim(), player: m[2].trim(), role: m[3].trim(), line };
  if ((m = RX.roleRemove.exec(line))) return { type: 'roleRemove', by: m[1] === 'SERVER' ? null : m[1].trim(), player: m[2].trim(), role: m[3].trim(), line };
  if ((m = RX.zoneCreated.exec(line))) return { type: 'zoneCreated', zone: m[1].trim(), line };
  if ((m = RX.zoneRemoved.exec(line))) return { type: 'zoneRemoved', zone: m[1].trim(), line };
  if ((m = RX.kitGive.exec(line))) return { type: 'kit', by: m[1].trim(), player: m[2].trim(), kit: m[3], line };
  if ((m = RX.kitSpawn.exec(line))) return { type: 'kit', by: null, player: m[1].trim(), kit: m[2], line };
  if ((m = RX.itemSpawn.exec(line))) return { type: 'item', player: m[1].replace(/^\[ServerVar\]\s*/, '').trim(), amount: Math.round(Number(m[2])), item: m[3].trim(), line };
  if ((m = RX.vendingName.exec(line))) return { type: 'vending', player: m[1].trim(), before: m[2], name: m[3], line };
  if ((m = RX.commandExecuting.exec(line))) return { type: 'command', command: m[1], line };
  if ((m = RX.save.exec(line))) return { type: 'save', entities: Number(m[1]), line };
  return null;
}

/**
 * Reads a `playerlist` answer. RCE community servers answer with JSON
 * ([{"DisplayName": "...", "Ping": 20, "ConnectedSeconds": 90, "Health": 100}]);
 * the older `Users` style (one quoted name per line) is accepted as well.
 * Returns null when the answer is not a player list at all.
 */
export function parsePlayerList(raw) {
  const text = cleanLine(raw);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.Players) ? parsed.Players : null;
    if (!list) return null;
    return list.map(entry => ({
      name: String(entry?.DisplayName ?? entry?.displayName ?? entry?.Name ?? '').trim(),
      ping: Number.isFinite(Number(entry?.Ping)) ? Number(entry.Ping) : null,
      connectedSeconds: Number.isFinite(Number(entry?.ConnectedSeconds)) ? Number(entry.ConnectedSeconds) : null,
      health: Number.isFinite(Number(entry?.Health)) ? Math.round(Number(entry.Health)) : null,
    })).filter(entry => entry.name);
  } catch {
    // Not JSON: "<slot:"name">", then one "name" per line, then "N users".
    if (!/users?\s*$/i.test(text) && !/<slot:/i.test(text)) return null;
    return text.split(/\r?\n/).map(row => row.trim())
      .filter(row => /^"[^"]+"$/.test(row))
      .map(row => ({ name: row.slice(1, -1).trim(), ping: null, connectedSeconds: null, health: null }))
      .filter(entry => entry.name);
  }
}

/** Reads a `serverinfo` answer (JSON); null when it is not JSON. */
export function parseServerInfo(raw) {
  const text = cleanLine(raw).replace(/\\n/g, '').trim();
  try {
    const info = JSON.parse(text);
    if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
    const number = key => (Number.isFinite(Number(info[key])) ? Number(info[key]) : null);
    return {
      hostname: typeof info.Hostname === 'string' ? info.Hostname.slice(0, 100) : null,
      players: number('Players'),
      maxPlayers: number('MaxPlayers'),
      queued: number('Queued'),
      joining: number('Joining'),
      entities: number('EntityCount'),
      uptime: number('Uptime'),
      map: typeof info.Map === 'string' ? info.Map.slice(0, 60) : null,
      framerate: number('Framerate'),
      memory: number('Memory'),
      gameTime: typeof info.GameTime === 'string' ? info.GameTime.slice(0, 40) : null,
      restarting: info.Restarting === true,
      saveCreatedTime: typeof info.SaveCreatedTime === 'string' ? info.SaveCreatedTime.slice(0, 40) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Reads `relationshipmanager.teaminfoall`: "Team 123 member list:" followed by
 * "<name> [<id>]" lines, the leader marked "(LEADER)". Returns null when the
 * answer has neither teams nor "No teams found".
 */
export function parseTeamInfo(raw) {
  const text = cleanLine(raw);
  if (/No teams found/i.test(text)) return [];
  const teams = [];
  let current = null;
  for (const row of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const header = /Team (\d+) member list:?/i.exec(row);
    if (header) { current = { id: header[1], leader: null, members: [] }; teams.push(current); continue; }
    const member = /^(.+?)\s+\[(\d+)\](\s+\(LEADER\))?$/i.exec(row);
    if (member && current) {
      const name = member[1].trim();
      current.members.push(name);
      if (member[3]) current.leader = name;
    }
  }
  if (!teams.length) return null;
  for (const team of teams) if (!team.leader && team.members.length) team.leader = team.members[0];
  return teams;
}

/** Finds an (x, y, z) position in a `server.printpos` answer. */
export function parsePosition(raw) {
  const m = /\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/.exec(cleanLine(raw));
  if (!m) return null;
  const [x, y, z] = [m[1], m[2], m[3]].map(Number);
  if (![x, y, z].every(Number.isFinite) || [x, y, z].some(value => Math.abs(value) > 10_000)) return null;
  return { x, y, z };
}

/** Reads `zones.listcustomzones` ("Name [ZORP_1] Enabled [True]"). Null when nothing matched. */
export function parseZoneList(raw) {
  const names = [];
  const rx = /Name\s*\[(.*?)\]\s*Enabled\s*\[(True|False)\]/gi;
  let m;
  while ((m = rx.exec(cleanLine(raw)))) names.push({ name: m[1].trim(), enabled: /true/i.test(m[2]) });
  return names.length ? names : null;
}
