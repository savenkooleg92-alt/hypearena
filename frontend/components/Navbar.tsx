'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { useLoadingStore } from '@/lib/loadingStore';
import UserMenu from '@/components/UserMenu';
import { LogoMark } from '@/components/LogoMark';

/** Active when pathname is / or markets list or market detail (not /markets/create). */
function isArenaActive(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname === '/markets') return true;
  if (pathname.startsWith('/markets/') && pathname !== '/markets/create') return true;
  return false;
}

function navLinkClass(active: boolean): string {
  const base = 'px-4 py-2 rounded-lg transition text-sm font-medium border-b-2 border-transparent';
  if (active) {
    return (
      base +
      ' text-[#3b82f6] dark:text-primary-400 font-semibold ' +
      'bg-[rgba(59,130,246,0.14)] dark:bg-[rgba(59,130,246,0.14)] ' +
      'border-[#3b82f6] dark:border-primary-400'
    );
  }
  return (
    base +
    ' text-gray-700 dark:text-dark-text-primary ' +
    'hover:bg-[rgba(0,0,0,0.05)] dark:hover:bg-[rgba(255,255,255,0.06)]'
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const { user, token, authVerified } = useAuthStore();
  const globalLoading = useLoadingStore((s) => s.loading);

  const authLoading = Boolean(token && !authVerified) && !globalLoading;
  const isAuthenticated = authVerified && user !== null;

  const arenaActive = isArenaActive(pathname ?? '');
  const walletActive = pathname === '/wallet';
  const rouletteActive = pathname === '/roulette';

  return (
    <nav className="bg-white dark:bg-dark-card shadow-sm border-b border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center h-16">
          <Link
            href="/"
            className="group flex items-center gap-2 sm:gap-3 transition-all duration-[220ms] ease-out hover:scale-105 active:scale-[0.98] rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:focus-visible:ring-primary-400/50"
            aria-label="Arena – main markets"
          >
            <LogoMark width={40} height={40} className="h-8 w-8 sm:h-9 sm:w-9 group-hover:opacity-90 transition-opacity flex-shrink-0" />
            <span className="text-xl font-semibold text-primary-600 dark:text-primary-400 hidden sm:inline leading-none">
              HYPE ARENA
            </span>
          </Link>

          <div className="flex items-center gap-2 sm:gap-4">
            {authLoading ? (
              <div className="flex items-center gap-2 text-gray-500 dark:text-dark-text-secondary">
                <span className="text-sm">Loading…</span>
              </div>
            ) : isAuthenticated ? (
              <>
                <Link
                  href="/markets/create"
                  className="px-4 py-2 bg-primary-600 dark:bg-primary-500 text-white rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 transition text-sm font-medium"
                >
                  Propose Battle
                </Link>
                <Link
                  href="/"
                  className={navLinkClass(arenaActive)}
                >
                  Arena
                </Link>
                <Link
                  href="/wallet"
                  className={navLinkClass(walletActive)}
                >
                  Wallet
                </Link>
                <Link
                  href="/roulette"
                  className={navLinkClass(rouletteActive)}
                >
                  Roulette
                </Link>
                {user.isAdmin === true && (
                  <Link
                    href="/admin"
                    className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium text-sm"
                  >
                    Admin
                  </Link>
                )}
                <span className="px-3 py-1 bg-green-100 dark:bg-dark-live-bg text-green-800 dark:text-dark-live-text rounded-full text-sm font-semibold">
                  ${(user?.balance ?? 0).toFixed(2)}
                </span>
                <UserMenu pathname={pathname ?? ''} />
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="px-4 py-2 text-gray-700 dark:text-dark-text-primary hover:bg-[rgba(0,0,0,0.05)] dark:hover:bg-[rgba(255,255,255,0.06)] rounded-lg transition"
                >
                  Login
                </Link>
                <Link
                  href="/register"
                  className="px-4 py-2 bg-primary-600 dark:bg-primary-500 text-white rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 transition"
                >
                  Sign Up
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
