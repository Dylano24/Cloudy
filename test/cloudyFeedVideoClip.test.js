import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLIP_SECONDS, clipVideoBuffer, clipVideoFile, middleClipStart, needsClip,
} from '../src/services/cloudyFeedVideoClip.js';
import { makeExtractedVideoAttachmentMessage } from '../src/services/cloudyFeedVideoExtractor.js';
import { makeVideoAttachmentMessage } from '../src/services/cloudyFeedMediaUpload.js';

const mp4 = Buffer.alloc(24);
mp4.write('ftyp', 4, 'ascii');

test('feed videos become a 10-second clip from the middle; shorter videos stay as they are', () => {
  assert.equal(CLIP_SECONDS, 10);
  assert.equal(needsClip(6), false);
  assert.equal(needsClip(10), false);
  assert.equal(needsClip(10.05), false);
  assert.equal(needsClip(10.5), true);
  assert.equal(needsClip(Number.NaN), false);
  assert.equal(middleClipStart(60), 25);
  assert.equal(middleClipStart(125.4), 57.7);
  assert.equal(middleClipStart(8), 0);
});

test('the clip is cut locally at the middle and re-encoded to fit Discord', async () => {
  const calls = [];
  const run = async (binary, args) => {
    calls.push([binary, args]);
    if (binary === 'ffprobe') return '125.4\n';
    await writeFile(args.at(-1), mp4);
    return '';
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-clip-test-'));
  try {
    const output = path.join(directory, 'out.mp4');
    assert.equal(await clipVideoFile('/videos/in.webm', output, 10 * 1024 * 1024, run), output);
    const ffmpeg = calls.find(([binary]) => binary === 'ffmpeg')[1];
    assert.equal(ffmpeg[ffmpeg.indexOf('-ss') + 1], '57.7');
    assert.equal(ffmpeg[ffmpeg.indexOf('-t') + 1], '10');
    assert.equal(ffmpeg[ffmpeg.indexOf('-i') + 1], '/videos/in.webm');
    assert.equal(ffmpeg[ffmpeg.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.ok(ffmpeg.indexOf('-ss') < ffmpeg.indexOf('-i'), 'seek before reading for a fast cut');

    calls.length = 0;
    const short = async (binary) => { calls.push(binary); return '9.5'; };
    assert.equal(await clipVideoFile('/videos/short.mp4', output, 1000, short), '/videos/short.mp4');
    assert.deepEqual(calls, ['ffprobe'], 'a short video is not re-encoded');
    await assert.rejects(clipVideoFile('/videos/x.mp4', output, 1000, async () => 'N/A'), /length could not be read/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('long website videos download only their middle, then post the 10-second clip', async () => {
  const downloads = [];
  let clipped = 0;
  const message = await makeExtractedVideoAttachmentMessage('https://example.org/watch/long', 10_000, {
    runner: async (binary, args) => {
      assert.equal(binary, 'yt-dlp');
      if (args.includes('--print')) {
        assert.equal(args[args.indexOf('--print') + 1], 'duration');
        assert.ok(args.includes('--skip-download'));
        return '600\n';
      }
      downloads.push(args);
      await writeFile(args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4'), mp4);
    },
    clip: async (input, destination, limit) => {
      assert.equal(limit, 10_000);
      clipped++;
      await writeFile(destination, mp4);
      return destination;
    },
    convert: async () => { throw new Error('a fitting clip is not converted again'); },
  });
  assert.equal(downloads.length, 1);
  const args = downloads[0];
  assert.equal(args[args.indexOf('--download-sections') + 1], '*294.000-306.000');
  const downloaderArgs = args.flatMap((value, index) => args[index - 1] === '--downloader-args' ? [value] : []);
  assert.deepEqual(downloaderArgs, [
    'ffmpeg_i:-protocol_whitelist https,tls,tcp,httpproxy,crypto,data -rw_timeout 15000000',
    'ffmpeg_o:-fs ' + 64 * 1024 * 1024,
  ]);
  assert.equal(clipped, 1);
  assert.equal(message.files[0].name, 'cloudy-video.mp4');
});

test('a video that cannot be partly downloaded is downloaded whole and still clipped', async () => {
  const downloads = [];
  let clipped = 0;
  await makeExtractedVideoAttachmentMessage('https://example.org/watch/long', 10_000, {
    runner: async (_binary, args) => {
      if (args.includes('--print')) return '95.2';
      downloads.push(args);
      const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
      await writeFile(output, mp4);
      if (args.includes('--download-sections')) throw new Error('This format cannot be partially downloaded');
    },
    clip: async (input) => { clipped++; return input; },
  });
  assert.equal(downloads.length, 2);
  assert.ok(downloads[0].includes('--download-sections'));
  assert.equal(downloads[1].includes('--download-sections'), false);
  assert.equal(clipped, 1);

  // Unknown length: download as before, the clip step measures it locally.
  downloads.length = 0;
  await makeExtractedVideoAttachmentMessage('https://example.org/watch/unknown', 10_000, {
    runner: async (_binary, args) => {
      if (args.includes('--print')) throw new Error('extractor failed');
      downloads.push(args);
      await writeFile(args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4'), mp4);
    },
    clip: async (input) => input,
  });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].includes('--download-sections'), false);
});

test('direct video files are clipped before upload too', async () => {
  const clipped = Buffer.alloc(32);
  clipped.write('ftyp', 4, 'ascii');
  const message = await makeVideoAttachmentMessage('https://cdn.example.org/a.webm', 100,
    async () => ({ buffer: mp4, extension: 'mp4' }),
    async (buffer, extension, limit) => {
      assert.deepEqual(buffer, mp4);
      assert.equal(extension, 'mp4');
      assert.equal(limit, 100);
      return { buffer: clipped, extension: 'mp4' };
    });
  assert.deepEqual(message.files[0].attachment, clipped);

  const kept = await clipVideoBuffer(mp4, 'mp4', 100, async input => input);
  assert.deepEqual(kept, { buffer: mp4, extension: 'mp4' });
});

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(binary =>
  spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0);

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  return Number(result.stdout.trim());
}

test('real ffmpeg: a 30-second video becomes 10 seconds, a 6-second one is unchanged',
  { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-clip-real-'));
    try {
      const make = (name, seconds) => {
        const file = path.join(directory, name);
        const result = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=' + seconds,
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + seconds,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file]);
        assert.equal(result.status, 0);
        return file;
      };
      const long = make('long.mp4', 30);
      const output = await clipVideoFile(long, path.join(directory, 'clip.mp4'), 10 * 1024 * 1024);
      assert.equal(output, path.join(directory, 'clip.mp4'));
      assert.ok(Math.abs(probe(output) - 10) < 0.3, 'clip lasts 10 seconds, got ' + probe(output));

      const short = make('short.mp4', 6);
      assert.equal(await clipVideoFile(short, path.join(directory, 'short-clip.mp4'), 10 * 1024 * 1024), short);

      const buffer = await readFile(long);
      const clipped = await clipVideoBuffer(buffer, 'mp4', 10 * 1024 * 1024);
      assert.equal(clipped.extension, 'mp4');
      assert.ok(clipped.buffer.length < buffer.length);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
