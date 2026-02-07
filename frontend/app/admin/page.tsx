'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<{
    platformBalance: number;
    depositsToday: number;
    depositsTotal: number;
    pendingWithdrawals: number;
    openMarkets: number;
    oracle: { tokensRemaining: number; requestsInLastHour: number; shouldStop: boolean };
    roulette?: { totalVolumeCents: number; totalFeesCents: number; feesWaivedCount: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminAPI
      .getStats()
      .then((res) => setStats(res.data))
      .catch((e) => setError(e.response?.data?.error ?? e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }
  if (error || !stats) {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">
        {error ?? 'Failed to load stats'}
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Admin Dashboard</h1>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Link
          href="/admin/markets/create"
          className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 font-medium"
        >
          Create Battle
        </Link>
        <Link
          href="/admin/markets/awaiting"
          className="inline-flex items-center px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 font-medium"
        >
          Matches awaiting confirmation
        </Link>
        <Link
          href="/admin/markets/resolved"
          className="inline-flex items-center px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
        >
          Resolved
        </Link>
      </div>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Create Battle: publish immediately. To close a battle: after its end time it appears in «Matches awaiting confirmation» — select winner there. Or open the battle page (you’re the creator) and use «Resolve Market».
      </p>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card title="Platform balance" value={`$${stats.platformBalance.toFixed(2)}`} />
        <Card title="Deposits today" value={`$${stats.depositsToday.toFixed(2)}`} />
        <Card title="Deposits total" value={`$${stats.depositsTotal.toFixed(2)}`} />
        <Card title="Pending withdrawals" value={String(stats.pendingWithdrawals)} />
        <Card title="Open markets" value={String(stats.openMarkets)} />
        <Card
          title="Oracle"
          value={`${stats.oracle.requestsInLastHour} req/h · ${stats.oracle.tokensRemaining} left`}
          sub={stats.oracle.shouldStop ? 'Rate limit active' : undefined}
        />
        {stats.roulette != null && (
          <Link href="/admin/roulette" className="block">
            <Card
              title="Roulette"
              value={`$${((stats.roulette.totalVolumeCents ?? 0) / 100).toFixed(2)} vol · $${((stats.roulette.totalFeesCents ?? 0) / 100).toFixed(2)} fees`}
              sub={`${stats.roulette.feesWaivedCount ?? 0} fees waived`}
            />
          </Link>
        )}
      </div>
      {stats.roulette != null && (
        <div className="mt-6">
          <Link
            href="/admin/roulette"
            className="inline-flex items-center px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Roulette section →
          </Link>
        </div>
      )}
    </div>
  );
}

function Card({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white dark:bg-dark-card rounded-lg shadow p-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
      <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
      <p className="text-xl font-semibold text-gray-900 dark:text-white mt-1">{value}</p>
      {sub && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{sub}</p>}
    </div>
  );
}
