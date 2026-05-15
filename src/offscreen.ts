/**
 * Offscreen document: synthesizes notification chimes via Web Audio API.
 *
 * MV3 service workers cannot use the Web Audio API directly (no DOM, no
 * AudioContext), so we host an offscreen document and drive it from the
 * background via runtime messages.
 */

import * as message from './common/background';

// "Partial" は TS 組み込み Partial<T> と衝突する名前なのでファイル内に
// 限定して BellPartial に改名している (倍音 = harmonic partial の意)。
interface BellPartial {
  carrierRatio: number; // carrier freq = FUNDAMENTAL_HZ * carrierRatio
  modRatio: number; // modulator freq = carrier * modRatio (non-integer = metallic)
  modIndex: number; // peak FM depth in Hz; decays with the partial envelope
  gain: number;
  decay: number;
}

const FUNDAMENTAL_HZ = 3800;

const PARTIALS: ReadonlyArray<BellPartial> = [
  // 芯（長く、軽く残る）
  { carrierRatio: 1.0, modRatio: 1.0, modIndex: 0.01, gain: 1.0, decay: 2.2 },

  // きらめき
  { carrierRatio: 2.0, modRatio: 1.0, modIndex: 0.01, gain: 0.25, decay: 1.6 },

  // 空気感（消えるのは遅いが音量は小さい）
  { carrierRatio: 3.0, modRatio: 1.0, modIndex: 0.01, gain: 0.12, decay: 1.1 },
];

const ATTACK_SEC = 0.0006; // very short — bell is percussive

const TRANSIENT_SEC = 0.004;
const TRANSIENT_BP_HZ = 12000;
const TRANSIENT_Q = 20;
const TRANSIENT_GAIN = 0.08;

const DEFAULT_VOLUME = 0.6;

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function strikeTransient(
  ctx: AudioContext,
  when: number,
  master: GainNode,
  amp: number,
): void {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * TRANSIENT_SEC);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = TRANSIENT_BP_HZ;
  bp.Q.value = TRANSIENT_Q;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.linearRampToValueAtTime(TRANSIENT_GAIN * amp, when + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0001, when + TRANSIENT_SEC);

  src.connect(bp).connect(env).connect(master);
  src.start(when);
  src.stop(when + TRANSIENT_SEC + 0.01);
}

function strikePartials(
  ctx: AudioContext,
  when: number,
  master: GainNode,
  amp: number,
): void {
  const sumGain = PARTIALS.reduce((acc, p) => acc + p.gain, 0);
  for (const { carrierRatio, modRatio, modIndex, gain, decay } of PARTIALS) {
    const carrierFreq = FUNDAMENTAL_HZ * carrierRatio;
    const modFreq = carrierFreq * modRatio;

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = carrierFreq;

    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = modFreq;

    // Modulation index decays with the partial — bright/metallic at strike,
    // settling toward a pure sine as it rings out.
    const modAmp = ctx.createGain();
    modAmp.gain.setValueAtTime(modIndex, when);
    modAmp.gain.exponentialRampToValueAtTime(0.001, when + decay);
    modulator.connect(modAmp).connect(carrier.frequency);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime((gain / sumGain) * amp, when + ATTACK_SEC);
    env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    carrier.connect(env).connect(master);
    carrier.start(when);
    modulator.start(when);

    carrier.stop(when + decay + 0.4);
    modulator.stop(when + decay + 0.4);
  }
}

function strike(
  ctx: AudioContext,
  when: number,
  master: GainNode,
  amp: number,
): void {
  strikeTransient(ctx, when, master, amp);
  strikePartials(ctx, when, master, amp);
}

async function playChime(volume?: number): Promise<void> {
  const v =
    typeof volume === 'number'
      ? Math.max(0, Math.min(1, volume))
      : DEFAULT_VOLUME;
  if (v === 0) {
    return;
  }
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const start = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = v;
  master.connect(ctx.destination);

  strike(ctx, start, master, 1.0);
}

message.listen<void, [number?]>(message.Type.PlaySound, playChime);
