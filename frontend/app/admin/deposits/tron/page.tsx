'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type TronDeposit = {
  id: string;
  userId: string;
  network: string;
  txHash: string;
  depositAddress: string;
  rawAmount: number;
  amountUsd: number;
  status: string;
  sweepTxId: string | null;
  createdAt: string;
  user: { id: string; username: string };
};

export default function AdminTronDepositsPage() {
  const [rows, setRows] = useState<TronDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleResult, setCycleResult] = useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminAPI
      .getDepositsTron()
      .then((res) => setRows(res.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const runCycle = () => {
    setCycleRunning(true);
    setCycleResult(null);
    adminAPI
      .runTronUsdtCycle()
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setCycleResult(
            `Detected: ${d.detected}, Confirmed: ${d.confirmed}, Credited: ${d.credited}${d.failed ? `, Failed: ${d.failed}` : ''}${d.errors?.length ? `. Errors: ${d.errors.length}` : ''}`
          );
          load();
        }
      })
      .catch(() => setCycleResult('Failed to run cycle'))
      .finally(() => setCycleRunning(false));
  };

  const runSweep = () => {
    setSweepRunning(true);
    setSweepResult(null);
    adminAPI
      .sweepTronUsdtToMaster()
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setSweepResult(`Swept ${d.sweptCount} address(es).${d.results?.length ? ` ${d.results.filter((r) => r.success).length} succeeded.` : ''}`);
          load();
        }
      })
      .catch(() => setSweepResult('Sweep failed'))
      .finally(() => setSweepRunning(false));
  };

  if (loading && rows.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <Link href="/admin/deposits" className="text-primary-600 hover:underline text-sm">
          ← All deposits
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">TRON USDT (TRC-20) deposits</h1>
        <button
          type="button"
          onClick={runCycle}
          disabled={cycleRunning}
          className="ml-auto px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50"
        >
          {cycleRunning ? 'Running…' : 'Run TRON USDT cycle'}
        </button>
        <button
          type="button"
          onClick={runSweep}
          disabled={sweepRunning}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
        >
          {sweepRunning ? 'Running…' : 'Sweep all TRON USDT to Master'}
        </button>
      </div>
      {cycleResult && <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">{cycleResult}</p>}
      {sweepResult && <p className="mb-3 text-sm text-violet-700 dark:text-violet-400">{sweepResult}</p>}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Detects incoming USDT (TRC-20) to deposit addresses, credits after confirmation. Min $1 (testing; restore $20 for production). Sweep sends USDT from deposit wallets to master (uses MASTER_ADDRESS_TRON / key).
      </p>
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Tx hash</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Address</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 text-sm">{r.user?.username ?? r.userId}</td>
                <td className="px-4 py-2 font-mono text-xs truncate max-w-[120px]" title={r.txHash}>
                  {r.txHash.slice(0, 12)}…
                </td>
                <td className="px-4 py-2 font-mono text-xs truncate max-w-[100px]" title={r.depositAddress}>
                  {r.depositAddress.slice(0, 8)}…
                </td>
                <td className="px-4 py-2">${r.amountUsd.toFixed(2)}</td>
                <td className="px-4 py-2 text-sm">{r.status}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{format(new Date(r.createdAt), 'PPp')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-gray-500">No TRON deposits.</p>}
      </div>
    </div>
  );
}
