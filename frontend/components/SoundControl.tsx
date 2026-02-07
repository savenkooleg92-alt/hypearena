'use client';

import { useState, useRef, useEffect } from 'react';
import { useSoundStore, getSoundIconState, SOUND_VOLUME_MIN, SOUND_VOLUME_MAX } from '@/lib/soundStore';

function SoundIcon({ state }: { state: 'muted' | 'low' | 'high' }) {
  if (state === 'muted') {
    return (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
      </svg>
    );
  }
  if (state === 'low') {
    return (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M12 6a8 8 0 010 12M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
    </svg>
  );
}

export default function SoundControl() {
  const enabled = useSoundStore((s) => s.enabled);
  const volume = useSoundStore((s) => s.volume);
  const setEnabled = useSoundStore((s) => s.setEnabled);
  const setVolume = useSoundStore((s) => s.setVolume);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('click', onOutside);
    return () => document.removeEventListener('click', onOutside);
  }, [open]);

  const iconState = getSoundIconState();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="p-2 rounded-lg text-gray-600 dark:text-dark-text-secondary hover:bg-[rgba(0,0,0,0.05)] dark:hover:bg-[rgba(255,255,255,0.06)] hover:text-gray-900 dark:hover:text-dark-text-primary transition"
        aria-label={enabled ? 'Sound on' : 'Sound off'}
        aria-expanded={open}
      >
        <SoundIcon state={iconState} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 rounded-xl bg-white dark:bg-dark-card shadow-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)] p-4 z-50">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-900 dark:text-dark-text-primary">Sound</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                enabled ? 'bg-primary-600 border-primary-600' : 'bg-gray-200 dark:bg-dark-secondary border-gray-300 dark:border-[rgba(255,255,255,0.08)]'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                  enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-dark-text-muted mb-2">
              Volume {volume}%
            </label>
            <input
              type="range"
              min={SOUND_VOLUME_MIN}
              max={SOUND_VOLUME_MAX}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-full h-2 rounded-full appearance-none bg-gray-200 dark:bg-dark-secondary accent-primary-600"
            />
          </div>
        </div>
      )}
    </div>
  );
}
