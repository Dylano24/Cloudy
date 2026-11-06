// Vote Preview pictures (owner's choice: fast, no flicker). Preview sends a
// small copy of the option's picture (at most 1024 px wide, JPG): a phone
// screenshot in full size took seconds to send again, and a slow answer meant
// a "thinking" reply first, which made the vote's bars flicker. The small
// copies are made before the vote is posted and kept in memory.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLocalCommand } from './cloudyFeedVideoClip.js';

const PREVIEW_WIDTH = 1024;
const SHRINK_TIMEOUT_MS = 20_000;
const KEEP_MS = 6 * 60 * 60_000;
const KEEP_MAX_BYTES = 40 * 1024 * 1024;
const kept = new Map();

const keyOf = (messageId, position) => `${messageId}:${position}`;

export function keptVotePreview(messageId, position) {
  const key = keyOf(messageId, position);
  const entry = kept.get(key);
  if (!entry || entry.at + KEEP_MS < Date.now()) {
    kept.delete(key);
    return null;
  }
  return entry.file;
}

export function keepVotePreview(messageId, position, file) {
  const key = keyOf(messageId, position);
  kept.delete(key);
  kept.set(key, { file, at: Date.now() });
  let total = [...kept.values()].reduce((sum, entry) => sum + entry.file.attachment.length, 0);
  for (const [oldKey, entry] of kept) {
    if (total <= KEEP_MAX_BYTES) break;
    kept.delete(oldKey);
    total -= entry.file.attachment.length;
  }
}

/** For tests: forget every kept preview. */
export function forgetVotePreviews() {
  kept.clear();
}

/**
 * A small copy of a picture for Preview (local ffmpeg, local files only).
 * GIFs and pictures ffmpeg cannot read keep the original.
 */
export async function shrinkVotePicture(buffer, name, run = runLocalCommand) {
  const original = { attachment: buffer, name };
  if (/\.gif$/i.test(name)) return original;
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-vote-preview-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'preview.jpg');
    await writeFile(input, buffer);
    await run('ffmpeg', [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file,pipe',
      '-i', input, '-frames:v', '1', '-vf', `scale='min(${PREVIEW_WIDTH},iw)':-2`, '-q:v', '3', output,
    ], SHRINK_TIMEOUT_MS);
    const small = await readFile(output);
    return small.length && small.length < buffer.length ? { attachment: small, name: name.replace(/\.\w+$/, '.jpg') } : original;
  } catch {
    return original;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

async function download(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length && buffer.length <= MAX_PICTURE_BYTES ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * The small copy of an option's picture: the kept one, else downloaded from
 * its link (or a fresh link from `refresh` when that one expired) and shrunk.
 */
export async function votePreviewFile({ messageId, position, url, refresh = null, fetchImpl = fetch, shrink = shrinkVotePicture }) {
  const known = keptVotePreview(messageId, position);
  if (known) return known;
  let source = url;
  let buffer = source ? await download(source, fetchImpl) : null;
  if (!buffer && refresh) {
    source = await refresh().catch(() => null);
    if (source) buffer = await download(source, fetchImpl);
  }
  if (!buffer) return null;
  const extension = String(new URL(source).pathname).match(/\.(png|jpe?g|gif|webp)$/i)?.[1]?.toLowerCase() || 'png';
  const file = await shrink(buffer, `option${position + 1}.${extension}`);
  keepVotePreview(messageId, position, file);
  return file;
}
