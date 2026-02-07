'use client';

import { useLayoutEffect, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useLoadingStore } from '@/lib/loadingStore';

/** Shows premium loading overlay on route change (pathname change). Skips initial mount. */
export default function NavigationLoading() {
  const pathname = usePathname();
  const isFirst = useRef(true);
  const setLoading = useLoadingStore((s) => s.setLoading);

  useLayoutEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    setLoading(true);
  }, [pathname, setLoading]);

  useEffect(() => {
    if (isFirst.current) return;
    const t = setTimeout(() => setLoading(false), 380);
    return () => clearTimeout(t);
  }, [pathname, setLoading]);

  return null;
}