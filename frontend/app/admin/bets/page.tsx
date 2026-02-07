'use client';

import { useEffect, useState } from 'react';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type Bet = {
  id: string;
  outcome: string;
  amount: number;
  odds: number;
  payout: number | null;
  isWinning: boolean | null;
  createdAt: string;
  user: { id: string; username: string };
  market: { id: string; title: string; status: string };
};

export default function AdminBetsPage() {
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminAPI
      .getBets()
      .then((res) => setBets(res.data))
      .catch(() => setBets([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Bets</h1>
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Market</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Outcome</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Result</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {bets.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-2">{b.user.username}</td>
                <td className="px-4 py-2 max-w-xs truncate">{b.market.title}</td>
                <td className="px-4 py-2">{b.outcome}</td>
                <td className="px-4 py-2">${b.amount.toFixed(2)}</td>
                <td className="px-4 py-2">
                  {b.isWinning === null ? '—' : b.isWinning ? `Won $${(b.payout ?? 0).toFixed(2)}` : 'Lost'}
                </td>
                <td className="px-4 py-2 text-sm text-gray-500">{format(new Date(b.createdAt), 'PP')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bets.length === 0 && <p className="p-6 text-gray-500">No bets.</p>}
      </div>
    </div>
  );
}
