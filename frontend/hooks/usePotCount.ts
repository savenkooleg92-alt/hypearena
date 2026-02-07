'use client';

import { useState, useEffect, useRef } from 'react';

const DURATION_MS = 600;

/** Returns pot cents that animate from previous to current over DURATION_MS. */
export function usePotCount(potCents: number): number {
  const [display, setDisplay] = useState(potCents);
  const prevRef = useRef(potCents);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (potCents === prevRef.current) return;
    const from = prevRef.current;
    const to = potCents;
    prevRef.current = potCents;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / DURATION_MS, 1);
      const ease = 1 - Math.pow(1 - t, 2);
      setDisplay(Math.round(from + (to - from) * ease));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [potCents]);

  return display;
}
