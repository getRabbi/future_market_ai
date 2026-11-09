import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/** Probe bounded local bytes, never provider URLs. ffprobe must be installed on the worker. */
export async function probeGeneratedVideo(bytes: Uint8Array) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fg-video-qa-'));
  try {
    const file = path.join(dir, 'output.mp4');
    await writeFile(file, bytes);
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 20_000, maxBuffer: 256_000, windowsHide: true });
    const data = JSON.parse(stdout) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    const videos = data.streams?.filter((s) => s.codec_type === 'video') ?? [];
    const v = videos[0];
    if (videos.length !== 1 || v?.codec_name !== 'h264' || !v.width || !v.height || data.streams?.some((s) => s.codec_type !== 'video')) throw new Error('Output must contain exactly one H.264 video stream and no audio or auxiliary streams.');
    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid video duration');
    return { width: v.width, height: v.height, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
