import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import axios from 'axios';

const MIN_VIDEO_SECONDS = 1;
const MAX_VIDEO_SECONDS = 6;
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const MAX_GIF_BYTES = 9 * 1024 * 1024;

function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-1500)}`));
        });
    });
}

async function downloadToFile(url, outputPath) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
    });

    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
        throw new Error('Video file is too large to convert.');
    }

    await fs.writeFile(outputPath, buffer);
}

async function getDurationSeconds(inputPath) {
    const { stdout } = await runProcess('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath,
    ]);

    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read video duration.');
    return duration;
}

// Favour sharp frames, smooth animation and all 256 available GIF colours.
// Preserve original uploaded GIF files untouched; these presets only apply
// when the owner explicitly uploads a video for conversion to an embed GIF.
export const VIDEO_GIF_QUALITY_PRESETS = Object.freeze([
    // Try full-size, smooth animation first. Only lower fidelity when the
    // actual GIF exceeds the safe Discord upload limit (9 MiB).
    { width: 1280, fps: 30 },
    { width: 1080, fps: 26 },
    { width: 960, fps: 24 },
    { width: 960, fps: 20 },
    { width: 800, fps: 18 },
    { width: 720, fps: 16 },
    { width: 640, fps: 15 },
    { width: 540, fps: 12 },
    { width: 480, fps: 10 },
    { width: 400, fps: 8 },
    { width: 320, fps: 6 },
]);

export function videoGifPaletteFilter(width, fps) {
    return `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`;
}

async function renderGif(inputPath, outputPath, width, fps) {
    const filter = videoGifPaletteFilter(width, fps);
    await runProcess('ffmpeg', [
        '-y',
        '-i', inputPath,
        '-vf', filter,
        '-loop', '0',
        outputPath,
    ]);
}

// An oversized high-quality GIF used to trigger all lower-quality presets
// sequentially (up to 11 expensive ffmpeg renders). Binary-search the
// remaining presets to find the highest fidelity that fits in ~4-5 attempts.
export async function selectFittingVideoGif(renderAttempt, {
    presets = VIDEO_GIF_QUALITY_PRESETS,
    maxBytes = MAX_GIF_BYTES,
} = {}) {
    let left = 0;
    let right = presets.length - 1;
    let best = null;
    let initial = true;
    while (left <= right) {
        // The first attempt always uses the highest-quality source preset.
        const index = initial ? 0 : Math.floor((left + right) / 2);
        initial = false;
        const buffer = await renderAttempt(presets[index], index);
        if (buffer?.length <= maxBytes) {
            best = buffer;
            right = index - 1;
        } else {
            left = index + 1;
        }
    }
    return best;
}

export async function convertVideoUrlToGif(videoUrl) {
    const id = randomUUID();
    const inputPath = path.join(os.tmpdir(), `cloudy-${id}.video`);
    const outputPath = path.join(os.tmpdir(), `cloudy-${id}.gif`);

    try {
        await downloadToFile(videoUrl, inputPath);
        const duration = await getDurationSeconds(inputPath);

        if (duration < MIN_VIDEO_SECONDS || duration > MAX_VIDEO_SECONDS) {
            const error = new Error(`Video must be between ${MIN_VIDEO_SECONDS} and ${MAX_VIDEO_SECONDS} seconds long.`);
            error.code = 'VIDEO_DURATION_OUT_OF_RANGE';
            throw error;
        }

        const gifBuffer = await selectFittingVideoGif(async attempt => {
            await renderGif(inputPath, outputPath, attempt.width, attempt.fps);
            return fs.readFile(outputPath);
        });

        if (!gifBuffer || gifBuffer.length > MAX_GIF_BYTES) {
            const error = new Error('Converted GIF is too large for the embed. Try a lower-resolution video.');
            error.code = 'GIF_TOO_LARGE';
            throw error;
        }

        return {
            buffer: gifBuffer,
            duration,
            filename: `cloudy-video-${id}.gif`,
        };
    } finally {
        await fs.rm(inputPath, { force: true }).catch(() => {});
        await fs.rm(outputPath, { force: true }).catch(() => {});
    }
}
