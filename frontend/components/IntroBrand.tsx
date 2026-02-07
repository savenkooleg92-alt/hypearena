'use client';

import { useEffect, useState, useRef } from 'react';
import { useTheme } from 'next-themes';
import { LogoMark } from '@/components/LogoMark';

const INTRO_STORAGE_KEY = 'hype_intro_seen';

const STEP1_MS = 300;
const STEP2_MS = 600;
const STEP3_MS = 800;
const STEP4_MS = 320;
const TOTAL_MS = STEP1_MS + STEP2_MS + STEP3_MS + STEP4_MS;

type Step = 'idle' | 'darken' | 'logo' | 'glow' | 'exit' | 'done';

export default function IntroBrand() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [visible, setVisible] = useState(false);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || typeof window === 'undefined') return;
    if (localStorage.getItem(INTRO_STORAGE_KEY) === 'true') {
      setStep('done');
      return;
    }
    setVisible(true);
    setStep('darken');

    const t1 = setTimeout(() => setStep('logo'), STEP1_MS);
    const t2 = setTimeout(() => setStep('glow'), STEP1_MS + STEP2_MS);
    const t3 = setTimeout(() => setStep('exit'), STEP1_MS + STEP2_MS + STEP3_MS);
    const t4 = setTimeout(() => {
      localStorage.setItem(INTRO_STORAGE_KEY, 'true');
      setStep('done');
      setVisible(false);
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
    }, TOTAL_MS);

    timeoutsRef.current = [t1, t2, t3, t4];
    return () => timeoutsRef.current.forEach(clearTimeout);
  }, [mounted]);

  if (!mounted || !visible || step === 'done') return null;

  const isDark = resolvedTheme === 'dark';
  const showOverlay = step !== 'idle' && step !== 'done';
  const showLogo = step === 'logo' || step === 'glow' || step === 'exit';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-auto"
      aria-hidden="true"
    >
      {/* Step 1: darken (300ms) */}
      {showOverlay && (
        <div
          className={`absolute inset-0 ${step === 'darken' ? 'animate-intro-overlay' : ''}`}
          style={{
            background: isDark
              ? 'radial-gradient(ellipse at center, #0f172a 0%, #020617 80%)'
              : 'linear-gradient(180deg, #0c0c0c 0%, #1a1a1a 100%)',
            opacity: step === 'darken' ? undefined : 1,
          }}
        />
      )}

      {/* Steps 2–4: logo */}
      {showLogo && (
        <div
          className={`relative flex items-center justify-center ${
            step === 'logo' ? 'animate-intro-logo-in' : step === 'exit' ? 'animate-intro-logo-exit' : ''
          }`}
          style={{
            opacity: step === 'glow' ? 1 : undefined,
            transform: step === 'glow' ? 'scale(1)' : undefined,
          }}
        >
          <div
            className="relative rounded-full p-2 bg-transparent transition-[box-shadow] duration-500 ease-out"
            style={{
              boxShadow:
                step === 'glow' || step === 'exit'
                  ? isDark
                    ? '0 0 80px rgba(59, 130, 246, 0.25), 0 0 160px rgba(59, 130, 246, 0.12)'
                    : '0 0 60px rgba(59, 130, 246, 0.2), 0 0 120px rgba(59, 130, 246, 0.1)'
                  : 'none',
            }}
          >
            <LogoMark width={128} height={128} className="h-24 w-24 sm:h-[7.25rem] sm:w-[7.25rem] pointer-events-none" priority />
          </div>
        </div>
      )}
    </div>
  );
}
