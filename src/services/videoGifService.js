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

async function renderGif(inputPath, outputPath, width, fps) {
    const filter = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
    await runProcess('ffmpeg', [
        '-y',
        '-i', inputPath,
        '-vf', filter,
        '-loop', '0',
        outputPath,
    ]);
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

        const attempts = [
            { width: 640, fps: 12 },
            { width: 540, fps: 10 },
            { width: 480, fps: 8 },
            { width: 400, fps: 7 },
            { width: 320, fps: 6 },
        ];

        let gifBuffer = null;
        for (const attempt of attempts) {
            await renderGif(inputPath, outputPath, attempt.width, attempt.fps);
            gifBuffer = await fs.readFile(outputPath);
            if (gifBuffer.length <= MAX_GIF_BYTES) break;
        }

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
