'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';

type Market = {
  id: string;
  title: string;
  status: string;
  outcomes: string[];
  category: string | null;
  creator: { id: string; username: string };
  _count: { bets: number };
};

type DeleteMode = 'no_refund' | 'refund' | null;

export default function AdminAwaitingPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>(null);

  const fetchMarkets = () => {
    setLoading(true);
    adminAPI
      .getMarkets({ awaiting: true })
      .then((res) => setMarkets(res.data ?? []))
      .catch(() => setMarkets([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchMarkets();
  }, []);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === markets.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(markets.map((m) => m.id)));
  };

  const handleSelectWinner = async (marketId: string, winningOutcome: string) => {
    if (!confirm(`Set winner to "${winningOutcome}"? This will resolve the market and pay out winners.`)) return;
    setResolvingId(marketId);
    try {
      await adminAPI.resolveMarket(marketId, winningOutcome);
      fetchMarkets();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to resolve';
      alert(msg);
    } finally {
      setResolvingId(null);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (deleteMode === null) {
      alert('Choose an option: just remove from site, or remove and return all stakes to bettors.');
      return;
    }
    const withRefund = deleteMode === 'refund';
    if (!confirm(withRefund
      ? `Remove ${selectedIds.size} market(s) and return all stakes to bettors?`
      : `Remove ${selectedIds.size} market(s) from the site? They will disappear. No refunds.`)) return;
    setDeleting(true);
    const ids = Array.from(selectedIds);
    let ok = 0;
    let err: string | null = null;
    try {
      for (const id of ids) {
        try {
          await adminAPI.removeMarket(id, { refund: withRefund });
          ok++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          const code = (e as { code?: string })?.code;
          err = (e as { response?: { data?: { error?: string; details?: string } } })?.response?.data?.error
            ?? (e as { response?: { data?: { details?: string } } })?.response?.data?.details
            ?? (code === 'ECONNABORTED' ? 'Request timeout (15s)' : msg || 'Failed');
        }
      }
    } finally {
      setDeleting(false);
    }
    setSelectedIds(new Set());
    fetchMarkets();
    if (err && ok === 0) alert(err);
    else if (ok < ids.length) alert(`Removed ${ok}/${ids.length}. One or more failed: ${err ?? ''}`);
    else if (ok === ids.length) alert(`Removed ${ok} market(s). They are no longer visible on the site.`);
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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Matches awaiting confirmation</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Match ended or time passed. Select winner to resolve and pay out, or delete. When deleting, choose: just remove or remove and return all stakes.
      </p>
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-hidden border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        {markets.length === 0 ? (
          <p className="p-6 text-gray-500 dark:text-gray-400">No matches awaiting confirmation.</p>
        ) : (
          <>
            <div className="px-4 py-3 flex flex-wrap items-center gap-4 bg-gray-50 dark:bg-dark-secondary border-b border-gray-200 dark:border-gray-700">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedIds.size === markets.length && markets.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 dark:border-gray-500"
                />
                <span className="text-sm text-gray-700 dark:text-dark-text-primary">Select all</span>
              </label>
              <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0">
                <legend className="sr-only">When deleting</legend>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="deleteMode"
                    checked={deleteMode === 'no_refund'}
                    onChange={() => setDeleteMode('no_refund')}
                    className="border-gray-300 dark:border-gray-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-dark-text-primary">Just remove (no refunds)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="deleteMode"
                    checked={deleteMode === 'refund'}
                    onChange={() => setDeleteMode('refund')}
                    className="border-gray-300 dark:border-gray-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-dark-text-primary">Remove and return all stakes</span>
                </label>
              </fieldset>
              <button
                type="button"
                onClick={handleDeleteSelected}
                disabled={selectedIds.size === 0 || deleting || deleteMode === null}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? '…' : `Delete selected (${selectedIds.size})`}
              </button>
            </div>
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {markets.map((m) => (
                <li key={m.id} className="px-4 py-4 flex flex-wrap items-center gap-3">
                  <label className="flex items-center shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(m.id)}
                      onChange={() => toggleSelect(m.id)}
                      className="rounded border-gray-300 dark:border-gray-500"
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <Link href={`/markets/${m.id}`} className="text-primary-600 dark:text-primary-400 hover:underline font-medium">
                      {m.title}
                    </Link>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {m.outcomes?.join(' / ') ?? '—'} · {m._count.bets} bets
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="text-sm text-gray-500 dark:text-gray-400">Select winner:</span>
                    {(m.outcomes ?? []).map((outcome) => (
                      <button
                        key={outcome}
                        type="button"
                        onClick={() => handleSelectWinner(m.id, outcome)}
                        disabled={resolvingId === m.id}
                        className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
                      >
                        {resolvingId === m.id ? '…' : outcome}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
