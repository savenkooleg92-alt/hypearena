'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { supportAPI } from '@/lib/api';
import { format } from 'date-fns';

const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];
const MAX_FILES = 3;
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

export default function SupportPage() {
  const router = useRouter();
  const { user, token, authVerified } = useAuthStore();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [tickets, setTickets] = useState<Array<{
    id: string;
    subject: string;
    description: string;
    attachments: string[];
    status: string;
    adminReply: string | null;
    repliedAt: string | null;
    createdAt: string;
  }>>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      router.replace('/login');
      return;
    }
    if (!authVerified) return;
    if (user === null) {
      router.replace('/login');
      return;
    }
  }, [token, authVerified, user, router]);

  useEffect(() => {
    if (!token || !user) return;
    supportAPI.getMyTickets()
      .then((res) => setTickets(res.data))
      .catch(() => {});
  }, [token, user, success]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    const valid: File[] = [];
    for (const f of selected) {
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) continue;
      if (f.size > MAX_SIZE) continue;
      valid.push(f);
    }
    setFiles((prev) => [...prev, ...valid].slice(0, MAX_FILES));
    e.target.value = '';
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!subject.trim()) {
      setError('Subject is required.');
      return;
    }
    if (!description.trim() || description.trim().length < 10) {
      setError('Description is required (at least 10 characters).');
      return;
    }
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('subject', subject.trim());
      formData.append('description', description.trim());
      files.forEach((f) => formData.append('attachments', f));
      await supportAPI.createTicket(formData);
      setSuccess(true);
      setSubject('');
      setDescription('');
      setFiles([]);
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again later.');
    } finally {
      setSubmitting(false);
    }
  };

  const statusBadge = (status: string) => {
    const classes =
      status === 'OPEN'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
        : status === 'REPLIED'
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
          : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
    return (
      <span className={`px-2 py-0.5 text-xs font-medium rounded ${classes}`}>
        {status}
      </span>
    );
  };

  const authLoading = Boolean(token && !authVerified);
  if (!token || authLoading || (authVerified && user === null)) {
    return (
      <div className="container mx-auto px-4 py-8 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Support</h1>

      <form onSubmit={handleSubmit} className="bg-white dark:bg-dark-card rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] p-6 shadow space-y-4 mb-8">
        {success && (
          <div className="p-3 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 rounded-lg text-sm">
            Thank you for your patience. We will respond within 24 hours.
          </div>
        )}
        {error && (
          <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Subject (required)</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Briefly describe your issue"
            className="w-full px-3 py-2 border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:bg-dark-secondary dark:text-dark-text-primary rounded-lg"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description (required)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe your issue in detail"
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:bg-dark-secondary dark:text-dark-text-primary rounded-lg"
            required
            minLength={10}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Attachments (optional)</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            .png, .jpg, .jpeg, .webp, .pdf — max 5 MB each, up to 3 files
          </p>
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.pdf"
            multiple
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-primary-50 file:text-primary-700 dark:file:bg-dark-secondary dark:file:text-primary-400"
          />
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-gray-600 dark:text-dark-text-secondary">
                  <span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => removeFile(i)} className="text-red-600 dark:text-red-400 hover:underline">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {submitting ? 'Sending…' : 'Send request'}
        </button>
      </form>

      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Your tickets</h2>
        {tickets.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No tickets yet.</p>
        ) : (
          <ul className="space-y-2">
            {tickets.map((t) => (
              <li
                key={t.id}
                className="bg-white dark:bg-dark-card rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)] overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-dark-card-hover"
                >
                  <span className="font-medium text-gray-900 dark:text-white truncate mr-2">{t.subject}</span>
                  <span className="shrink-0 flex items-center gap-2">
                    {statusBadge(t.status)}
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {format(new Date(t.createdAt), 'MMM d, yyyy')}
                    </span>
                    <svg
                      className={`w-4 h-4 text-gray-500 transition-transform ${expandedId === t.id ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </span>
                </button>
                {expandedId === t.id && (
                  <div className="px-4 pb-4 pt-0 border-t border-gray-100 dark:border-[rgba(255,255,255,0.06)] space-y-3">
                    <p className="text-sm text-gray-700 dark:text-dark-text-secondary whitespace-pre-wrap pt-3">
                      {t.description}
                    </p>
                    {t.attachments.length > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Attachments: {t.attachments.length} file(s)
                      </p>
                    )}
                    {t.adminReply && (
                      <div className="mt-3 p-3 bg-blue-50 dark:bg-dark-secondary rounded-lg">
                        <p className="text-xs font-medium text-blue-800 dark:text-blue-300 mb-1">
                          Reply {t.repliedAt ? format(new Date(t.repliedAt), 'MMM d, yyyy HH:mm') : ''}
                        </p>
                        <p className="text-sm text-gray-700 dark:text-dark-text-secondary whitespace-pre-wrap">
                          {t.adminReply}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
