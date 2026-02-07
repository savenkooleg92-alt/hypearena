'use client';

import { useEffect, useState } from 'react';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type PendingMarket = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  subCategory: string | null;
  outcomes: string[];
  marketType: string | null;
  line: number | null;
  startsAt: string | null;
  endDate: string | null;
  createdAt: string;
  creator: { id: string; username: string; email: string };
};

export default function AdminPendingMarketsPage() {
  const [markets, setMarkets] = useState<PendingMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ title: string; description: string; category: string; outcomes: string }>({ title: '', description: '', category: '', outcomes: '' });

  const load = () => {
    setLoading(true);
    adminAPI
      .getPendingMarkets()
      .then((res) => setMarkets(res.data))
      .catch(() => setMarkets([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const startEdit = (m: PendingMarket) => {
    setEditingId(m.id);
    setEditForm({
      title: m.title,
      description: m.description ?? '',
      category: m.category ?? '',
      outcomes: m.outcomes.join('\n'),
    });
  };

  const saveEdit = (id: string) => {
    const outcomes = editForm.outcomes.split('\n').map((s) => s.trim()).filter(Boolean);
    if (outcomes.length < 2) {
      alert('At least 2 outcomes required');
      return;
    }
    setActioning(id);
    adminAPI
      .updateMarket(id, {
        title: editForm.title || undefined,
        description: editForm.description || undefined,
        category: editForm.category || undefined,
        outcomes,
      })
      .then(() => {
        setEditingId(null);
        load();
      })
      .catch((e) => alert(e.response?.data?.error ?? 'Failed'))
      .finally(() => setActioning(null));
  };

  const handleApprove = (id: string) => {
    setActioning(id);
    adminAPI
      .approveMarket(id)
      .then(() => load())
      .catch((e) => alert(e.response?.data?.error ?? 'Failed'))
      .finally(() => setActioning(null));
  };

  const handleReject = (id: string) => {
    if (!confirm('Reject this market? It will be set to CANCELLED.')) return;
    setActioning(id);
    adminAPI
      .rejectMarket(id)
      .then(() => load())
      .catch((e) => alert(e.response?.data?.error ?? 'Failed'))
      .finally(() => setActioning(null));
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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Pending Markets</h1>
      <div className="space-y-4">
        {markets.map((m) => (
          <div
            key={m.id}
            className="bg-white dark:bg-dark-card rounded-lg shadow p-6 border border-gray-200 dark:border-[rgba(255,255,255,0.08)]"
          >
            <div className="flex justify-between items-start gap-4">
              <div className="min-w-0 flex-1">
                {editingId === m.id ? (
                  <div className="space-y-2">
                    <input
                      value={editForm.title}
                      onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                      className="w-full px-2 py-1 border rounded dark:bg-dark-secondary dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary"
                      placeholder="Title"
                    />
                    <input
                      value={editForm.description}
                      onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                      className="w-full px-2 py-1 border rounded dark:bg-dark-secondary dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary"
                      placeholder="Description"
                    />
                    <input
                      value={editForm.category}
                      onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
                      className="w-full px-2 py-1 border rounded dark:bg-dark-secondary dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary"
                      placeholder="Category"
                    />
                    <textarea
                      value={editForm.outcomes}
                      onChange={(e) => setEditForm((f) => ({ ...f, outcomes: e.target.value }))}
                      className="w-full px-2 py-1 border rounded dark:bg-dark-secondary dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary"
                      placeholder="Outcomes (one per line)"
                      rows={3}
                    />
                    <div className="flex gap-2">
                      <button onClick={() => saveEdit(m.id)} disabled={actioning !== null} className="px-3 py-1 bg-primary-600 text-white rounded text-sm">Save</button>
                      <button onClick={() => setEditingId(null)} className="px-3 py-1 bg-gray-500 text-white rounded text-sm">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h3 className="font-semibold text-gray-900 dark:text-white">{m.title}</h3>
                    <table className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                      <tbody>
                        <tr><td className="pr-4 py-0.5">Proposed by</td><td>{m.creator.username} ({m.creator.email})</td></tr>
                        <tr><td className="pr-4 py-0.5">Category</td><td>{m.category ?? '—'}</td></tr>
                        <tr><td className="pr-4 py-0.5">Subcategory</td><td>{m.subCategory ?? '—'}</td></tr>
                        <tr><td className="pr-4 py-0.5">Market type</td><td>{m.marketType ?? '—'}</td></tr>
                        <tr><td className="pr-4 py-0.5">Options</td><td>{m.outcomes.join(', ')}</td></tr>
                        <tr><td className="pr-4 py-0.5">Starts at</td><td>{m.startsAt ? format(new Date(m.startsAt), 'PPp') : '—'}</td></tr>
                        <tr><td className="pr-4 py-0.5">Created</td><td>{format(new Date(m.createdAt), 'PPp')}</td></tr>
                      </tbody>
                    </table>
                  </>
                )}
              </div>
              {editingId !== m.id && (
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEdit(m)}
                    disabled={actioning !== null}
                    className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleApprove(m.id)}
                    disabled={actioning !== null}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                  >
                    {actioning === m.id ? '…' : 'Approve'}
                  </button>
                  <button
                    onClick={() => handleReject(m.id)}
                    disabled={actioning !== null}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    {actioning === m.id ? '…' : 'Reject'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {markets.length === 0 && (
        <p className="text-gray-500 dark:text-gray-400">No pending markets.</p>
      )}
    </div>
  );
}
