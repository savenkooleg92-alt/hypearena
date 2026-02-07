'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/store';
import { useSoundStore } from '@/lib/soundStore';
import { usersAPI } from '@/lib/api';

export default function SettingsPage() {
  const router = useRouter();
  const { user, token, authVerified, setUser } = useAuthStore();
  const soundEnabled = useSoundStore((s) => s.enabled);
  const setSoundEnabled = useSoundStore((s) => s.setEnabled);
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailStep, setEmailStep] = useState<'idle' | 'code_sent'>('idle');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailSuccess, setEmailSuccess] = useState(false);
  const [privacyLoading, setPrivacyLoading] = useState(false);
  const [privacyError, setPrivacyError] = useState('');

  useEffect(() => {
    if (!token) {
      router.replace('/login');
      return;
    }
    if (!authVerified || !user) return;
    setEmail(user.email ?? '');
    setIsAnonymous(user.isAnonymous ?? false);
  }, [token, authVerified, user, router]);

  const MIN_PASSWORD_LENGTH = 8;

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess(false);
    if (!currentPassword.trim()) {
      setPasswordError('Current password is required');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setPasswordLoading(true);
    try {
      await usersAPI.updateProfile({
        currentPassword: currentPassword || undefined,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess(true);
    } catch (err: unknown) {
      const data = err && typeof err === 'object' && 'response' in err ? (err as { response?: { data?: { error?: string } } }).response?.data : undefined;
      setPasswordError(data?.error ?? 'Failed to change password');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleRequestEmailCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError('');
    setEmailSuccess(false);
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError('Enter a valid email address');
      return;
    }
    setEmailLoading(true);
    try {
      await usersAPI.requestEmailChange(trimmed);
      setEmailStep('code_sent');
      setEmailCode('');
    } catch (err: unknown) {
      const data = err && typeof err === 'object' && 'response' in err ? (err as { response?: { data?: { error?: string } } }).response?.data : undefined;
      setEmailError(data?.error ?? 'Failed to send code');
    } finally {
      setEmailLoading(false);
    }
  };

  const handleConfirmEmailChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError('');
    setEmailSuccess(false);
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed || emailCode.length !== 6) {
      setEmailError('Enter the 6-digit code sent to your current email');
      return;
    }
    setEmailLoading(true);
    try {
      const res = await usersAPI.confirmEmailChange(trimmed, emailCode);
      const u = res.data as { id: string; email: string; username: string; balance: number; isAdmin?: boolean; isAnonymous?: boolean; createdAt?: string };
      if (u?.email) {
        setUser(u);
        setEmail(u.email);
        setNewEmail('');
        setEmailCode('');
        setEmailStep('idle');
        setEmailSuccess(true);
      }
    } catch (err: unknown) {
      const data = err && typeof err === 'object' && 'response' in err ? (err as { response?: { data?: { error?: string } } }).response?.data : undefined;
      setEmailError(data?.error ?? 'Failed to change email');
    } finally {
      setEmailLoading(false);
    }
  };

  const handleToggleAnonymous = async (checked: boolean) => {
    setPrivacyError('');
    setPrivacyLoading(true);
    try {
      const res = await usersAPI.updateProfile({ isAnonymous: checked });
      const u = res.data;
      setUser({
        id: u.id,
        email: u.email,
        username: u.username,
        balance: u.balance,
        isAdmin: u.isAdmin === true,
        isAnonymous: u.isAnonymous === true,
        createdAt: u.createdAt,
      });
      setIsAnonymous(checked);
    } catch {
      setPrivacyError('Failed to update privacy setting');
    } finally {
      setPrivacyLoading(false);
    }
  };

  const authLoading = Boolean(token && !authVerified);
  if (authLoading || !token || (authVerified && user === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-2 text-gray-600 dark:text-dark-text-secondary">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-500 border-t-transparent" />
          <span>Loading…</span>
        </div>
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="max-w-xl mx-auto p-6 min-h-screen">
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-primary-600 dark:text-primary-400 hover:underline"
        >
          ← Back
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-dark-text-primary mb-8">Settings</h1>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-dark-text-primary mb-4">Account</h2>
        <div className="rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-card p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-dark-text-muted mb-1">
              Current email
            </label>
            <p className="text-gray-900 dark:text-dark-text-primary">{email || '—'}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-dark-text-muted mb-1">
              Nickname
            </label>
            <p className="text-gray-900 dark:text-dark-text-primary">{user.username}</p>
          </div>

          <div className="pt-4 border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-dark-text-secondary mb-3">Change email</h3>
            <p className="text-xs text-gray-500 dark:text-dark-text-muted mb-3">
              A verification code will be sent to your current email. Enter the code to confirm the new address.
            </p>
            {emailStep === 'idle' ? (
              <form onSubmit={handleRequestEmailCode} className="flex flex-wrap gap-2 items-end">
                <div className="min-w-[200px]">
                  <label className="block text-xs text-gray-500 dark:text-dark-text-muted mb-1">New email</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="new@example.com"
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary text-sm"
                    disabled={emailLoading}
                  />
                </div>
                <button
                  type="submit"
                  disabled={emailLoading}
                  className="px-4 py-2 bg-primary-600 dark:bg-primary-500 text-white rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 disabled:opacity-50 text-sm"
                >
                  {emailLoading ? 'Sending…' : 'Send code'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleConfirmEmailChange} className="space-y-2">
                <p className="text-xs text-gray-600 dark:text-dark-text-secondary">Code sent to <strong>{email}</strong>. Enter it below.</p>
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="w-32">
                    <label className="block text-xs text-gray-500 dark:text-dark-text-muted mb-1">6-digit code</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary text-sm font-mono"
                      disabled={emailLoading}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={emailLoading || emailCode.length !== 6}
                    className="px-4 py-2 bg-primary-600 dark:bg-primary-500 text-white rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 disabled:opacity-50 text-sm"
                  >
                    {emailLoading ? 'Confirming…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEmailStep('idle'); setEmailCode(''); setEmailError(''); }}
                    className="px-4 py-2 text-gray-600 dark:text-dark-text-secondary hover:bg-gray-100 dark:hover:bg-dark-secondary rounded-lg text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {emailError && <p className="text-sm text-red-600 dark:text-red-400 mt-2">{emailError}</p>}
            {emailSuccess && <p className="text-sm text-green-600 dark:text-dark-live-text mt-2">Email updated.</p>}
          </div>

          <form onSubmit={handleChangePassword} className="pt-4 border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)] space-y-4">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-dark-text-secondary">Change password</h3>
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-dark-text-muted mb-1">Current password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary"
                placeholder="Current password"
                disabled={passwordLoading}
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-dark-text-muted mb-1">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                disabled={passwordLoading}
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 dark:text-dark-text-muted mb-1">Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary"
                placeholder="Confirm new password"
                disabled={passwordLoading}
                autoComplete="new-password"
              />
            </div>
            {passwordError && <p className="text-sm text-red-600 dark:text-red-400">{passwordError}</p>}
            {passwordSuccess && <p className="text-sm text-green-600 dark:text-dark-live-text">Password updated.</p>}
            <button
              type="submit"
              disabled={passwordLoading || !currentPassword.trim() || !newPassword || newPassword.length < MIN_PASSWORD_LENGTH || newPassword !== confirmPassword}
              className="px-4 py-2 bg-primary-600 dark:bg-primary-500 text-white rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 disabled:opacity-50"
            >
              {passwordLoading ? 'Saving…' : 'Change password'}
            </button>
          </form>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-dark-text-primary mb-4">Sound</h2>
        <div className="rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-card p-6">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="text-gray-800 dark:text-dark-text-primary">
              Sound effects
            </span>
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(e) => setSoundEnabled(e.target.checked)}
              className="h-5 w-5 rounded border-gray-300 dark:border-[rgba(255,255,255,0.08)] text-primary-600 focus:ring-primary-500"
            />
          </label>
          <p className="mt-2 text-sm text-gray-500 dark:text-dark-text-secondary">
            When ON, subtle sounds play for bet confirm, withdraw success, and new messages. Default: OFF.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-800 dark:text-dark-text-primary mb-4">Privacy</h2>
        <div className="rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-card p-6">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="text-gray-800 dark:text-dark-text-primary">
              Hide my nickname
            </span>
            <input
              type="checkbox"
              checked={isAnonymous}
              onChange={(e) => handleToggleAnonymous(e.target.checked)}
              disabled={privacyLoading}
              className="h-5 w-5 rounded border-gray-300 dark:border-[rgba(255,255,255,0.08)] text-primary-600 focus:ring-primary-500"
            />
          </label>
          <p className="mt-2 text-sm text-gray-500 dark:text-dark-text-secondary">
            When ON, your nickname is shown as &quot;Anonymous&quot; in public places (roulette, market pages, chat). You still see your own nickname in the navbar and here.
          </p>
          {privacyError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{privacyError}</p>}
        </div>
      </section>
    </div>
  );
}
