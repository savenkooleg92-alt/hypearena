'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI, API_URL } from '@/lib/api';
import { format } from 'date-fns';

type Ticket = {
  id: string;
  userId: string;
  username: string;
  userEmail: string;
  subject: string;
  description: string;
  attachments: string[];
  status: string;
  adminReply: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; username: string; email: string };
};

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [closeSending, setCloseSending] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminAPI
      .getSupportTickets(statusFilter || undefined)
      .then((res) => setTickets(res.data ?? []))
      .catch(() => setTickets([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [statusFilter]);

  const handleReply = async (id: string) => {
    if (!replyText.trim()) return;
    setReplySending(true);
    try {
      await adminAPI.replySupportTicket(id, replyText.trim());
      setReplyText('');
      setDetailId(null);
      load();
    } finally {
      setReplySending(false);
    }
  };

  const handleClose = async (id: string) => {
    setCloseSending(id);
    try {
      await adminAPI.closeSupportTicket(id);
      setDetailId(null);
      load();
    } finally {
      setCloseSending(null);
    }
  };

  const detail = detailId ? tickets.find((t) => t.id === detailId) : null;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Support Tickets</h1>
      <div className="mb-4 flex items-center gap-4">
        <span className="text-sm text-gray-600 dark:text-gray-400">Status:</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:bg-dark-secondary dark:text-dark-text-primary rounded-lg text-sm"
        >
          <option value="">All</option>
          <option value="OPEN">OPEN</option>
          <option value="REPLIED">REPLIED</option>
          <option value="CLOSED">CLOSED</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-[rgba(255,255,255,0.08)]">
            <thead className="bg-gray-50 dark:bg-dark-secondary">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Ticket ID</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">User</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Subject</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Created At</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-dark-card divide-y divide-gray-200 dark:divide-[rgba(255,255,255,0.08)]">
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-2 text-sm text-gray-900 dark:text-white font-mono">{t.id.slice(0, 8)}…</td>
                  <td className="px-4 py-2 text-sm text-gray-700 dark:text-dark-text-secondary">
                    {t.username} ({t.userEmail})
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-900 dark:text-white max-w-xs truncate">{t.subject}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-0.5 text-xs rounded ${
                        t.status === 'OPEN'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                          : t.status === 'REPLIED'
                            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                    {format(new Date(t.createdAt), 'MMM d, yyyy HH:mm')}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => setDetailId(detailId === t.id ? null : t.id)}
                      className="text-primary-600 dark:text-primary-400 text-sm hover:underline"
                    >
                      {detailId === t.id ? 'Hide' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="mt-6 p-6 bg-white dark:bg-dark-card rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Ticket: {detail.subject}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
            {detail.user.username} &lt;{detail.user.email}&gt; — {format(new Date(detail.createdAt), 'PPpp')}
          </p>
          <div className="mb-4 p-3 bg-gray-50 dark:bg-dark-secondary rounded-lg">
            <p className="text-sm text-gray-700 dark:text-dark-text-secondary whitespace-pre-wrap">{detail.description}</p>
          </div>
          {detail.attachments.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Attachments</p>
              <ul className="space-y-1">
                {detail.attachments.map((p, i) => {
                  const name = p.split('/').pop() || `file-${i}`;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => {
                          const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
                          fetch(`${API_URL}/support/attachment/${detail.id}/${encodeURIComponent(name)}`, {
                            headers: token ? { Authorization: `Bearer ${token}` } : {},
                          })
                            .then((r) => r.blob())
                            .then((blob) => {
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = name;
                              a.click();
                              URL.revokeObjectURL(url);
                            })
                            .catch(() => {});
                        }}
                        className="text-sm text-primary-600 dark:text-primary-400 hover:underline"
                      >
                        {name} (download)
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {detail.adminReply && (
            <div className="mb-4 p-3 bg-blue-50 dark:bg-dark-secondary rounded-lg">
              <p className="text-xs font-medium text-blue-800 dark:text-blue-300 mb-1">
                Your reply {detail.repliedAt ? format(new Date(detail.repliedAt), 'PPpp') : ''}
              </p>
              <p className="text-sm text-gray-700 dark:text-dark-text-secondary whitespace-pre-wrap">{detail.adminReply}</p>
            </div>
          )}
          {detail.status !== 'CLOSED' && (
            <div className="space-y-2">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type your reply..."
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:bg-dark-secondary dark:text-dark-text-primary rounded-lg text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleReply(detail.id)}
                  disabled={!replyText.trim() || replySending}
                  className="px-4 py-2 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {replySending ? 'Sending…' : 'Send reply'}
                </button>
                <button
                  type="button"
                  onClick={() => handleClose(detail.id)}
                  disabled={closeSending === detail.id}
                  className="px-4 py-2 bg-gray-600 text-white text-sm rounded-lg hover:bg-gray-700 disabled:opacity-50"
                >
                  {closeSending === detail.id ? 'Closing…' : 'Close ticket'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tickets.length === 0 && !loading && (
        <p className="text-gray-500 dark:text-gray-400 py-4">No tickets found.</p>
      )}
    </div>
  );
}
