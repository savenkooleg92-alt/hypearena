import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as soundEngine from './soundEngine';

export const SOUND_VOLUME_MIN = 0;
export const SOUND_VOLUME_MAX = 100;
const DEFAULT_VOLUME = 70;

interface SoundState {
  enabled: boolean;
  volume: number; // 0–100
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
}

export const useSoundStore = create<SoundState>()(
  persist(
    (set) => ({
      enabled: false,
      volume: DEFAULT_VOLUME,
      setEnabled: (enabled) => set({ enabled }),
      setVolume: (volume) => set({ volume: Math.max(SOUND_VOLUME_MIN, Math.min(SOUND_VOLUME_MAX, volume)) }),
    }),
    {
      name: 'hype-sound',
      partialize: (s) => ({ volume: s.volume }),
    }
  )
);

/** 0–1 multiplier from store (0 when muted). */
export function getVolumeMultiplier(): number {
  const { enabled, volume } = useSoundStore.getState();
  if (!enabled) return 0;
  return volume / 100;
}

/** Icon state: 'muted' | 'low' | 'high'. */
export function getSoundIconState(): 'muted' | 'low' | 'high' {
  const { enabled, volume } = useSoundStore.getState();
  if (!enabled) return 'muted';
  return volume < 50 ? 'low' : 'high';
}

/** Play bet confirm sound (markets). */
export function playBetConfirm() {
  soundEngine.playBetConfirm();
}

/** Play withdraw success sound. */
export function playWithdrawSuccess() {
  soundEngine.playWithdrawSuccess();
}

/** Play new message sound (chat). */
export function playNewMessage() {
  soundEngine.playNewMessage();
}

// ——— Roulette sounds (called from roulette page / soundEngine) ———
export function playRouletteBetPlace() {
  soundEngine.playRouletteBetPlace();
}
export function playRouletteNewPlayer() {
  soundEngine.playRouletteNewPlayer();
}
export function playRoulettePotIncrease(amountCents: number) {
  soundEngine.playRoulettePotIncrease(amountCents);
}
export function playRouletteCountdownTick() {
  soundEngine.playRouletteCountdownTick();
}
export function playRouletteWheelSpin() {
  soundEngine.playRouletteWheelSpin();
}
export function playRouletteWinner() {
  soundEngine.playRouletteWinner();
}
export function playRouletteLose() {
  soundEngine.playRouletteLose();
}
export function playRouletteAmbientStart() {
  soundEngine.playRouletteAmbientStart();
}
export function playRouletteAmbientStop() {
  soundEngine.playRouletteAmbientStop();
}
