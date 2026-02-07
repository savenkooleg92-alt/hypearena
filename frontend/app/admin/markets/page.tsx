'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';

type Market = {
  id: string;
  title: string;
  status: string;
  category: string | null;
  createdAt: string;
  creator: { id: string; username: string };
  _count: { bets: number };
};

export default function AdminMarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');
  const [titleSearch, setTitleSearch] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const fetchMarkets = () => {
    setLoading(true);
    const params: { status?: string; title?: string } = filter ? { status: filter } : {};
    if (titleSearch.trim()) params.title = titleSearch.trim();
    adminAPI
      .getMarkets(Object.keys(params).length ? params : undefined)
      .then((res) => setMarkets(res.data))
      .catch(() => setMarkets([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchMarkets();
  }, [filter, titleSearch]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

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

  const handleRemove = async (id: string) => {
    if (!confirm('Remove this market from the site? (Bets refunded only if OPEN/Awaiting.)')) return;
    setRemovingId(id);
    try {
      await adminAPI.removeMarket(id);
      fetchMarkets();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      alert((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to remove');
    } finally {
      setRemovingId(null);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Remove ${selectedIds.size} market(s) from the site? They will disappear from the public list. Bets refunded only for OPEN/Awaiting.`)) return;
    setDeleting(true);
    const ids = Array.from(selectedIds);
    let ok = 0;
    let err: string | null = null;
    try {
      for (const id of ids) {
        try {
          await adminAPI.removeMarket(id);
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

  const canRemove = (status: string) =>
    ['PENDING', 'OPEN', 'AWAITING_RESULT', 'RESOLVED', 'CLOSED'].includes(status);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Markets</h1>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="text"
          placeholder="Search by title..."
          value={titleSearch}
          onChange={(e) => setTitleSearch(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-dark-card text-gray-900 dark:text-white min-w-[180px]"
        />
        <button
          onClick={() => setFilter('')}
          className={`px-3 py-1 rounded ${!filter ? 'bg-primary-600 text-white' : 'bg-gray-200 dark:bg-dark-secondary dark:text-dark-text-primary'}`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('OPEN')}
          className={`px-3 py-1 rounded ${filter === 'OPEN' ? 'bg-primary-600 text-white' : 'bg-gray-200 dark:bg-dark-secondary dark:text-dark-text-primary'}`}
        >
          Open
        </button>
        <button
          onClick={() => setFilter('AWAITING_RESULT')}
          className={`px-3 py-1 rounded ${filter === 'AWAITING_RESULT' ? 'bg-primary-600 text-white' : 'bg-gray-200 dark:bg-dark-secondary dark:text-dark-text-primary'}`}
        >
          Awaiting result
        </button>
        <button
          onClick={() => setFilter('RESOLVED')}
          className={`px-3 py-1 rounded ${filter === 'RESOLVED' ? 'bg-primary-600 text-white' : 'bg-gray-200 dark:bg-dark-secondary dark:text-dark-text-primary'}`}
        >
          Resolved
        </button>
      </div>
      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-hidden border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        {markets.length > 0 && (
          <div className="px-4 py-3 flex flex-wrap items-center gap-3 bg-gray-50 dark:bg-dark-secondary border-b border-gray-200 dark:border-gray-700">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.size === markets.length}
                onChange={toggleSelectAll}
                className="rounded border-gray-300 dark:border-gray-500"
              />
              <span className="text-sm text-gray-700 dark:text-dark-text-primary">Select all</span>
            </label>
            <button
              type="button"
              onClick={handleDeleteSelected}
              disabled={selectedIds.size === 0 || deleting}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? '…' : `Delete selected (${selectedIds.size})`}
            </button>
          </div>
        )}
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase w-10">✓</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Title</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Category</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Creator</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Bets</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {markets.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-2">
                  {canRemove(m.status) && (
                    <label className="flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(m.id)}
                        onChange={() => toggleSelect(m.id)}
                        className="rounded border-gray-300 dark:border-gray-500"
                      />
                    </label>
                  )}
                </td>
                <td className="px-4 py-2">
                  <Link href={`/markets/${m.id}`} className="text-primary-600 hover:underline">
                    {m.title.slice(0, 50)}{m.title.length > 50 ? '…' : ''}
                  </Link>
                </td>
                <td className="px-4 py-2">{m.status}</td>
                <td className="px-4 py-2">{m.category ?? '—'}</td>
                <td className="px-4 py-2">{m.creator.username}</td>
                <td className="px-4 py-2">{m._count.bets}</td>
                <td className="px-4 py-2">
                  {canRemove(m.status) && (
                    <button
                      type="button"
                      onClick={() => handleRemove(m.id)}
                      disabled={removingId === m.id}
                      className="text-red-600 hover:underline disabled:opacity-50"
                    >
                      {removingId === m.id ? '…' : 'Remove'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {markets.length === 0 && (
          <p className="p-6 text-gray-500 dark:text-gray-400">No markets found.</p>
        )}
      </div>
    </div>
  );
}
