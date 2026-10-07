'use strict';

/**
 * ffmpeg/ffprobe helpers: find the binaries, probe a file, decide how the
 * browser can play it, and spawn the remux/transcode + subtitle processes.
 *
 * Playback modes:
 *  - direct    : MP4/WebM the browser decodes natively -> raw byte-range stream
 *  - remux     : video codec is fine but the container (MKV/AVI) or audio (AC3,
 *                DTS, …) isn't -> ffmpeg copies the video, converts audio to AAC,
 *                and streams fragmented MP4 (cheap: no video re-encode)
 *  - transcode : the video codec itself can't play (e.g. HEVC on Firefox, XviD)
 *                -> ffmpeg re-encodes to H.264 (CPU heavy, height-capped)
 */

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

function works(bin) {
  try {
    const r = spawnSync(bin, ['-version'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// FFMPEG_PATH/FFPROBE_PATH, else the system binary (PATH), else the npm package.
function findBinary(envName, cmd, pkg) {
  const fromEnv = (process.env[envName] || '').trim();
  if (fromEnv && works(fromEnv)) return fromEnv;
  if (works(cmd)) return cmd;
  try {
    const p = require(pkg).path;
    if (p && fs.existsSync(p) && works(p)) return p;
  } catch (_) { /* optional dependency not installed */ }
  return null;
}

function detect() {
  return {
    ffmpeg: findBinary('FFMPEG_PATH', 'ffmpeg', '@ffmpeg-installer/ffmpeg'),
    ffprobe: findBinary('FFPROBE_PATH', 'ffprobe', '@ffprobe-installer/ffprobe'),
  };
}

function probe(ffprobe, url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
      '-probesize', '10000000', url];
    const p = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('Timed out reading the video file (the torrent may be too slow).'));
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 4e6) p.kill('SIGKILL'); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const last = err.trim().split('\n').pop();
        return reject(new Error(last ? `Couldn't read the video: ${last}` : `ffprobe exited with ${code}`));
      }
      try { resolve(JSON.parse(out)); } catch (_) { reject(new Error('Unreadable ffprobe output')); }
    });
  });
}

/**
 * Time of the video keyframe that seeking to `t` lands on. Copying video
 * (remux) can only start on a keyframe, so the player starts there exactly and
 * knows the real position (subtitles stay in sync).
 */
function keyframeAt(ffprobe, url, t, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${t.toFixed(3)}%+#1`,
      '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json', url];
    const p = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(null); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const pkt = (JSON.parse(out).packets || [])[0];
        const k = pkt ? Number(pkt.pts_time ?? pkt.dts_time) : NaN;
        resolve(Number.isFinite(k) && k >= 0 && /K/.test(pkt.flags || '') ? k : null);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

const tagOf = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '';

/** Normalize ffprobe JSON into what the player needs. */
function describe(info, ext) {
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const fmt = info.format || {};
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const duration = Number(fmt.duration) ||
    Math.max(0, ...streams.map((s) => Number(s.duration) || 0)) || null;
  return {
    duration,
    format: String(fmt.format_name || ''),
    ext: String(ext || '').toLowerCase(),
    video: v ? {
      index: v.index,
      codec: v.codec_name || '',
      profile: v.profile || '',
      pixFmt: v.pix_fmt || '',
      width: v.width || 0,
      height: v.height || 0,
      tenBit: /p1[02]/.test(v.pix_fmt || '') || /high 10|main 10/i.test(v.profile || ''),
    } : null,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({
      index: s.index,
      codec: s.codec_name || '',
      channels: s.channels || 0,
      lang: tagOf(s, 'language'),
      title: tagOf(s, 'title').slice(0, 80),
      default: Boolean(s.disposition && s.disposition.default),
    })),
    subs: streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({
      index: s.index,
      codec: s.codec_name || '',
      lang: tagOf(s, 'language'),
      title: tagOf(s, 'title').slice(0, 80),
      default: Boolean(s.disposition && s.disposition.default),
      forced: Boolean(s.disposition && s.disposition.forced),
      text: TEXT_SUBS.has(s.codec_name),
    })),
  };
}

