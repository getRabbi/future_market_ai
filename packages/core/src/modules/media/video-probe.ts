import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Probe bounded local bytes, never provider URLs. ffprobe must be installed on the worker.
 * Generated clips must be silent H.264; imported clips (Google Flow) may carry one AAC/Opus/MP3 audio track.
 */
export async function probeGeneratedVideo(bytes: Uint8Array, opts: { allowAudio?: boolean } = {}): Promise<{ width: number; height: number; seconds: number; hasAudio?: boolean }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fg-video-qa-'));
  try {
    const file = path.join(dir, 'output.mp4');
    await writeFile(file, bytes);
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 20_000, maxBuffer: 256_000, windowsHide: true });
    const data = JSON.parse(stdout) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    const streams = data.streams ?? [];
    const videos = streams.filter((s) => s.codec_type === 'video');
    const audios = streams.filter((s) => s.codec_type === 'audio');
    const v = videos[0];
    const audioOk = opts.allowAudio ? audios.length <= 1 && audios.every((a) => ['aac', 'opus', 'mp3'].includes(a.codec_name ?? '')) : audios.length === 0;
    if (videos.length !== 1 || v?.codec_name !== 'h264' || !v.width || !v.height || !audioOk || streams.some((s) => s.codec_type !== 'video' && s.codec_type !== 'audio')) {
      throw new Error(opts.allowAudio ? 'Video must contain exactly one H.264 video stream, at most one AAC/Opus/MP3 audio stream and no auxiliary streams.' : 'Output must contain exactly one H.264 video stream and no audio or auxiliary streams.');
    }
    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid video duration');
    return { width: v.width, height: v.height, seconds, hasAudio: audios.length > 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
