'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/store';
import { betsAPI, rouletteAPI } from '@/lib/api';
import { format } from 'date-fns';

type MarketBet = {
  id: string;
  marketId: string;
  outcome: string;
  amount: number;
  odds: number;
  payout: number | null;
  isWinning: boolean | null;
  createdAt: string;
  market: { id: string; title: string; status: string; winningOutcome: string | null };
};

type RouletteBetItem = {
  id: string;
  roundId: string;
  roundNumber: number;
  amountCents: number;
  ticketsFrom: number;
  ticketsTo: number;
  won: boolean;
  payoutCents: number | null;
  createdAt: string;
  roundStatus: string;
};

export default function HistoryPage() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, token, authVerified } = useAuthStore();
  const [marketBets, setMarketBets] = useState<MarketBet[]>([]);
  const [rouletteBets, setRouletteBets] = useState<RouletteBetItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      router.replace('/login');
      return;
    }
    if (!authVerified) return;
    if (pathname !== '/history') return;
    setLoading(true);
    Promise.all([betsAPI.getMyBets(), rouletteAPI.getMyBets(100)])
      .then(([betsRes, rouletteRes]) => {
        // Backend returns array as body; axios puts it in .data. Support raw array or { data: [...] }
        const rawBets = betsRes.data as unknown;
        const betsList = Array.isArray(rawBets)
          ? rawBets
          : Array.isArray((rawBets as { data?: unknown })?.data)
            ? (rawBets as { data: MarketBet[] }).data
            : [];
        setMarketBets(betsList);
        setRouletteBets(Array.isArray(rouletteRes.data) ? rouletteRes.data : []);
      })
      .catch(() => {
        setMarketBets([]);
        setRouletteBets([]);
      })
      .finally(() => setLoading(false));
  }, [token, authVerified, router, pathname]);

  // Refetch when user returns to this tab (e.g. placed bet in another tab)
  useEffect(() => {
    if (!token || pathname !== '/history') return;
    const onFocus = () => {
      Promise.all([betsAPI.getMyBets(), rouletteAPI.getMyBets(100)])
        .then(([betsRes, rouletteRes]) => {
          const rawBets = betsRes.data as unknown;
          const betsList = Array.isArray(rawBets)
            ? rawBets
            : Array.isArray((rawBets as { data?: unknown })?.data)
              ? (rawBets as { data: MarketBet[] }).data
              : [];
          setMarketBets(betsList);
          setRouletteBets(Array.isArray(rouletteRes.data) ? rouletteRes.data : []);
        })
        .catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [token, pathname]);

  if (!authVerified || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-700 dark:text-dark-text-secondary">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 text-gray-900 dark:text-dark-text-primary min-h-screen">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-primary-600 dark:text-primary-400 hover:underline text-sm">
          ← Back
        </Link>
        <h1 className="text-2xl font-bold">History</h1>
      </div>
      <p className="text-sm text-gray-500 dark:text-dark-text-secondary mb-4">
        All your bets on battles (markets) and roulette. Green = win, red = loss, gray = pending.
      </p>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary-500 border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Market (battle) bets */}
          <section>
            <h2 className="text-lg font-semibold text-gray-800 dark:text-dark-text-primary mb-3">Battles</h2>
            <div className="rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] overflow-hidden bg-white dark:bg-dark-card">
              {marketBets.length === 0 ? (
                <p className="p-6 text-gray-500 dark:text-dark-text-secondary text-sm">No battle bets yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-dark-secondary">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Date</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Event</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Outcome</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Stake</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-[rgba(255,255,255,0.06)]">
                      {marketBets.map((b) => {
                        const resolved = b.market.status === 'RESOLVED';
                        const cancelled = b.market.status === 'CANCELLED';
                        const won = b.isWinning === true;
                        const lost = resolved && b.isWinning === false;
                        const refund = cancelled; // cancelled market = stake returned
                        let result: string;
                        let resultClass: string;
                        if (won && b.payout != null) {
                          const profit = b.payout - b.amount;
                          const sign = profit >= 0 ? '+' : '-';
                          result = `${sign}$${Math.abs(profit).toFixed(2)}`;
                          resultClass = profit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
                        } else if (lost) {
                          result = `-$${b.amount.toFixed(2)}`;
                          resultClass = 'text-red-600 dark:text-red-400';
                        } else if (refund) {
                          result = 'Refund';
                          resultClass = 'text-gray-600 dark:text-dark-text-secondary';
                        } else {
                          result = 'Pending';
                          resultClass = 'text-amber-600 dark:text-amber-400';
                        }
                        return (
                          <tr key={b.id} className="hover:bg-gray-50 dark:hover:bg-dark-card-hover">
                            <td className="px-4 py-2 text-gray-500 dark:text-dark-text-muted whitespace-nowrap">
                              {format(new Date(b.createdAt), 'dd.MM.yyyy HH:mm')}
                            </td>
                            <td className="px-4 py-2 max-w-[200px] truncate" title={b.market.title}>
                              <Link href={`/markets/${b.marketId}`} className="text-primary-600 dark:text-primary-400 hover:underline">
                                {b.market.title}
                              </Link>
                            </td>
                            <td className="px-4 py-2">{b.outcome}</td>
                            <td className="px-4 py-2 text-right">${b.amount.toFixed(2)}</td>
                            <td className={`px-4 py-2 text-right font-medium ${resultClass}`}>{result}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* Roulette bets */}
          <section>
            <h2 className="text-lg font-semibold text-gray-800 dark:text-dark-text-primary mb-3">Roulette</h2>
            <div className="rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] overflow-hidden bg-white dark:bg-dark-card">
              {rouletteBets.length === 0 ? (
                <p className="p-6 text-gray-500 dark:text-dark-text-secondary text-sm">No roulette bets yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-dark-secondary">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Date</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Round</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Mode</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Stake</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-dark-text-muted uppercase">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-[rgba(255,255,255,0.06)]">
                      {rouletteBets.map((b) => {
                        const amountDollars = b.amountCents / 100;
                        const payoutDollars = b.payoutCents != null ? b.payoutCents / 100 : 0;
                        const profit = b.won ? payoutDollars - amountDollars : -amountDollars;
                        const resultStr = b.roundStatus === 'FINISHED' ? (b.won ? `+$${profit.toFixed(2)}` : `-$${amountDollars.toFixed(2)}`) : '—';
                        const resultClass = b.won ? 'text-green-600 dark:text-green-400' : b.roundStatus === 'FINISHED' ? 'text-red-600 dark:text-red-400' : 'text-gray-500';
                        return (
                          <tr key={b.id} className="hover:bg-gray-50 dark:hover:bg-dark-card-hover">
                            <td className="px-4 py-2 text-gray-500 dark:text-dark-text-muted whitespace-nowrap">
                              {format(new Date(b.createdAt), 'dd.MM.yyyy HH:mm')}
                            </td>
                            <td className="px-4 py-2">#{b.roundNumber}</td>
                            <td className="px-4 py-2">Tickets {b.ticketsFrom}–{b.ticketsTo}</td>
                            <td className="px-4 py-2 text-right">${amountDollars.toFixed(2)}</td>
                            <td className={`px-4 py-2 text-right font-medium ${resultClass}`}>{resultStr}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