function videoPlayable(v, caps) {
  if (!v) return false;
  switch (v.codec) {
    case 'h264': return !v.tenBit && !/4:4:4|4:2:2/i.test(v.profile);
    case 'hevc': return caps.has('hevc');
    case 'av1': return caps.has('av1');
    case 'vp9': return caps.has('vp9');
    case 'vp8': return true;
    default: return false;
  }
}
// Audio the browser plays inside the original file.
function audioDirect(codec, caps, container) {
  if (codec === 'aac' || codec === 'mp3') return true;
  if (codec === 'opus' || codec === 'vorbis') return container === 'webm' || caps.has('opus');
  if (codec === 'flac') return caps.has('flac');
  if (codec === 'ac3' || codec === 'eac3') return caps.has(codec);
  return false;
}
// Audio we can copy into the fragmented MP4 (old ffmpeg builds treat Opus/FLAC-in-MP4 as experimental).
function audioCopyable(codec, caps) {
  return codec === 'aac' || codec === 'mp3' || ((codec === 'ac3' || codec === 'eac3') && caps.has(codec));
}

// The release's own default track (usually the original language); viewers can switch.
function defaultAudio(desc) {
  const a = desc.audio;
  if (!a.length) return null;
  return a.find((x) => x.default) || a[0];
}

/**
 * Decide how to play. opts: { audioIndex, transcode (bool), haveFfmpeg }
 * -> { mode, audio, audioCopy, reason }
 */
function plan(desc, caps, opts = {}) {
  if (!desc.video) return { mode: 'unsupported', reason: 'No video stream found in this file.' };
  const chosen = desc.audio.find((x) => x.index === opts.audioIndex) || defaultAudio(desc);
  const container = (/^(mp4|m4v|mov)$/.test(desc.ext) && /mp4|mov/.test(desc.format)) ? 'mp4'
    : (desc.ext === 'webm' && /webm/.test(desc.format) ? 'webm' : 'other');
  const vOk = videoPlayable(desc.video, caps);
  const firstAudio = desc.audio[0] || null;
  const direct = container !== 'other' && vOk &&
    (!chosen || (chosen === firstAudio && audioDirect(chosen.codec, caps, container)));
  const audio = chosen ? chosen.index : null;
  if (direct) return { mode: 'direct', audio };
  if (!opts.haveFfmpeg) {
    return { mode: 'unsupported', audio, reason: 'This file needs converting, but ffmpeg isn\'t installed on the server.' };
  }
  if (vOk) return { mode: 'remux', audio, audioCopy: chosen ? audioCopyable(chosen.codec, caps) : false };
  if (opts.transcode) return { mode: 'transcode', audio, audioCopy: chosen ? (chosen.codec === 'aac' || chosen.codec === 'mp3') : false };
  const name = (desc.video.codec || 'This').toUpperCase() + (desc.video.tenBit ? ' 10-bit' : '');
  return { mode: 'unsupported', audio, reason: `${name} video can't play in this browser and transcoding is turned off.` };
}

/** Fragmented-MP4 stream of the file starting at `t` seconds. */
function spawnPlay(ffmpeg, input, o) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (o.t > 0) args.push('-ss', o.t.toFixed(3));
  args.push('-fflags', '+genpts', '-probesize', '10000000', '-i', input);
  args.push('-map', `0:${o.videoIndex}`);
  if (o.audioIndex != null) args.push('-map', `0:${o.audioIndex}`);
  if (o.videoCopy) {
    args.push('-c:v', 'copy');
    if (o.videoCodec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', '23',
      '-maxrate', '5M', '-bufsize', '10M', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-vf', `scale=-2:'min(${o.height || 720},ih)'`, '-g', '48', '-keyint_min', '48');
  }
  if (o.audioIndex != null) {
    if (o.audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-max_muxing_queue_size', '2048', '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  return spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * One embedded text subtitle track as WebVTT, read from `t` seconds on.
 * -copyts keeps cue times absolute (time in the file), whatever `t` is.
 */
function spawnSubs(ffmpeg, input, o) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (o.t > 0) args.push('-ss', o.t.toFixed(2));
  args.push('-probesize', '10000000', '-i', input, '-copyts', '-map', `0:${o.streamIndex}`,
    '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1');
  return spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A whole subtitle file (ASS/SSA/SRT) converted to WebVTT. */
function spawnSubFile(ffmpeg, input) {
  return spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-f', 'webvtt', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** SRT -> WebVTT without ffmpeg (handles non-UTF-8 files too). */
function srtToVtt(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { text = new TextDecoder('windows-1252').decode(buf); }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const body = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body.trim() + '\n';
}

module.exports = {
  detect, probe, keyframeAt, describe, plan, defaultAudio, videoPlayable, audioCopyable,
  spawnPlay, spawnSubs, spawnSubFile, srtToVtt, TEXT_SUBS,
};
