'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/lib/store';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, token, authVerified } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!token) {
      router.replace('/login');
      return;
    }
    if (!authVerified) return;
    if (user === null) {
      router.replace('/login');
      return;
    }
    if (user.isAdmin === false) {
      router.replace('/');
    }
  }, [token, authVerified, user, router]);

  const authLoading = Boolean(token && !authVerified);
  if (!token || authLoading || (authVerified && user === null)) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <div className="flex items-center gap-2 text-gray-600 dark:text-dark-text-secondary">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
          <span>{authLoading ? 'Checking auth…' : 'Redirecting…'}</span>
        </div>
      </div>
    );
  }
  if (user.isAdmin !== true) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  const nav = [
    { href: '/admin', label: 'Dashboard' },
    { href: '/admin/markets/create', label: 'Create Battle' },
    { href: '/admin/markets', label: 'Markets' },
    { href: '/admin/markets/awaiting', label: 'Matches awaiting confirmation' },
    { href: '/admin/markets/resolved', label: 'Resolved' },
    { href: '/admin/markets/pending', label: 'Pending' },
    { href: '/admin/bets', label: 'Bets' },
    { href: '/admin/deposits', label: 'Deposits' },
    { href: '/admin/withdrawals', label: 'Withdrawals' },
    { href: '/admin/support', label: 'Support Tickets' },
    { href: '/admin/oracle', label: 'Oracle' },
    { href: '/admin/roulette', label: 'Roulette' },
  ];

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="flex gap-6">
        <aside className="w-48 shrink-0">
          <h2 className="text-lg font-bold text-gray-900 dark:text-dark-text-primary mb-4">Admin</h2>
          <nav className="flex flex-col gap-1">
            {nav.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-3 py-2 rounded-lg text-sm transition ${
                  pathname === href
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-700 dark:text-dark-text-primary hover:bg-gray-100 dark:hover:bg-dark-card-hover'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
