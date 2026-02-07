'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

/** Race a promise with a timeout so the UI does not hang on "Running...". After timeout, reject; server may still complete. */
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Request timeout')), ms)),
  ]);
};

const ADMIN_ACTION_TIMEOUT_MS = 120_000; // 2 min

type SolDeposit = {
  id: string;
  userId: string;
  network: string;
  txHash: string;
  depositAddress: string;
  rawAmount: number;
  amountUsd: number;
  priceUsed: number | null;
  status: string;
  isBelowMinimum: boolean;
  sweepTxId: string | null;
  createdAt: string;
  user: { id: string; username: string };
};

export default function AdminSolDepositsPage() {
  const [rows, setRows] = useState<SolDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [usdcRunning, setUsdcRunning] = useState(false);
  const [usdcResult, setUsdcResult] = useState<string | null>(null);
  const [backfillTx, setBackfillTx] = useState('');
  const [backfillEmail, setBackfillEmail] = useState('');
  const [backfillAmount, setBackfillAmount] = useState('');
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [pending, setPending] = useState<Array<{ id: string; txHash: string; depositAddress: string; amountUsd: number; status: string; user: { id: string; username: string; email: string } }>>([]);
  const [creditStepRunning, setCreditStepRunning] = useState(false);
  const [creditStepResult, setCreditStepResult] = useState<string | null>(null);
  const [creditOneTx, setCreditOneTx] = useState('');
  const [creditOneRunning, setCreditOneRunning] = useState(false);
  const [creditOneResult, setCreditOneResult] = useState<string | null>(null);
  const [reconcileRunning, setReconcileRunning] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<string | null>(null);
  const [reconcileTxHash, setReconcileTxHash] = useState('');
  const [reconcileTxRunning, setReconcileTxRunning] = useState(false);
  const [reconcileTxResult, setReconcileTxResult] = useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminAPI
      .getDepositsSol()
      .then((res) => setRows(res.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  const loadPending = () => {
    adminAPI
      .getDepositsSolPending()
      .then((res) => setPending(res.data?.pending ?? []))
      .catch(() => setPending([]));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    loadPending();
  }, []);

  const runUsdcCycle = () => {
    setUsdcRunning(true);
    setUsdcResult(null);
    withTimeout(adminAPI.runSolUsdcDepositCycle(), ADMIN_ACTION_TIMEOUT_MS)
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setUsdcResult(`Detected: ${d.detected}, Confirmed: ${d.confirmed}, Credited: ${d.credited}${d.errors?.length ? `. Errors: ${d.errors.length}` : ''}`);
          load();
        }
      })
      .catch((e) => setUsdcResult(e?.message === 'Request timeout' ? 'Timeout (2 min) — check server logs' : 'Failed to run cycle'))
      .finally(() => setUsdcRunning(false));
  };

  const runBackfill = () => {
    if (!backfillTx.trim() || !backfillEmail.trim()) {
      setBackfillResult('Enter tx hash and user email');
      return;
    }
    setBackfillRunning(true);
    setBackfillResult(null);
    const body: { txHash: string; userEmail: string; amountUsd?: number } = {
      txHash: backfillTx.trim(),
      userEmail: backfillEmail.trim(),
    };
    if (backfillAmount.trim()) {
      const n = parseFloat(backfillAmount.trim());
      if (!Number.isNaN(n) && n > 0) body.amountUsd = n;
    }
    adminAPI
      .backfillSolUsdcDeposit(body)
      .then((res) => {
        const d = res.data;
        if (d?.ok && d.alreadyCredited) setBackfillResult('Already credited (no change).');
        else if (d?.ok && d.credited) setBackfillResult(`Credited $${d.amountUsd ?? 0} for user ${d.userId ?? ''}.`);
        else setBackfillResult(d?.error ?? d?.message ?? 'Backfill failed');
        if (d?.ok) load();
      })
      .catch((e) => setBackfillResult(e?.response?.data?.error ?? e?.response?.data?.message ?? 'Request failed'))
      .finally(() => setBackfillRunning(false));
  };

  const runCreditStep = () => {
    setCreditStepRunning(true);
    setCreditStepResult(null);
    adminAPI
      .runSolUsdcCreditStep()
      .then((res) => {
        const d = res.data;
        if (d?.ok) setCreditStepResult(`Credited ${d.credited ?? 0} deposit(s).`);
        else setCreditStepResult(d?.errors?.join(' ') ?? 'Failed');
        load();
        loadPending();
      })
      .catch(() => setCreditStepResult('Request failed'))
      .finally(() => setCreditStepRunning(false));
  };

  const runCreditOne = () => {
    const tx = creditOneTx.trim();
    if (!tx) {
      setCreditOneResult('Enter tx hash');
      return;
    }
    setCreditOneRunning(true);
    setCreditOneResult(null);
    adminAPI
      .creditOneSolUsdc(tx)
      .then((res) => {
        const d = res.data;
        if (d?.ok && d.alreadyCredited) setCreditOneResult('Already credited.');
        else if (d?.ok && d.credited) setCreditOneResult(`Credited $${d.amountUsd ?? 0} (was ${d.previousStatus}).`);
        else setCreditOneResult(d?.error ?? 'Failed');
        if (d?.ok) {
          load();
          loadPending();
        }
      })
      .catch((e) => setCreditOneResult(e?.response?.data?.error ?? 'Request failed'))
      .finally(() => setCreditOneRunning(false));
  };

  const runReconcile = () => {
    setReconcileRunning(true);
    setReconcileResult(null);
    withTimeout(adminAPI.reconcileSolUsdc(), ADMIN_ACTION_TIMEOUT_MS)
      .then((res) => {
        const d = res.data;
        if (d?.ok)
          setReconcileResult(`Detected: ${d.detected}, Confirmed: ${d.confirmed}, Credited: ${d.credited}${d.errors?.length ? `. Errors: ${d.errors.length}` : ''}`);
        else setReconcileResult('Failed');
        load();
        loadPending();
      })
      .catch((e) => setReconcileResult(e?.message === 'Request timeout' ? 'Timeout (2 min) — check server logs' : 'Request failed'))
      .finally(() => setReconcileRunning(false));
  };

  const runReconcileByTxHash = () => {
    const tx = reconcileTxHash.trim();
    if (!tx) {
      setReconcileTxResult('Enter tx hash');
      return;
    }
    setReconcileTxRunning(true);
    setReconcileTxResult(null);
    adminAPI
      .reconcileSolUsdcByTxHash(tx)
      .then((res) => {
        const d = res.data;
        if (d?.ok && d.alreadyCredited) setReconcileTxResult('Already credited.');
        else if (d?.ok && d.credited) setReconcileTxResult(`Credited $${d.amountUsd ?? 0} (was ${d.previousStatus}).`);
        else setReconcileTxResult(d?.error ?? 'Failed');
        if (d?.ok) {
          load();
          loadPending();
        }
      })
      .catch((e) => setReconcileTxResult(e?.response?.data?.error ?? 'Request failed'))
      .finally(() => setReconcileTxRunning(false));
  };

  const runSweepToMaster = () => {
    setSweepRunning(true);
    setSweepResult(null);
    withTimeout(adminAPI.sweepSolUsdcToMaster(), ADMIN_ACTION_TIMEOUT_MS)
      .then((res) => {
        const d = res.data;
        if (d?.ok)
          setSweepResult(`Swept ${d.swept} ATA(s).${d.sweptTxIds?.length ? ` Tx: ${d.sweptTxIds.slice(0, 3).join(', ')}${(d.sweptTxIds.length > 3 ? '…' : '')}` : ''}${d.errors?.length ? ` Errors: ${d.errors.length}` : ''}`);
        else setSweepResult('Failed');
        load();
        loadPending();
      })
      .catch((e) => setSweepResult(e?.message === 'Request timeout' ? 'Timeout (2 min) — check server logs' : 'Request failed'))
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">SOL deposits</h1>
        <button
          type="button"
          onClick={runUsdcCycle}
          disabled={usdcRunning}
          className="ml-auto px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50"
        >
          {usdcRunning ? 'Running…' : 'Run USDC deposit cycle'}
        </button>
        <button
          type="button"
          onClick={runCreditStep}
          disabled={creditStepRunning}
          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {creditStepRunning ? 'Running…' : 'Run credit step only'}
        </button>
        <button
          type="button"
          onClick={runReconcile}
          disabled={reconcileRunning}
          className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {reconcileRunning ? 'Running…' : 'Reconcile pending (detect→confirm→credit)'}
        </button>
        <button
          type="button"
          onClick={runSweepToMaster}
          disabled={sweepRunning}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
        >
          {sweepRunning ? 'Running…' : 'Sweep all USDC to Master'}
        </button>
      </div>
      {usdcResult && (
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">{usdcResult}</p>
      )}
      {creditStepResult && (
        <p className="mb-3 text-sm text-emerald-700 dark:text-emerald-400">{creditStepResult}</p>
      )}
      {reconcileResult && (
        <p className="mb-3 text-sm text-sky-700 dark:text-sky-400">{reconcileResult}</p>
      )}
      {sweepResult && (
        <p className="mb-3 text-sm text-violet-700 dark:text-violet-400">{sweepResult}</p>
      )}
      <div className="mb-4 p-4 bg-sky-50 dark:bg-sky-900/20 rounded-lg border border-sky-200 dark:border-sky-800">
        <h2 className="text-sm font-semibold text-sky-800 dark:text-sky-200 mb-2">Reconcile by txHash</h2>
        <p className="text-xs text-sky-600 dark:text-sky-400 mb-2">Run confirm → credit for one tx (no sweep). Idempotent.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={reconcileTxHash}
            onChange={(e) => setReconcileTxHash(e.target.value)}
            placeholder="5eRpFjTkHe8t8..."
            className="px-3 py-2 rounded border border-sky-300 dark:border-sky-700 bg-white dark:bg-dark-card text-sm font-mono w-80"
          />
          <button
            type="button"
            onClick={runReconcileByTxHash}
            disabled={reconcileTxRunning}
            className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          >
            {reconcileTxRunning ? '…' : 'Reconcile this tx'}
          </button>
        </div>
        {reconcileTxResult && <p className="mt-2 text-sm">{reconcileTxResult}</p>}
      </div>
      {pending.length > 0 && (
        <div className="mb-4 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
          <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-2">
            Pending credit ({pending.length}) — CONFIRMED or SWEPT, not yet CREDITED
          </h2>
          <ul className="text-sm text-amber-700 dark:text-amber-300 space-y-1 mb-3">
            {pending.map((p) => (
              <li key={p.id}>
                {p.txHash.slice(0, 20)}… — {p.user?.email ?? p.user?.id} — ${p.amountUsd.toFixed(2)} — {p.status}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={creditOneTx}
              onChange={(e) => setCreditOneTx(e.target.value)}
              placeholder="Paste tx hash to credit one"
              className="px-3 py-2 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-dark-card text-sm font-mono w-72"
            />
            <button
              type="button"
              onClick={runCreditOne}
              disabled={creditOneRunning}
              className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-500 disabled:opacity-50"
            >
              {creditOneRunning ? '…' : 'Credit this tx'}
            </button>
          </div>
          {creditOneResult && <p className="mt-2 text-sm">{creditOneResult}</p>}
        </div>
      )}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-dark-secondary rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Backfill missed USDC deposit</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Use when a tx is confirmed on chain but not credited. Idempotent (no double credit).
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">Tx signature</span>
            <input
              type="text"
              value={backfillTx}
              onChange={(e) => setBackfillTx(e.target.value)}
              placeholder="5eRpFjTkHe8t8..."
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-card text-sm font-mono w-80"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">User email</span>
            <input
              type="email"
              value={backfillEmail}
              onChange={(e) => setBackfillEmail(e.target.value)}
              placeholder="user@example.com"
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-card text-sm w-48"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">Amount USD (optional)</span>
            <input
              type="text"
              value={backfillAmount}
              onChange={(e) => setBackfillAmount(e.target.value)}
              placeholder="1.05"
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-card text-sm w-24"
            />
          </label>
          <button
            type="button"
            onClick={runBackfill}
            disabled={backfillRunning}
            className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-500 disabled:opacity-50"
          >
            {backfillRunning ? 'Running…' : 'Backfill deposit'}
          </button>
        </div>
        {backfillResult && <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{backfillResult}</p>}
      </div>
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">TxHash</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount SOL</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount USD</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-mono text-xs truncate max-w-[120px]" title={r.txHash}>
                  {r.txHash.slice(0, 12)}…
                </td>
                <td className="px-4 py-2 text-sm">{r.user?.username ?? r.userId}</td>
                <td className="px-4 py-2">{r.rawAmount.toFixed(6)}</td>
                <td className="px-4 py-2">${r.amountUsd.toFixed(2)}</td>
                <td className="px-4 py-2">
                  <span className={r.isBelowMinimum ? 'text-amber-600' : ''}>
                    {r.status}
                    {r.isBelowMinimum ? ' (below min)' : ''}
                  </span>
                </td>
                <td className="px-4 py-2 text-sm text-gray-500">{format(new Date(r.createdAt), 'PPp')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-gray-500">No SOL deposits.</p>}
      </div>
    </div>
  );
}
