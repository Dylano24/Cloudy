import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Every Cloudy Feed video is posted as a 10-second clip from the middle.
export const CLIP_SECONDS = 10;
// Videos up to this length (a rounding margin) are posted as they are.
const CLIP_TOLERANCE_SECONDS = 0.1;
const CLIP_TIMEOUT_MS = 35_000;

let conversionBusy = false;
const waitingConversions = [];
export async function withConversionSlot(task) {
  if (conversionBusy) {
    await new Promise(resolve => waitingConversions.push(resolve));
  } else {
    conversionBusy = true;
  }
  try {
    return await task();
  } finally {
    const next = waitingConversions.shift();
    if (next) next();
    else conversionBusy = false;
  }
}

export function runLocalCommand(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let completed = false;
    const finish = (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error('Video conversion timed out.')), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      if (output.length > 32_000) return finish(new Error('Unexpected video conversion output.'));
      output += String(chunk);
    });
    child.stderr.resume();
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error('Video conversion failed.')));
  });
}

export function targetVideoBitrateKbps(uploadBytes, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 240) {
    throw new Error('The video cannot fit the Discord upload limit without shortening it.');
  }
  const bytesForVideo = uploadBytes * 0.72;
  const kbps = Math.floor(bytesForVideo * 8 / (seconds * 1000) - 96);
  if (kbps < 110) throw new Error('Video is too long to upload at acceptable quality.');
  return Math.min(1600, kbps);
}

export function needsClip(seconds) {
  return Number.isFinite(seconds) && seconds > CLIP_SECONDS + CLIP_TOLERANCE_SECONDS;
}

// Where the 10-second clip starts so that it sits in the middle of the video.
export function middleClipStart(seconds) {
  if (!needsClip(seconds)) return 0;
  return Math.round((seconds / 2 - CLIP_SECONDS / 2) * 1000) / 1000;
}

export async function probeVideoSeconds(input, run = runLocalCommand) {
  const text = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', input,
  ], 5_000);
  return Number(String(text ?? '').trim());
}

// Cuts the middle 10 seconds out of a local file. Shorter videos are returned
// unchanged. ffmpeg only reads the local file here, never the network.
export async function clipVideoFile(input, destination, limitBytes, run = runLocalCommand) {
  const seconds = await probeVideoSeconds(input, run);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('The video length could not be read.');
  if (!needsClip(seconds)) return input;
  const bitrate = targetVideoBitrateKbps(limitBytes, CLIP_SECONDS);
  await run('ffmpeg', [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-ss', String(middleClipStart(seconds)), '-i', input, '-t', String(CLIP_SECONDS),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=min(1280\\,iw):-2',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', bitrate + 'k', '-maxrate', bitrate + 'k',
    '-bufsize', bitrate * 2 + 'k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
    destination,
  ], CLIP_TIMEOUT_MS);
  const info = await stat(destination);
  if (!info.size || info.size > limitBytes) throw new Error('The 10-second clip is too large for Discord.');
  return destination;
}

// Same as clipVideoFile, for a video that was downloaded into memory.
export async function clipVideoBuffer(buffer, extension, limitBytes, clip = clipVideoFile) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-clip-' + randomUUID().slice(0, 8) + '-'));
  try {
    const input = path.join(directory, 'source.' + extension);
    await writeFile(input, buffer);
    const output = await withConversionSlot(() =>
      clip(input, path.join(directory, 'cloudy-clip.mp4'), limitBytes));
    if (output === input) return { buffer, extension };
    return { buffer: await readFile(output), extension: 'mp4' };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
