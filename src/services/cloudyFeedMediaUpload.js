import https from 'node:https';
import dns from 'node:dns';
import { AttachmentBuilder } from 'discord.js';
import { publicIp, validateSourceUrl } from './cloudyFeedParser.js';

// Keep downloads within practical Discord upload limits, bot memory and bandwidth.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const FALLBACK_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export function videoFileType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return null;
}

export function videoUploadLimit(guildLimit) {
  const offered = Number(guildLimit);
  return Number.isFinite(offered) && offered > 0
    ? Math.min(Math.floor(offered), MAX_VIDEO_BYTES)
    : FALLBACK_UPLOAD_BYTES;
}

export async function bufferVideoStream(stream, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_VIDEO_BYTES) {
    throw new Error('Unsupported video upload limit.');
  }
  const buffers = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) {
      // Stop downloading once the file exceeds the supported upload limit.
      stream.destroy?.();
      throw new Error('Video is too large to upload directly to Discord.');
    }
    buffers.push(part);
  }
  const buffer = Buffer.concat(buffers, size);
  const extension = videoFileType(buffer);
  if (!extension) throw new Error('The website does not provide an MP4 or WebM video.');
  return { buffer, extension };
}

function checkedLookup(hostname, _options, callback) {
  // Pin the HTTPS request's DNS resolution to a checked public IP.
  // Never trust unverified resolution after merely checking DNS beforehand.
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length || addresses.some(entry => !publicIp(entry.address))) {
      return callback(new Error('Video host must have only public IP addresses.'));
    }
    const entry = addresses[0];
    callback(null, entry.address, entry.family);
  });
}

export async function downloadPlayableVideo(rawUrl, limitBytes = FALLBACK_UPLOAD_BYTES, hops = 0) {
  const url = validateSourceUrl(rawUrl);
  if (hops > MAX_REDIRECTS) throw new Error('Too many video redirects.');
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > MAX_VIDEO_BYTES) {
    throw new Error('Unsupported video upload limit.');
  }
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: checkedLookup,
      autoSelectFamily: false,
      timeout: 20_000,
      headers: {
        'User-Agent': 'CloudyFeed/1.0 (+Discord bot)',
        Accept: 'video/mp4, video/webm, application/octet-stream',
        'Accept-Encoding': 'identity',
      },
    }, response => {
      void (async () => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.resume();
          if (!location) throw new Error('Video redirect is invalid.');
          return downloadPlayableVideo(new URL(location, url).href, limitBytes, hops + 1);
        }
        if (status !== 200) {
          response.resume();
          throw new Error('Video website returned HTTP ' + status);
        }
        const declaredSize = Number(response.headers['content-length']);
        if (Number.isFinite(declaredSize) && declaredSize > limitBytes) {
          response.destroy();
          throw new Error('Video is too large to upload directly to Discord.');
        }
        const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (mime && !['video/mp4', 'video/webm', 'application/octet-stream', 'binary/octet-stream'].includes(mime)) {
          response.resume();
          throw new Error('Video URL does not return a playable MP4 or WebM file.');
        }
        return bufferVideoStream(response, limitBytes);
      })().then(resolve, reject);
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Video download timed out.')));
  });
}

export async function makeVideoAttachmentMessage(videoUrl, guildLimit, downloader = downloadPlayableVideo) {
  const sizeLimit = videoUploadLimit(guildLimit);
  const { buffer, extension } = await downloader(videoUrl, sizeLimit);
  if (!Buffer.isBuffer(buffer) || !videoFileType(buffer) || videoFileType(buffer) !== extension
      || buffer.length > sizeLimit) {
    throw new Error('Video is not a supported playable Discord attachment.');
  }
  // Discord renders this directly in the channel as its own playable attachment.
  // No link-only fallback; viewers can press Play without leaving Discord.
  return {
    files: [new AttachmentBuilder(buffer, { name: 'cloudy-video.' + extension })],
    allowedMentions: { parse: [] },
  };
}
