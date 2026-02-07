'use client';

import { getVolumeMultiplier } from './soundStore';

let audioContext: AudioContext | null = null;
let ambientGain: GainNode | null = null;
let ambientOsc: OscillatorNode | null = null;
let ambientTimeout: ReturnType<typeof setTimeout> | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (getVolumeMultiplier() <= 0) return null;
  if (!audioContext) audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return audioContext;
}

function playTone(options: {
  frequency: number;
  duration: number;
  volumeScale?: number;
  type?: OscillatorType;
  fadeOut?: boolean;
}) {
  const ctx = getContext();
  if (!ctx) return;
  const mul = getVolumeMultiplier();
  if (mul <= 0) return;
  const vol = (options.volumeScale ?? 1) * mul;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = options.frequency;
    osc.type = (options.type as OscillatorType) || 'sine';
    gain.gain.setValueAtTime(0.08 * vol, ctx.currentTime);
    if (options.fadeOut !== false) {
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + options.duration * 0.7);
    }
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + options.duration);
  } catch {
    // ignore
  }
}

let tabVisible = true;
if (typeof document !== 'undefined') {
  playRouletteAmbientStop();
  document.addEventListener('visibilitychange', () => {
    tabVisible = document.visibilityState === 'visible';
    if (!tabVisible) playRouletteAmbientStop();
  });
}

export function playBetConfirm() {
  if (!tabVisible) return;
  playTone({ frequency: 880, duration: 0.08, type: 'sine' });
}

export function playWithdrawSuccess() {
  if (!tabVisible) return;
  playTone({ frequency: 523, duration: 0.1 });
  setTimeout(() => playTone({ frequency: 659, duration: 0.12 }), 80);
}

export function playNewMessage() {
  if (!tabVisible) return;
  playTone({ frequency: 600, duration: 0.06, type: 'sine' });
}

// ——— Roulette ———
export function playRouletteBetPlace() {
  if (!tabVisible) return;
  playTone({ frequency: 440, duration: 0.06, type: 'sine' });
  setTimeout(() => playTone({ frequency: 554, duration: 0.08 }), 40);
}

export function playRouletteNewPlayer() {
  if (!tabVisible) return;
  playTone({ frequency: 700, duration: 0.05, type: 'sine' });
}

export function playRoulettePotIncrease(amountCents: number) {
  if (!tabVisible) return;
  const scale = Math.min(1, 0.3 + (amountCents / 5000)); // scale with amount
  playTone({ frequency: 520, duration: 0.07, volumeScale: scale, type: 'sine' });
}

export function playRouletteCountdownTick() {
  if (!tabVisible) return;
  playTone({ frequency: 400, duration: 0.04, type: 'sine' });
}

export function playRouletteWheelSpin() {
  if (!tabVisible) return;
  playTone({ frequency: 200, duration: 0.15, type: 'sawtooth', volumeScale: 0.5 });
  setTimeout(() => playTone({ frequency: 150, duration: 0.2, type: 'sawtooth', volumeScale: 0.4 }), 100);
}

export function playRouletteWinner() {
  if (!tabVisible) return;
  [523, 659, 784, 1047].forEach((f, i) => {
    setTimeout(() => playTone({ frequency: f, duration: 0.15, type: 'sine' }), i * 120);
  });
}

export function playRouletteLose() {
  if (!tabVisible) return;
  playTone({ frequency: 220, duration: 0.2, volumeScale: 0.4, type: 'sine' });
}

export function playRouletteAmbientStart() {
  if (!tabVisible || getVolumeMultiplier() <= 0) return;
  playRouletteAmbientStop();
  const ctx = getContext();
  if (!ctx) return;
  try {
    const gain = ctx.createGain();
    gain.gain.value = 0.03 * getVolumeMultiplier();
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55;
    osc.connect(gain);
    osc.start(ctx.currentTime);
    ambientGain = gain;
    ambientOsc = osc;
  } catch {
    // ignore
  }
}

export function playRouletteAmbientStop() {
  try {
    if (ambientOsc) {
      ambientOsc.stop();
      ambientOsc = null;
    }
    ambientGain = null;
  } catch {
    // ignore
  }
  if (ambientTimeout) {
    clearTimeout(ambientTimeout);
    ambientTimeout = null;
  }
}
