// Rust maps for the map vote (owner's choice): the pictures come from
// rustmaps.com. Only rustmaps.com and content.rustmaps.com are ever contacted.
const HOST = 'https://rustmaps.com';
const CONTENT = 'https://content.rustmaps.com/maps';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; CloudyBot/2.1)' };
const MAP_INPUT = /^(?:https:\/\/rustmaps\.com\/map\/)?(\d{3,5})_(\d{1,10})\/?$/i;
const TIMEOUT_MS = 15_000;

export function parseMapInput(text) {
  const match = MAP_INPUT.exec(String(text || '').trim());
  return match ? { size: Number(match[1]), seed: Number(match[2]) } : null;
}

const pageUrl = (size, seed) => `${HOST}/map/${size}_${seed}`;
const imageUrl = (version, mapId) => `${CONTENT}/${version}/${mapId}/map_icons.png`;
const shape = (size, seed, version, mapId) => ({ size, seed, mapId, pageUrl: pageUrl(size, seed), image: imageUrl(version, mapId) });

async function getText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`rustmaps.com answered ${response.status}`);
  return response.text();
}

async function imageExists(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { method: 'HEAD', headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/** A map from "3700_1106429558" or its rustmaps.com link. */
export async function resolveMap(input, { fetchImpl = fetch } = {}) {
  const parsed = parseMapInput(input);
  if (!parsed) throw new Error('Use a rustmaps.com map link or size_seed, for example 3700_1106429558.');
  const html = await getText(pageUrl(parsed.size, parsed.seed), fetchImpl);
  const found = /content\.rustmaps\.com\/maps\/(\d+)\/([0-9a-f]{32})\//.exec(html);
  if (!found) throw new Error(`Map ${parsed.size}_${parsed.seed} was not found on rustmaps.com.`);
  return shape(parsed.size, parsed.seed, found[1], found[2]);
}

/** `count` different maps from the front page of rustmaps.com. */
export async function featuredMaps(count, { fetchImpl = fetch, random = Math.random, exclude = [] } = {}) {
  const html = (await getText(`${HOST}/`, fetchImpl)).replaceAll('\\"', '"');
  const pattern = /"mapId":"([0-9a-f]{32})"[^{}]*?"url":"\/map\/(\d+)_(\d+)"[^{}]*?"thumbnailUrl":"https:\/\/content\.rustmaps\.com\/maps\/(\d+)\//g;
  const seen = new Set(exclude);
  const maps = [];
  for (const [, mapId, size, seed, version] of html.matchAll(pattern)) {
    if (seen.has(mapId)) continue;
    seen.add(mapId);
    maps.push(shape(Number(size), Number(seed), version, mapId));
  }
  for (let index = maps.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [maps[index], maps[other]] = [maps[other], maps[index]];
  }
  const picked = [];
  for (const map of maps) {
    if (picked.length >= count) break;
    if (await imageExists(map.image, fetchImpl)) picked.push(map);
  }
  if (picked.length < count) throw new Error('Could not find enough maps on rustmaps.com right now.');
  return picked;
}
