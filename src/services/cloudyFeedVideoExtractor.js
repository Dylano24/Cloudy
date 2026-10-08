import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { validateSourceUrl } from './cloudyFeedParser.js';
import { runFeedExtractor } from './cloudyFeedExtractorService.js';
import { videoFileType, videoUploadLimit } from './cloudyFeedMediaUpload.js';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 35_000;
const DOWNLOAD_TIMEOUT_MS = 55_000;
const ACCEPTED_VIDEO_FILES = /\.(?:mp4|webm|mkv|mov|ts)$/i;

function runLocalCommand(binary, args, timeoutMs) {
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

async function optimizeVideo(input, destination, limitBytes) {
  const durationText = await runLocalCommand('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', input,
  ], 5_000);
  const bitrate = targetVideoBitrateKbps(limitBytes, Number(durationText.trim()));
  await runLocalCommand('ffmpeg', [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-i', input, '-vf', 'scale=min(1280\\,iw):-2',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', bitrate + 'k', '-maxrate', bitrate + 'k',
    '-bufsize', bitrate * 2 + 'k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
    destination,
  ], TRANSCODE_TIMEOUT_MS);
  const info = await stat(destination);
  if (info.size > limitBytes) throw new Error('The converted video is still too large for Discord.');
  return destination;
}

// Downloads public non-DRM videos. The extractor's own network traffic is
// routed through the guarded proxy; ffmpeg only processes a local file.
export async function makeExtractedVideoAttachmentMessage(pageUrl, guildLimit, {
  runner = runFeedExtractor,
  convert = optimizeVideo,
} = {}) {
  const source = validateSourceUrl(pageUrl).href;
  const limitBytes = videoUploadLimit(guildLimit);
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-feed-' + randomUUID().slice(0, 8) + '-'));
  try {
    await runner('yt-dlp', [
      '--ignore-config', '--no-plugin-dirs', '--no-cache-dir',
      '--no-playlist', '--no-progress', '--no-warnings',
      '--no-exec', '--no-part', '--no-mtime', '--hls-prefer-native',
      '--downloader', 'm3u8:native', '--downloader', 'dash:native',
      '--format', 'best[ext=mp4][height<=720]/best[ext=webm][height<=720]/bv*[height<=720]+ba/b[height<=720]/best',
      '--merge-output-format', 'mp4', '--max-filesize', '64M',
      '--socket-timeout', '8', '--retries', '1', '--fragment-retries', '1',
      '--output', path.join(directory, 'media.%(ext)s'), source,
    ], { timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: 80_000 });

    const files = (await readdir(directory)).filter(filename => ACCEPTED_VIDEO_FILES.test(filename));
    if (files.length !== 1) throw new Error('The website did not produce one playable video.');
    let pathname = path.join(directory, files[0]);
    const originalSize = (await stat(pathname)).size;
    if (originalSize < 12 || originalSize > MAX_SOURCE_BYTES) {
      throw new Error('The video exceeds the safe download size.');
    }
    let content = await readFile(pathname);
    let extension = videoFileType(content);
    if (!extension || content.length > limitBytes) {
      // No truncated files: either convert the entire clip, or decline upload.
      pathname = await convert(pathname, path.join(directory, 'cloudy-optimized.mp4'), limitBytes);
      content = await readFile(pathname);
      extension = videoFileType(content);
    }
    if (!extension || !content.length || content.length > limitBytes) {
      throw new Error('The video is not a playable MP4 or WebM within the Discord upload limit.');
    }
    return {
      files: [new AttachmentBuilder(content, { name: 'cloudy-video.' + extension })],
      allowedMentions: { parse: [] },
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
