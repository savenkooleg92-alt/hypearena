'use client';

import { useEffect, useState } from 'react';

const SIZE = 28;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const C = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

interface LiveCountdownCircleProps {
  /** ISO end time (e.g. market.endsAt). If null, circle is hidden or full. */
  endsAt: string | null;
  /** Only show when LIVE */
  isLive: boolean;
  /** Total duration in ms (for progress). If unknown, use a default e.g. 2h. */
  totalDurationMs?: number;
  className?: string;
}

/** Returns seconds remaining until endsAt (server time aligned via optional offset). */
function useSecondsLeft(endsAt: string | null, serverTimeOffsetMs: number = 0): number | null {
  const [sec, setSec] = useState<number | null>(() => {
    if (!endsAt) return null;
    const end = new Date(endsAt).getTime();
    const now = Date.now() + serverTimeOffsetMs;
    const left = Math.max(0, Math.floor((end - now) / 1000));
    return left;
  });

  useEffect(() => {
    if (!endsAt) {
      setSec(null);
      return;
    }
    const end = new Date(endsAt).getTime();
    const tick = () => {
      const now = Date.now() + serverTimeOffsetMs;
      const left = Math.max(0, Math.floor((end - now) / 1000));
      setSec(left);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [endsAt, serverTimeOffsetMs]);

  return sec;
}

export default function LiveCountdownCircle({
  endsAt,
  isLive,
  totalDurationMs = 2 * 60 * 60 * 1000,
  className = '',
}: LiveCountdownCircleProps) {
  const secondsLeft = useSecondsLeft(endsAt);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !isLive) return null;

  const endTime = endsAt ? new Date(endsAt).getTime() : null;
  const now = Date.now();
  const totalMs = endTime ? Math.max(1, endTime - (now - (secondsLeft ?? 0) * 1000)) : totalDurationMs;
  const remainingMs = secondsLeft != null ? secondsLeft * 1000 : 0;
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
  const strokeDashoffset = CIRCUMFERENCE * (1 - progress);

  return (
    <span className={`inline-flex items-center justify-center ${className}`} aria-hidden>
      <svg
        width={SIZE}
        height={SIZE}
        className="rotate-[-90deg]"
        aria-hidden
      >
        <circle
          cx={C}
          cy={C}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-green-500/30 dark:text-green-500/40"
        />
        <circle
          cx={C}
          cy={C}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className="text-green-600 dark:text-dark-live-text transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
    </span>
  );
}
