'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';

function toLocalDateTimeString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${min}`;
}

/** Returns clamped value only when input is a complete datetime (YYYY-MM-DDTHH:mm). Otherwise returns value as-is so typing isn't reset. */
function clampDateTimeLocal(value: string, min: string, max: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length < 16) return trimmed;
  const parsed = trimmed.slice(0, 16);
  const valDate = new Date(parsed);
  if (Number.isNaN(valDate.getTime())) return trimmed;
  const minDate = new Date(min);
  const maxDate = new Date(max);
  if (valDate < minDate) return min;
  if (valDate > maxDate) return max;
  return parsed;
}

const CATEGORIES = [
  { value: 'crypto', label: 'Crypto' },
  { value: 'cybersport', label: 'Cybersport' },
  { value: 'sports', label: 'Sports' },
  { value: 'politics', label: 'Politics' },
  { value: 'events', label: 'Events' },
] as const;

export default function AdminCreateBattlePage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    category: 'crypto',
    outcomes: ['', ''],
    startsAt: '',
    endDate: '',
  });
  /** Local value for date inputs so typing isn't overwritten by validation; commit on blur. */
  const [startDateInput, setStartDateInput] = useState('');
  const [endDateInput, setEndDateInput] = useState('');

  const { minDateTime, maxDateTime } = useMemo(() => {
    const now = new Date();
    const min = new Date(now.getTime());
    min.setSeconds(0, 0);
    const max = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return {
      minDateTime: toLocalDateTimeString(min),
      maxDateTime: toLocalDateTimeString(max),
    };
  }, [mounted]);

  useEffect(() => setMounted(true), []);

  const handleStartDateInputChange = (value: string) => {
    setStartDateInput(value);
  };

  const handleStartDateBlur = () => {
    const clamped = clampDateTimeLocal(startDateInput, minDateTime, maxDateTime);
    setFormData((prev) => ({ ...prev, startsAt: clamped }));
    setStartDateInput(clamped);
  };

  const minEndDateTime =
    formData.startsAt && formData.category === 'politics'
      ? toLocalDateTimeString(new Date(formData.startsAt))
      : minDateTime;

  const handleEndDateInputChange = (value: string) => {
    setEndDateInput(value);
  };

  const handleEndDateBlur = () => {
    const clamped = clampDateTimeLocal(endDateInput, minEndDateTime, maxDateTime);
    setFormData((prev) => ({ ...prev, endDate: clamped }));
    setEndDateInput(clamped);
  };
  const politicsDurationMinutes = formData.category === 'politics' && formData.startsAt && formData.endDate
    ? (new Date(formData.endDate).getTime() - new Date(formData.startsAt).getTime()) / (60 * 1000)
    : null;
  const politicsDurationHours = politicsDurationMinutes != null ? Math.floor(politicsDurationMinutes / 60) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const isPolitics = formData.category === 'politics';
      if (isPolitics && !formData.startsAt) {
        alert('For Politics, set Start date.');
        setSubmitting(false);
        return;
      }
      if (!formData.endDate) {
        alert('Please select an end date.');
        setSubmitting(false);
        return;
      }
      const dateObject = new Date(formData.endDate);
      if (isPolitics && formData.startsAt) {
        const startObj = new Date(formData.startsAt);
        if (dateObject <= startObj) {
          alert('End date must be after start date.');
          setSubmitting(false);
          return;
        }
      }
      if (isNaN(dateObject.getTime())) {
        alert('Invalid date.');
        setSubmitting(false);
        return;
      }
      const now = new Date();
      const maxEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      if (dateObject < now) {
        alert('End date must be in the future.');
        setSubmitting(false);
        return;
      }
      if (dateObject > maxEnd) {
        alert('End date must be within 30 days from now.');
        setSubmitting(false);
        return;
      }

      const payload: { title: string; description?: string; category?: string; outcomes: string[]; endDate?: string; startsAt?: string } = {
        ...formData,
        endDate: dateObject.toISOString(),
      };
      if (isPolitics && formData.startsAt) payload.startsAt = new Date(formData.startsAt).toISOString();
      const res = await adminAPI.createMarket(payload);
      const created = res.data as { id?: string };
      if (created?.id) {
        router.push(`/markets/${created.id}`);
        router.refresh();
      } else {
        router.push('/');
        router.refresh();
      }
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } }; message?: string };
      alert(err.response?.data?.error ?? err.message ?? 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  };

  const updateOutcome = (index: number, value: string) => {
    const newOutcomes = [...formData.outcomes];
    newOutcomes[index] = value;
    setFormData({ ...formData, outcomes: newOutcomes });
  };

  const addOutcome = () => {
    setFormData({ ...formData, outcomes: [...formData.outcomes, ''] });
  };

  if (!mounted) return null;

  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <Link href="/admin" className="text-sm text-primary-600 dark:text-primary-400 hover:underline">
          ← Dashboard
        </Link>
      </div>
      <div className="p-6 bg-white dark:bg-dark-card text-gray-900 dark:text-dark-text-primary rounded-2xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] shadow-lg">
        <h1 className="text-2xl font-bold mb-2 text-primary-600">Create Battle</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Published immediately. No moderation. Only for admins.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Title</label>
            <input
              className="w-full p-3 bg-gray-50 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="e.g. Will BTC reach $100k?"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Description</label>
            <textarea
              className="w-full p-3 bg-gray-50 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none h-24 resize-y"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Add details..."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Category</label>
              <select
                className="w-full p-3 bg-gray-50 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
              >
                {CATEGORIES.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {formData.category === 'politics' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Start date & time</label>
                <input
                  type="datetime-local"
                  min={minDateTime}
                  max={maxDateTime}
                  step={60}
                  className="w-full p-3 bg-gray-50 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  value={startDateInput || formData.startsAt}
                  onChange={(e) => handleStartDateInputChange(e.target.value)}
                  onBlur={handleStartDateBlur}
                  required={formData.category === 'politics'}
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {formData.category === 'politics' ? 'End date & time (closes)' : 'End date & time'}
              </label>
              <input
                type="datetime-local"
                min={minEndDateTime}
                max={maxDateTime}
                step={60}
                className="w-full p-3 bg-gray-50 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                value={endDateInput || formData.endDate}
                onChange={(e) => handleEndDateInputChange(e.target.value)}
                onBlur={handleEndDateBlur}
                required
              />
              {politicsDurationMinutes != null && (
                <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                  Duration: {politicsDurationMinutes < 60 ? `${Math.round(politicsDurationMinutes)} min` : `${politicsDurationHours}h`}
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Time is in UTC.</p>
            </div>
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Outcome options</label>
            {formData.outcomes.map((outcome, index) => (
              <input
                key={index}
                className="w-full p-3 bg-gray-50 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                placeholder={`Option ${index + 1}`}
                value={outcome}
                onChange={(e) => updateOutcome(index, e.target.value)}
                required
              />
            ))}
            <button
              type="button"
              onClick={addOutcome}
              className="text-primary-600 dark:text-primary-400 text-sm font-medium hover:underline"
            >
              + Add option
            </button>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full p-4 bg-primary-600 text-white rounded-xl font-semibold text-lg hover:bg-primary-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Creating…' : 'Create & Publish'}
          </button>
        </form>
      </div>
    </div>
  );
}
