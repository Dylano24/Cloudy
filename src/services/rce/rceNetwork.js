// Game server addresses are typed by server staff, so Cloudy only connects to
// public addresses: never to its own machine, the private Railway network or
// another private range.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class RceHostError extends Error {}

function privateV4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function privateV6(address) {
  const text = address.toLowerCase();
  if (text === '::' || text === '::1') return true;
  if (text.startsWith('::ffff:')) return privateV4(text.slice(7));
  return /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || text.startsWith('ff');
}

export function isPrivateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) return privateV4(address);
  if (kind === 6) return privateV6(address);
  return true;
}

/** Throws RceHostError unless every address of the host is public. */
export async function assertPublicHost(host, resolve = lookup) {
  const name = String(host || '').trim().toLowerCase();
  if (!name || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.internal') || name.endsWith('.local')) {
    throw new RceHostError('Use the public IP or host name of the game server.');
  }
  if (isIP(name)) {
    if (isPrivateAddress(name)) throw new RceHostError('Use the public IP of the game server.');
    return;
  }
  let addresses;
  try { addresses = await resolve(name, { all: true }); } catch { throw new RceHostError('That host name could not be found.'); }
  if (!addresses?.length || addresses.some(entry => isPrivateAddress(entry.address))) throw new RceHostError('Use the public IP or host name of the game server.');
}
