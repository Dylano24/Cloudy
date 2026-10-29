import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { validateSourceUrl } from './cloudyFeedParser.js';
import { runFeedExtractor } from './cloudyFeedExtractorService.js';
import { videoFileType, videoUploadLimit } from './cloudyFeedMediaUpload.js';
import {
  CLIP_SECONDS, clipVideoFile, needsClip, runLocalCommand, targetVideoBitrateKbps, withConversionSlot,
} from './cloudyFeedVideoClip.js';

export { targetVideoBitrateKbps };

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 35_000;
const DOWNLOAD_TIMEOUT_MS = 55_000;
const ACCEPTED_VIDEO_FILES = /\.(?:mp4|webm|mkv|mov|ts)$/i;
// ffmpeg downloads a section through the guarded proxy: HTTPS only, never
// local files, plain HTTP or UDP, and never more than the safe source size.
const SECTION_INPUT_ARGS = 'ffmpeg_i:-protocol_whitelist https,tls,tcp,httpproxy,crypto,data -rw_timeout 15000000';
const SECTION_OUTPUT_ARGS = 'ffmpeg_o:-fs ' + MAX_SOURCE_BYTES;

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

const YT_DLP_BASE = ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--no-playlist'];
const YT_DLP_FORMAT = 'best[ext=mp4][height<=720]/best[ext=webm][height<=720]/bv*[height<=720]+ba/b[height<=720]/best';

async function remoteVideoSeconds(source, runner) {
  try {
    const stdout = await runner('yt-dlp', [
      ...YT_DLP_BASE, '--no-warnings', '--skip-download', '--print', 'duration',
      '--socket-timeout', '8', '--retries', '1', source,
    ], { timeoutMs: 20_000, maxBytes: 2_000 });
    return Number(String(stdout ?? '').trim().split(/\s+/)[0]);
  } catch { return NaN; }
}

function downloadArgs(source, output, section) {
  return [
    ...YT_DLP_BASE, '--no-progress', '--no-warnings',
    '--no-exec', '--no-part', '--no-mtime', '--hls-prefer-native',
    '--downloader', 'm3u8:native', '--downloader', 'dash:native',
    ...(section ? [
      '--download-sections', '*' + section.start.toFixed(3) + '-' + section.end.toFixed(3),
      '--downloader-args', SECTION_INPUT_ARGS, '--downloader-args', SECTION_OUTPUT_ARGS,
    ] : []),
    '--format', YT_DLP_FORMAT,
    '--merge-output-format', 'mp4', '--max-filesize', '64M',
    '--socket-timeout', '8', '--retries', '1', '--fragment-retries', '1',
    '--output', output, source,
  ];
}

// A little more than 10 seconds around the middle: the cut lands on a
// keyframe, and the exact clip is made locally afterwards.
function middleSection(seconds) {
  const half = CLIP_SECONDS / 2 + 1;
  return { start: Math.max(0, seconds / 2 - half), end: Math.min(seconds, seconds / 2 + half) };
}

async function removeFiles(directory) {
  for (const filename of await readdir(directory)) {
    await rm(path.join(directory, filename), { recursive: true, force: true }).catch(() => {});
  }
}

// Downloads public non-DRM videos. The extractor's own network traffic is
// routed through the guarded proxy; Cloudy's ffmpeg only processes local files.
// Long videos only download their middle part, and every post is a 10-second clip.
export async function makeExtractedVideoAttachmentMessage(pageUrl, guildLimit, {
  runner = runFeedExtractor,
  convert = optimizeVideo,
  clip = clipVideoFile,
} = {}) {
  const source = validateSourceUrl(pageUrl).href;
  const limitBytes = videoUploadLimit(guildLimit);
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-feed-' + randomUUID().slice(0, 8) + '-'));
  try {
    const output = path.join(directory, 'media.%(ext)s');
    const seconds = await remoteVideoSeconds(source, runner);
    let downloaded = false;
    if (needsClip(seconds)) {
      try {
        await runner('yt-dlp', downloadArgs(source, output, middleSection(seconds)),
          { timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: 80_000 });
        downloaded = true;
      } catch {
        // Some formats cannot be partly downloaded; try the whole video instead.
        await removeFiles(directory);
      }
    }
    if (!downloaded) {
      await runner('yt-dlp', downloadArgs(source, output, null),
        { timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: 80_000 });
    }

    const files = (await readdir(directory)).filter(filename => ACCEPTED_VIDEO_FILES.test(filename));
    if (files.length !== 1) throw new Error('The website did not produce one playable video.');
    const downloadedPath = path.join(directory, files[0]);
    const originalSize = (await stat(downloadedPath)).size;
    if (originalSize < 12 || originalSize > MAX_SOURCE_BYTES) {
      throw new Error('The video exceeds the safe download size.');
    }
    let pathname = await withConversionSlot(() =>
      clip(downloadedPath, path.join(directory, 'cloudy-clip.mp4'), limitBytes));
    let content = await readFile(pathname);
    let extension = videoFileType(content);
    if (!extension || content.length > limitBytes) {
      // No truncated files: either convert the entire clip, or decline upload.
      pathname = await withConversionSlot(() =>
        convert(pathname, path.join(directory, 'cloudy-optimized.mp4'), limitBytes));
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
