'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type Submission = {
  id: string;
  userId: string;
  txHash: string;
  status: string;
  createdAt: string;
  creditedAt: string | null;
  amountUsd: number | null;
  depositAddress: string | null;
  adminNote: string | null;
  user: { id: string; username: string; email: string };
};

export default function AdminPolygonHashesPage() {
  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [creditingId, setCreditingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminAPI
      .getPolygonUserSubmissions()
      .then((res) => setRows(res.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleCredit = (id: string) => {
    setCreditingId(id);
    setMessage(null);
    adminAPI
      .creditPolygonUserSubmission(id)
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          if (d.alreadyCredited) {
            setMessage(`Already credited. ${d.amountUsd != null ? `$${d.amountUsd.toFixed(2)}` : ''}`);
          } else {
            setMessage(`Credited ${d.amountUsd != null ? `$${d.amountUsd.toFixed(2)}` : ''}. Swept: ${d.sweptCount ?? 0} address(es).`);
          }
          load();
        } else {
          setMessage(d?.error ?? 'Failed');
        }
      })
      .catch((err) => {
        setMessage(err.response?.data?.error ?? err.message ?? 'Request failed');
      })
      .finally(() => setCreditingId(null));
  };

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
        <Link href="/admin/deposits" className="text-primary-600 hover:underline text-sm">
          ← All deposits
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Users hash Polygon</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Users submit a Transaction Hash via &quot;I paid&quot; on Wallet. Check and credit once per hash. One hash = one credit only.
      </p>
      {message && (
        <p className="mb-4 text-sm text-green-600 dark:text-green-400">{message}</p>
      )}
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Tx Hash</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Submitted</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Credited / Amount</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 text-sm">
                  <span className="font-medium text-gray-800 dark:text-dark-text-primary">{r.user.username}</span>
                  <span className="text-gray-500 dark:text-gray-400 text-xs block">{r.user.email}</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs truncate max-w-[180px]" title={r.txHash}>
                  <a
                    href={`https://polygonscan.com/tx/${r.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-600 dark:text-primary-400 hover:underline"
                  >
                    {r.txHash.slice(0, 18)}…
                  </a>
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      r.status === 'CREDITED'
                        ? 'text-green-600 dark:text-green-400'
                        : r.status === 'REJECTED'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {format(new Date(r.createdAt), 'PPp')}
                </td>
                <td className="px-4 py-2 text-sm">
                  {r.creditedAt ? format(new Date(r.creditedAt), 'PPp') : '—'}
                  {r.amountUsd != null && (
                    <span className="text-green-600 dark:text-green-400 block">${r.amountUsd.toFixed(2)}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.status === 'PENDING' && (
                    <button
                      type="button"
                      onClick={() => handleCredit(r.id)}
                      disabled={creditingId !== null}
                      className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50"
                    >
                      {creditingId === r.id ? 'Checking…' : 'Check & Credit'}
                    </button>
                  )}
                  {r.status === 'CREDITED' && <span className="text-gray-400 text-sm">Done</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-gray-500">No user submissions yet.</p>}
      </div>
    </div>
  );
}
