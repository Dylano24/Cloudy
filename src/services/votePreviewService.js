// Vote Preview pictures (owner's choice: fast, no flicker). Preview sends a
// small copy of the option's picture (at most 1024 px wide, JPG): a phone
// screenshot in full size took seconds to send again, and a slow answer meant
// a "thinking" reply first, which made the vote's bars flicker. The small
// copies are made right after the vote is posted and kept in memory.
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

/** Makes the small copies of a new vote's pictures (one entry per option, null without a picture). */
export async function warmVotePreviews(messageId, files, shrink = shrinkVotePicture) {
  await Promise.all(files.map(async (file, position) => {
    if (!file || keptVotePreview(messageId, position)) return;
    keepVotePreview(messageId, position, await shrink(file.attachment, file.name));
  }));
}
