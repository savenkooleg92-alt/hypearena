'use client';

import { useState, useEffect, useRef } from 'react';

const DURATION_MS = 400;

/** Returns a value that animates from previous to current balance over 400ms. */
export function useBalanceCount(balance: number): number {
  const [display, setDisplay] = useState(balance);
  const prevRef = useRef(balance);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (balance === prevRef.current) return;
    const from = prevRef.current;
    const to = balance;
    prevRef.current = balance;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / DURATION_MS, 1);
      const ease = 1 - Math.pow(1 - t, 2);
      setDisplay(from + (to - from) * ease);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [balance]);

  return display;
}
