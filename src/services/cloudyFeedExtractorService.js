import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net, { isIP } from 'node:net';
import { validateSourceUrl, publicIp } from './cloudyFeedParser.js';

const MAX_ENTRIES = 20;
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
const MAX_CONNECTIONS = 12;
const DISCOVERY_TIMEOUT_MS = 18_000;
const MAX_CONCURRENT_EXTRACTIONS = 2;
let activeExtractions = 0;
const waitingExtractions = [];

async function withExtractorSlot(task) {
  if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
    await new Promise(resolve => waitingExtractions.push(resolve));
  }
  activeExtractions++;
  try {
    return await task();
  } finally {
    activeExtractions--;
    waitingExtractions.shift()?.();
  }
}

// Gallery/video extractors must never make unrestricted requests from Railway.
// A local HTTPS CONNECT proxy verifies and pins the destination's public IP
// for every connection, including redirects and third-party CDN assets.
async function withPublicHttpsProxy(callback) {
  const sockets = new Set();
  const server = http.createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  server.on('connect', async (request, downstream, head) => {
    sockets.add(downstream);
    downstream.on('close', () => sockets.delete(downstream));
    const reject = () => {
      if (!downstream.destroyed) {
        downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
    };
    const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):443$/i.exec(String(request.url || ''));
    if (!match || !match[1].includes('.') || isIP(match[1]) || sockets.size > MAX_CONNECTIONS) {
      reject();
      return;
    }
    try {
      const addresses = await lookup(match[1], { all: true, verbatim: true });
      if (!addresses.length || addresses.some(entry => !publicIp(entry.address))) {
        reject();
        return;
      }
      if (downstream.destroyed) return;
      const address = addresses[0];
      const upstream = net.connect({ host: address.address, family: address.family, port: 443 });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
      downstream.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        if (downstream.destroyed) return upstream.destroy();
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
    } catch {
      reject();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await callback('http://127.0.0.1:' + server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
}

function executeWithLimit(command, args, {
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  maxBytes = MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Do not inherit credentials or user-configured proxies into extractors.
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '',
        XDG_CONFIG_HOME: '/dev/null',
      },
    });
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error('Media extractor timed out.'));
    }, timeoutMs);
    timer.unref?.();

    const fail = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    child.stdout.on('data', part => {
      bytes += part.length;
      if (bytes > maxBytes) return fail(new Error('Media metadata exceeds size limit.'));
      chunks.push(part);
    });
    // Always consume stderr, but never leak a URL, token or page content.
    child.stderr.resume();
    child.once('error', fail);
    child.once('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(command + ' could not extract public media.'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function runFeedExtractor(command, args, options = {}) {
  return withExtractorSlot(() => withPublicHttpsProxy(proxy =>
    executeWithLimit(command, [...args, '--proxy', proxy], options)));
}

function safeHttps(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  try { return validateSourceUrl(value).href; } catch { return null; }
}

export function parseYtDlpItems(payload) {
  const items = Array.isArray(payload?.entries) ? payload.entries : [payload];
  const seen = new Set();
  const result = [];
  for (const info of items.slice(0, MAX_ENTRIES)) {
    if (!info || typeof info !== 'object' || info.is_live || info.has_drm
        || info.availability === 'needs_auth' || info.availability === 'premium_only') continue;
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const playable = formats.some(format =>
      format?.vcodec && format.vcodec !== 'none')
      || Boolean(info.vcodec && info.vcodec !== 'none' && info.ext);
    if (!playable) continue;
    const page = safeHttps(info.webpage_url) || safeHttps(info.original_url)
      || safeHttps(info.url);
    if (!page) continue;
    const id = String(info.id || page).slice(0, 160);
    const stableKey = 'yt-dlp:' + (info.extractor_key || 'video') + ':' + id;
    if (seen.has(stableKey)) continue;
    seen.add(stableKey);
    result.push({
      title: String(info.title || 'Video').slice(0, 250),
      url: page, video: page, image: null, description: '', country: null,
      mediaExtractor: 'yt-dlp', dedupKey: stableKey,
    });
  }
  return result;
}

export function parseGalleryDlUrls(stdout, source) {
  const seen = new Set();
  const items = [];
  for (const raw of String(stdout || '').split(/\r?\n/).slice(0, MAX_ENTRIES * 3)) {
    const image = safeHttps(raw.trim());
    if (!image || /\.(?:mp4|webm|m3u8|mov)(?:[?#]|$)/i.test(image) || seen.has(image)) continue;
    seen.add(image);
    items.push({
      title: 'Photo', url: source, image, video: null, description: '', country: null,
      dedupKey: 'gallery-dl:' + image.split('?')[0],
    });
    if (items.length >= MAX_ENTRIES) break;
  }
  return items;
}

export async function discoverExtractorMedia(sourceUrl, mediaType, runner = runFeedExtractor) {
  const source = validateSourceUrl(sourceUrl).href;
  if (mediaType === 'picture') {
    try {
      const stdout = await runner('gallery-dl', [
        '--config-ignore', '--no-input', '--get-urls', '--range', '1-20',
        '--retries', '1', '--http-timeout', '7', source,
      ], { timeoutMs: DISCOVERY_TIMEOUT_MS, maxBytes: 500_000 });
      return parseGalleryDlUrls(stdout, source);
    } catch { return []; }
  }
  if (mediaType === 'video' || !mediaType) {
    try {
      const stdout = await runner('yt-dlp', [
        '--ignore-config', '--no-plugin-dirs', '--no-cache-dir',
        '--dump-single-json', '--skip-download', '--ignore-errors', '--no-warnings',
        '--playlist-end', '12', '--socket-timeout', '7', '--retries', '1',
        '--fragment-retries', '1', source,
      ], { timeoutMs: DISCOVERY_TIMEOUT_MS });
      const items = parseYtDlpItems(JSON.parse(stdout));
      if (items.length || mediaType === 'video') return items;
    } catch {
      if (mediaType === 'video') return [];
    }
  }
  return discoverExtractorMedia(source, 'picture', runner);
}
