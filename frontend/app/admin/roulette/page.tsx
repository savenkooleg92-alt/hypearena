'use client';

import { useEffect, useState } from 'react';
import { adminAPI } from '@/lib/api';

type CurrentRound = {
  id: string;
  roundNumber?: number;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  seedHash: string | null;
  serverSeed: string | null;
  totalTickets: number;
  potCents: number;
  feeCents: number;
  winnerUserId: string | null;
  winningTicket: number | null;
  bets: Array<{
    id: string;
    userId: string;
    username?: string;
    amountCents: number;
    ticketsFrom: number;
    ticketsTo: number;
  }>;
};

type HistoryItem = {
  id: string;
  roundNumber?: number;
  status: string;
  endsAt: string | null;
  potCents: number;
  feeCents: number;
  feeWaived: boolean;
  winnerUserId: string | null;
  winningTicket: number | null;
  serverSeed: string | null;
  updatedAt: string;
};

export default function AdminRoulettePage() {
  const [current, setCurrent] = useState<CurrentRound | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [stats, setStats] = useState<{
    totalVolumeCents: number;
    totalFeesCents: number;
    feesWaivedCount: number;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [lastResolve, setLastResolve] = useState<{ resolved: number; errors: string[] } | null>(null);

  const load = () => {
    adminAPI.getRouletteCurrent().then((r) => setCurrent(r.data)).catch(() => setCurrent(null));
    adminAPI.getRouletteHistory(20).then((r) => setHistory(r.data ?? [])).catch(() => setHistory([]));
    adminAPI.getStats().then((r) => setStats(r.data.roulette ?? null)).catch(() => setStats(null));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const runResolve = () => {
    setResolving(true);
    setLastResolve(null);
    adminAPI
      .rouletteResolve()
      .then((r) => setLastResolve({ resolved: r.data.resolved, errors: r.data.errors ?? [] }))
      .catch((e) => setLastResolve({ resolved: 0, errors: [e.response?.data?.error ?? e.message ?? 'Failed'] }))
      .finally(() => {
        setResolving(false);
        load();
      });
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Roulette</h1>

      {stats && (
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <div className="bg-white dark:bg-dark-card rounded-lg shadow p-4 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total volume</p>
            <p className="text-xl font-semibold text-gray-900 dark:text-white">
              ${(stats.totalVolumeCents / 100).toFixed(2)}
            </p>
          </div>
          <div className="bg-white dark:bg-dark-card rounded-lg shadow p-4 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total fees collected</p>
            <p className="text-xl font-semibold text-gray-900 dark:text-white">
              ${(stats.totalFeesCents / 100).toFixed(2)}
            </p>
          </div>
          <div className="bg-white dark:bg-dark-card rounded-lg shadow p-4 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
            <p className="text-sm text-gray-500 dark:text-gray-400">Fees waived (≥95%)</p>
            <p className="text-xl font-semibold text-gray-900 dark:text-white">{stats.feesWaivedCount}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-dark-card rounded-lg shadow p-6 mb-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Current round</h2>
        {current ? (
          <div className="space-y-2 text-sm">
            <p><strong>Round:</strong> #{current.roundNumber ?? '—'}</p>
            <p><strong>Status:</strong> {current.status}</p>
            <p><strong>Pot:</strong> ${(current.potCents / 100).toFixed(2)} · <strong>Tickets:</strong> {current.totalTickets}</p>
            <p><strong>Ends at:</strong> {current.endsAt ? new Date(current.endsAt).toISOString() : '—'}</p>
            {current.seedHash && <p><strong>Seed hash:</strong> <code className="text-xs break-all">{current.seedHash}</code></p>}
            {current.status === 'FINISHED' && current.serverSeed && (
              <p><strong>Server seed:</strong> <code className="text-xs break-all">{current.serverSeed}</code></p>
            )}
            {current.bets?.length > 0 && (
              <div className="mt-2">
                <strong>Bets:</strong>
                <ul className="list-disc list-inside mt-1">
                  {current.bets.map((b) => (
                    <li key={b.id}>{b.username ?? b.userId} — ${(b.amountCents / 100).toFixed(2)} (tickets {b.ticketsFrom}-{b.ticketsTo})</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="text-gray-500">Loading…</p>
        )}
        <div className="mt-4">
          <button
            onClick={runResolve}
            disabled={resolving}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
          >
            {resolving ? 'Running…' : 'Resolve now'}
          </button>
        </div>
        {lastResolve && (
          <p className="mt-2 text-sm text-gray-500">
            Resolved {lastResolve.resolved} round(s). {lastResolve.errors.length > 0 && `Errors: ${lastResolve.errors.join(', ')}`}
          </p>
        )}
      </div>

      <div className="bg-white dark:bg-dark-card rounded-lg shadow p-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Last 20 rounds</h2>
        {history.length === 0 ? (
          <p className="text-gray-500">No finished rounds.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-600 text-left">
                  <th className="py-2">Round</th>
                  <th className="py-2">Ended</th>
                  <th className="py-2">Pot</th>
                  <th className="py-2">Fee</th>
                  <th className="py-2">Winner ticket</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700">
                    <td className="py-2 font-medium">#{r.roundNumber ?? '—'}</td>
                    <td className="py-2">{r.endsAt ? new Date(r.endsAt).toLocaleString() : '—'}</td>
                    <td className="py-2">${(r.potCents / 100).toFixed(2)}</td>
                    <td className="py-2">{r.feeWaived ? 'Waived' : `$${(r.feeCents / 100).toFixed(2)}`}</td>
                    <td className="py-2">{r.winningTicket ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
