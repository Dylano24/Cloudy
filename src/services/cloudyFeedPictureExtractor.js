import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { validateSourceUrl } from './cloudyFeedParser.js';
import { runFeedExtractor } from './cloudyFeedExtractorService.js';
import { imageFileType, videoUploadLimit } from './cloudyFeedMediaUpload.js';

async function imageFiles(directory, depth = 0) {
  if (depth > 5) return [];
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await imageFiles(fullPath, depth + 1));
    } else if (entry.isFile() && /\.(?:jpe?g|png|gif|webp)$/i.test(entry.name)) {
      files.push(fullPath);
    }
    if (files.length > 10) break;
  }
  return files;
}

// On some galleries the image CDN rejects bare HTTPS requests. gallery-dl
// knows the public referrer/headers for that gallery, so let it download the
// chosen image through the same public-IP-only HTTPS proxy.
export async function makeExtractedImageAttachmentMessage(sourceUrl, itemIndex, guildLimit, {
  runner = runFeedExtractor,
} = {}) {
  const source = validateSourceUrl(sourceUrl).href;
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 1 || itemIndex > 20) {
    throw new Error('Invalid gallery picture selection.');
  }
  const limit = videoUploadLimit(guildLimit);
  const folder = await mkdtemp(path.join(tmpdir(), 'cloudy-picture-' + randomUUID().slice(0, 8) + '-'));
  try {
    await runner('gallery-dl', [
      '--config-ignore', '--no-input', '--no-progress',
      '--range', String(itemIndex), '--retries', '1', '--http-timeout', '8',
      '--filesize-max', String(limit),
      '--destination', folder, '--no-part', '--no-mtime', source,
    ], { timeoutMs: 35_000, maxBytes: 80_000 });
    const candidates = await imageFiles(folder);
    if (candidates.length !== 1) throw new Error('The gallery did not provide a single picture.');
    const size = (await stat(candidates[0])).size;
    if (size < 8 || size > limit) throw new Error('Picture exceeds the Discord upload limit.');
    const buffer = await readFile(candidates[0]);
    const extension = imageFileType(buffer);
    if (!extension) throw new Error('Gallery did not return a supported picture.');
    return {
      files: [new AttachmentBuilder(buffer, { name: 'cloudy-picture.' + extension })],
      allowedMentions: { parse: [] },
    };
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}
