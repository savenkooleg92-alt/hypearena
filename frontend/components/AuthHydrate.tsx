'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { useLoadingStore } from '@/lib/loadingStore';
import { setAuthCookie, clearAuthCookie } from '@/lib/authCookie';
import { usersAPI } from '@/lib/api';

const PUBLIC_PATHS = ['/login', '/register', '/terms', '/privacy', '/faq'];
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Single source of truth: user is authenticated ONLY if GET /users/me returns 200.
 * Syncs token to cookie. No token + verified → redirect to /login?from=currentPath so refresh keeps user on same page.
 */
export default function AuthHydrate() {
  const pathname = usePathname();
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const setUser = useAuthStore((s) => s.setUser);
  const setAuthVerified = useAuthStore((s) => s.setAuthVerified);
  const logout = useAuthStore((s) => s.logout);
  const setLoading = useLoadingStore((s) => s.setLoading);
  const setError = useLoadingStore((s) => s.setError);

  useEffect(() => {
    if (token) setAuthCookie(token);
    else clearAuthCookie();
  }, [token]);

  useEffect(() => {
    setLoading(true);
    if (!token) {
      useAuthStore.setState({ user: null, authVerified: true });
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      useAuthStore.setState({ authVerified: true });
      setError('Сервер не ответил вовремя. Проверьте, что бэкенд запущен (например, порт 3001).');
    }, 8000);

    usersAPI
      .getMe()
      .then((res) => {
        if (cancelled) return;
        const u = res.data;
        setUser({
          id: u.id,
          email: u.email,
          username: u.username,
          balance: u.balance,
          isAdmin: u.isAdmin === true,
          isAnonymous: u.isAnonymous === true,
          createdAt: u.createdAt,
        });
        setAuthVerified(true);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = err.response?.status;
        const isNetwork = err.code === 'ERR_NETWORK' || err.message?.includes('Network Error');
        if (status === 401 || status === 403) {
          logout();
          setLoading(false);
          if (!isPublicPath(pathname)) {
            router.replace(`/login?from=${encodeURIComponent(pathname)}`);
          }
          return;
        }
        useAuthStore.setState({ authVerified: true });
        if (status === 404) {
          setError('Сервер не найден (404). Проверьте URL бэкенда и что он запущен.');
        } else if (isNetwork) {
          setError('Нет связи с сервером. Запущен ли бэкенд? (например, npm run dev в папке backend)');
        } else {
          setError(err.response?.data?.message || `Ошибка: ${status || err.message || 'неизвестная'}`);
        }
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [token, setUser, setAuthVerified, logout, setLoading, setError]);

  // When we have no token and auth is verified, redirect to login but keep current path in ?from= so after login user returns here (fixes refresh throwing to main)
  useEffect(() => {
    if (token !== null) return;
    if (!useAuthStore.getState().authVerified) return;
    if (isPublicPath(pathname ?? '')) return;
    if (pathname === '/login') return;
    router.replace(`/login?from=${encodeURIComponent(pathname ?? '/')}`);
  }, [token, pathname, router]);

  return null;
}
