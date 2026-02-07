'use client';

import { useRef, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useAuthStore } from '@/lib/store';

function profileTriggerClass(active: boolean): string {
  const base =
    'flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition focus:outline-none focus:ring-2 focus:ring-primary-500';
  if (active) {
    return (
      base +
      ' text-[#3b82f6] bg-[rgba(59,130,246,0.12)] dark:bg-[rgba(59,130,246,0.12)] font-semibold ' +
      'ring-1 ring-[#3b82f6]/20 dark:ring-[#3b82f6]/30'
    );
  }
  return (
    base +
    ' text-gray-700 dark:text-dark-text-primary ' +
    'hover:bg-[rgba(0,0,0,0.05)] dark:hover:bg-[rgba(255,255,255,0.06)]'
  );
}

export default function UserMenu({ pathname = '' }: { pathname?: string }) {
  const { user, logout } = useAuthStore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  const profileActive = pathname === '/settings' || pathname.startsWith('/settings') || pathname === '/history';

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  const handleLogout = () => {
    setOpen(false);
    logout();
    router.replace('/login');
  };

  if (!user) return null;

  const initial = (user.username || 'U').charAt(0).toUpperCase();

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={profileTriggerClass(profileActive)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 dark:bg-dark-secondary text-primary-700 dark:text-primary-400 font-semibold text-sm"
          aria-hidden
        >
          {initial}
        </span>
        <span className="text-sm font-medium max-w-[120px] truncate">{user.username}</span>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-500 dark:text-dark-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-card shadow-lg py-1 z-50"
          role="menu"
        >
          <Link
            href="/settings"
            className="block px-4 py-2.5 text-sm text-gray-700 dark:text-dark-text-primary hover:bg-gray-100 dark:hover:bg-dark-card-hover"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <Link
            href="/history"
            className="block px-4 py-2.5 text-sm text-gray-700 dark:text-dark-text-primary hover:bg-gray-100 dark:hover:bg-dark-card-hover"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            History
          </Link>
          <Link
            href="/faq"
            className="block px-4 py-2.5 text-sm text-gray-700 dark:text-dark-text-primary hover:bg-gray-100 dark:hover:bg-dark-card-hover"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            F.A.Q.
          </Link>
          <Link
            href="/support"
            className="block px-4 py-2.5 text-sm text-gray-700 dark:text-dark-text-primary hover:bg-gray-100 dark:hover:bg-dark-card-hover"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Support
          </Link>

          <div className="border-t border-gray-100 dark:border-[rgba(255,255,255,0.08)] my-1" />
          <div className="px-4 py-2">
            <p className="text-xs font-semibold text-gray-500 dark:text-dark-text-muted uppercase tracking-wide mb-2">
              Theme
            </p>
            <div className="flex rounded-lg bg-gray-100 dark:bg-dark-secondary p-0.5" role="group">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setTheme(t);
                  }}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition ${
                    theme === t
                      ? 'bg-white dark:bg-dark-card-hover text-primary-600 dark:text-primary-400 shadow-sm'
                      : 'text-gray-600 dark:text-dark-text-secondary hover:text-gray-900 dark:hover:text-dark-text-primary'
                  }`}
                >
                  {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-gray-100 dark:border-[rgba(255,255,255,0.08)] my-1" />
          <button
            type="button"
            onClick={handleLogout}
            className="block w-full text-left px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-dark-card-hover"
            role="menuitem"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
