'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type Deposit = {
  id: string;
  userId: string;
  type: string;
  amount: number;
  description: string | null;
  createdAt: string;
};

export default function AdminDepositsPage() {
  const [rows, setRows] = useState<Deposit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminAPI
      .getDeposits()
      .then((res) => setRows(res.data))
      .catch(() => setRows([]))
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
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Deposits</h1>
        <Link href="/admin/deposits/sol" className="text-primary-600 hover:underline text-sm">
          SOL (USDC) →
        </Link>
        <Link href="/admin/deposits/tron" className="text-primary-600 hover:underline text-sm">
          TRON (USDT) →
        </Link>
        <Link href="/admin/deposits/polygon" className="text-primary-600 hover:underline text-sm">
          Polygon (USDT) →
        </Link>
        <Link href="/admin/deposits/polygon-hashes" className="text-primary-600 hover:underline text-sm">
          Users hash Polygon →
        </Link>
      </div>
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User ID</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-mono text-sm">{r.userId}</td>
                <td className="px-4 py-2">${r.amount.toFixed(2)}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{format(new Date(r.createdAt), 'PPp')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-gray-500">No deposits.</p>}
      </div>
    </div>
  );
}
