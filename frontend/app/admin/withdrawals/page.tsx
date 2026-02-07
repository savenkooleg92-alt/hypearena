'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type Withdrawal = {
  id: string;
  userId: string;
  network: string;
  toAddress: string;
  amountGross: number;
  fee: number;
  amountNet: number;
  status: string;
  txId: string | null;
  error: string | null;
  createdAt: string;
  user: { id: string; email: string; username: string };
};

type Stats = {
  totalWithdrawalsToday: number;
  totalWithdrawalsVolume: number;
  pendingCount: number;
  failedCount: number;
  approvedCount: number;
};

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    PENDING: 'Pending',
    APPROVED: 'Approved',
    SENT: 'Sent',
    FAILED: 'Failed',
    PROCESSING: 'Approved',
    COMPLETED: 'Sent',
  };
  return map[s] ?? s;
}

function canApprove(s: string): boolean {
  return s === 'PENDING';
}
function canReject(s: string): boolean {
  return s === 'PENDING';
}
function canSendPayout(s: string): boolean {
  return s === 'APPROVED';
}
function canRetry(s: string): boolean {
  return s === 'FAILED';
}

export default function AdminWithdrawalsPage() {
  const [rows, setRows] = useState<Withdrawal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState<Withdrawal | null>(null);
  const [sendAllRunning, setSendAllRunning] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([adminAPI.getWithdrawals(), adminAPI.getWithdrawalsStats()])
      .then(([res, statsRes]) => {
        setRows(Array.isArray(res.data) ? res.data : []);
        setStats(statsRes.data ?? null);
      })
      .catch(() => {
        setRows([]);
        setStats(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleApprove = (id: string) => {
    setActioning(id);
    adminAPI
      .approveWithdrawal(id)
      .then(() => load())
      .catch((e) => alert(e.response?.data?.error ?? 'Failed'))
      .finally(() => setActioning(null));
  };

  const handleReject = (id: string) => {
    const err = window.prompt('Reason (optional):');
    setActioning(id);
    adminAPI
      .rejectWithdrawal(id, { error: err ?? undefined })
      .then(() => load())
      .catch((e) => alert(e.response?.data?.error ?? 'Failed'))
      .finally(() => setActioning(null));
  };

  const handleSendPayout = (row: Withdrawal) => {
    setConfirmSend(row);
  };

  const confirmSendPayout = () => {
    if (!confirmSend) return;
    const id = confirmSend.id;
    setConfirmSend(null);
    setActioning(id);
    adminAPI
      .sendWithdrawalPayout(id)
      .then((res) => {
        if (res.data?.txId) alert(`Payout sent. Tx: ${res.data.txId}`);
        load();
      })
      .catch((e) => alert(e.response?.data?.error ?? e.response?.data?.message ?? 'Send failed'))
      .finally(() => setActioning(null));
  };

  const handleRetry = (id: string) => {
    setActioning(id);
    adminAPI
      .retryWithdrawal(id)
      .then(() => load())
      .catch((e) => alert(e.response?.data?.error ?? 'Retry failed'))
      .finally(() => setActioning(null));
  };

  const handleSendAllApproved = () => {
    setSendAllRunning(true);
    adminAPI
      .sendAllApprovedWithdrawals()
      .then((res) => {
        const d = res.data;
        if (d) alert(`Sent: ${d.sent}, Failed: ${d.failed}`);
        load();
      })
      .catch((e) => alert(e.response?.data?.error ?? 'Send all failed'))
      .finally(() => setSendAllRunning(false));
  };

  const exportCsv = () => {
    const headers = ['User', 'Email', 'Network', 'To Address', 'Amount Requested', 'Fee', 'Amount to Send', 'Status', 'Tx ID', 'Created'];
    const lines = [
      headers.join(','),
      ...rows.map((r) =>
        [
          r.user?.username ?? r.userId,
          r.user?.email ?? '',
          r.network,
          r.toAddress,
          r.amountGross,
          r.fee,
          r.amountNet,
          statusLabel(r.status),
          r.txId ?? '',
          r.createdAt,
        ].join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `withdrawals-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
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
        <Link href="/admin" className="text-primary-600 hover:underline text-sm">
          ← Admin
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Withdrawals</h1>
        <button
          type="button"
          onClick={handleSendAllApproved}
          disabled={sendAllRunning || !(stats?.approvedCount ?? 0)}
          className="ml-auto px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
        >
          {sendAllRunning ? 'Sending…' : 'Send All Approved'}
        </button>
        <button
          type="button"
          onClick={exportCsv}
          className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Export CSV
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          <div className="p-3 rounded-lg bg-gray-50 dark:bg-dark-secondary border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">Withdrawals today</p>
            <p className="text-lg font-semibold">{stats.totalWithdrawalsToday}</p>
          </div>
          <div className="p-3 rounded-lg bg-gray-50 dark:bg-dark-secondary border border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">Total volume (sent)</p>
            <p className="text-lg font-semibold">${stats.totalWithdrawalsVolume.toFixed(2)}</p>
          </div>
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <p className="text-xs text-amber-700 dark:text-amber-300">Pending</p>
            <p className="text-lg font-semibold">{stats.pendingCount}</p>
          </div>
          <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
            <p className="text-xs text-emerald-700 dark:text-emerald-300">Approved (ready to send)</p>
            <p className="text-lg font-semibold">{stats.approvedCount}</p>
          </div>
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <p className="text-xs text-red-700 dark:text-red-300">Failed</p>
            <p className="text-lg font-semibold">{stats.failedCount}</p>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User / Email</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Network</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Destination</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount req.</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Fee</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">To send</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Created</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 text-sm">
                  <div>{r.user?.username ?? r.userId.slice(0, 8)}</div>
                  <div className="text-gray-500 dark:text-gray-400 text-xs">{r.user?.email ?? '—'}</div>
                </td>
                <td className="px-4 py-2">{r.network}</td>
                <td className="px-4 py-2 font-mono text-xs max-w-[140px] truncate" title={r.toAddress}>
                  {r.toAddress}
                </td>
                <td className="px-4 py-2">${r.amountGross.toFixed(2)}</td>
                <td className="px-4 py-2">${r.fee.toFixed(2)}</td>
                <td className="px-4 py-2 font-medium">${r.amountNet.toFixed(2)}</td>
                <td className="px-4 py-2">
                  <span className={r.status === 'FAILED' ? 'text-red-600' : r.status === 'SENT' || r.status === 'COMPLETED' ? 'text-green-600' : ''}>
                    {statusLabel(r.status)}
                  </span>
                  {r.txId && (
                    <a
                      href={
                        r.network === 'SOL'
                          ? `https://solscan.io/tx/${r.txId}`
                          : r.network === 'TRON'
                            ? `https://tronscan.org/#/transaction/${r.txId}`
                            : r.network === 'MATIC'
                              ? `https://polygonscan.com/tx/${r.txId}`
                              : '#'
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 text-xs text-primary-600 hover:underline"
                    >
                      tx
                    </a>
                  )}
                </td>
                <td className="px-4 py-2 text-sm text-gray-500">{format(new Date(r.createdAt), 'PP p')}</td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {canApprove(r.status) && (
                      <>
                        <button
                          onClick={() => handleApprove(r.id)}
                          disabled={actioning !== null}
                          className="px-2 py-1 text-sm bg-green-600 text-white rounded disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleReject(r.id)}
                          disabled={actioning !== null}
                          className="px-2 py-1 text-sm bg-red-600 text-white rounded disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {canSendPayout(r.status) && (
                      <button
                        onClick={() => handleSendPayout(r)}
                        disabled={actioning !== null}
                        className="px-2 py-1 text-sm bg-violet-600 text-white rounded disabled:opacity-50"
                      >
                        Send payout
                      </button>
                    )}
                    {canRetry(r.status) && (
                      <button
                        onClick={() => handleRetry(r.id)}
                        disabled={actioning !== null}
                        className="px-2 py-1 text-sm bg-amber-600 text-white rounded disabled:opacity-50"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-gray-500">No withdrawals.</p>}
      </div>

      {confirmSend && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmSend(null)}>
          <div
            className="bg-white dark:bg-dark-card rounded-xl shadow-xl p-6 max-w-md w-full border border-gray-200 dark:border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Send payout</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Send <strong>${confirmSend.amountNet.toFixed(2)}</strong> to:
            </p>
            <p className="font-mono text-sm break-all mb-1">{confirmSend.toAddress}</p>
            <p className="text-sm text-gray-500 mb-4">Network: {confirmSend.network}</p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmSend(null)}
                className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSendPayout}
                className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500"
              >
                Send payout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
