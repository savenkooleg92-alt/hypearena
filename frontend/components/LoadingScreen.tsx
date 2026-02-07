'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useLoadingStore } from '@/lib/loadingStore';
import { LogoMark } from '@/components/LogoMark';

const FADE_MS = 350;

export default function LoadingScreen() {
  const { loading, message } = useLoadingStore();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const error = useLoadingStore((s) => s.error);
  const setError = useLoadingStore((s) => s.setError);

  useEffect(() => {
    if (!mounted) return;
    if (loading || error) {
      setFadeOut(false);
      setVisible(true);
      return;
    }
    if (visible) {
      setFadeOut(true);
      const t = setTimeout(() => {
        setVisible(false);
        setFadeOut(false);
      }, FADE_MS);
      return () => clearTimeout(t);
    }
  }, [loading, error, mounted, visible]);

  if (!mounted) return null;
  if (!loading && !visible && !error) return null;

  const isDark = resolvedTheme === 'dark';
  const textColor = isDark ? 'rgba(226, 232, 240, 0.9)' : 'rgba(51, 65, 85, 0.9)';

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-6 transition-opacity duration-[350ms] ease-out safe-area-padding isolate"
      style={{
        opacity: fadeOut && !error ? 0 : 1,
        pointerEvents: loading || error ? 'auto' : 'none',
        background: isDark
          ? 'radial-gradient(ellipse at center, #0f172a 0%, #020617 70%)'
          : 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)',
        boxShadow: isDark ? 'inset 0 0 120px rgba(59, 130, 246, 0.06)' : undefined,
        transform: 'translateZ(0)',
      }}
      aria-hidden={!loading && !error}
      aria-busy={loading}
      role={error ? 'alert' : undefined}
    >
      {error ? (
        <>
          <p className="text-center text-sm font-medium max-w-md px-4" style={{ color: textColor }}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            Закрыть
          </button>
        </>
      ) : (
        <>
          <div
            className="flex items-center justify-center animate-spin border-0 outline-none ring-0"
            style={{ background: 'transparent', boxShadow: 'none' }}
            role="progressbar"
            aria-valuetext="Loading"
          >
            <LogoMark width={80} height={80} className="h-16 w-16 sm:h-20 sm:w-20 pointer-events-none" />
          </div>
          {message && (
            <p className="text-sm font-medium" style={{ color: textColor }}>
              {message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
