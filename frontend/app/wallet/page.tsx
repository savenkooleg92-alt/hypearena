'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { walletAPI, type WithdrawalItem, type WithdrawQuote } from '@/lib/api';
import { playWithdrawSuccess } from '@/lib/soundStore';
import { format } from 'date-fns';

/** Backend supports TRON | SOL | MATIC; TRON hidden in UI for now (configured in backend). */
const DEPOSIT_NETWORKS: { id: 'SOL' | 'MATIC'; label: string }[] = [
  { id: 'SOL', label: 'Solana (USDC)' },
  { id: 'MATIC', label: 'Polygon (USDT)' },
];

const WITHDRAW_NETWORKS: { id: 'MATIC' | 'SOL'; label: string }[] = [
  { id: 'MATIC', label: 'Polygon (USDT)' },
  { id: 'SOL', label: 'Solana (USDC)' },
];

const MIN_WITHDRAW: Record<string, number> = {
  TRON: 20,
  MATIC: 1,
  SOL: 1,
};

const ADDRESS_REGEX: Record<string, RegExp> = {
  TRON: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  MATIC: /^0x[a-fA-F0-9]{40}$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

function validateAddress(network: string, value: string): string | null {
  if (!value.trim()) return 'Address is required';
  const re = ADDRESS_REGEX[network];
  if (!re) return null;
  return re.test(value.trim()) ? null : 'Invalid address format for selected network';
}

export default function WalletPage() {
  const router = useRouter();
  const { user, token, authVerified } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw'>('deposit');

  const [selectedNetwork, setSelectedNetwork] = useState<'SOL' | 'MATIC'>('SOL');
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [withdrawNetwork, setWithdrawNetwork] = useState<'MATIC' | 'SOL'>('MATIC');
  const [withdrawAddress, setWithdrawAddress] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [withdrawSuccess, setWithdrawSuccess] = useState<string | null>(null);
  const [withdrawSuccessBreakdown, setWithdrawSuccessBreakdown] = useState<{
    amountRequested: number;
    feeUsd: number;
    amountToSend: number;
    currency: string;
  } | null>(null);
  const [copyTooltip, setCopyTooltip] = useState(false);
  const [polygonPaidOpen, setPolygonPaidOpen] = useState(false);
  const [polygonTxHash, setPolygonTxHash] = useState('');
  const [polygonSubmitLoading, setPolygonSubmitLoading] = useState(false);
  const [polygonSubmitResult, setPolygonSubmitResult] = useState<string | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalItem[]>([]);
  const [withdrawalsLoading, setWithdrawalsLoading] = useState(false);
  const [withdrawQuote, setWithdrawQuote] = useState<WithdrawQuote | null>(null);
  const [withdrawQuoteLoading, setWithdrawQuoteLoading] = useState(false);

  type TxItem = {
    id: string;
    type: 'Deposit' | 'Withdraw';
    amountGross: number;
    fee: number;
    netAmount: number;
    currency: string;
    network: string;
    status: string;
    createdAt: string;
  };
  const [transactions, setTransactions] = useState<TxItem[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);

  type MyDeposit = {
    id: string;
    network: string;
    txHash: string;
    depositAddress: string;
    rawAmount: number;
    amountUsd: number;
    status: string;
    isBelowMinimum: boolean | null;
    createdAt: string;
  };
  const [myDeposits, setMyDeposits] = useState<MyDeposit[]>([]);
  const [myDepositsLoading, setMyDepositsLoading] = useState(false);

  const fetchWithdrawQuote = useCallback(async (network: 'MATIC' | 'SOL', amount: number) => {
    if (amount <= 0 || Number.isNaN(amount)) {
      setWithdrawQuote(null);
      return;
    }
    setWithdrawQuoteLoading(true);
    try {
      const res = await walletAPI.getWithdrawQuote(network, amount);
      const data = res.data as (WithdrawQuote & { ok?: boolean }) | undefined;
      if (data && typeof data.amountToSend === 'number') {
        setWithdrawQuote({
          amountRequested: data.amountRequested,
          feeUsd: data.feeUsd,
          amountToSend: data.amountToSend,
          currency: data.currency ?? (network === 'SOL' ? 'USDC' : 'USDT'),
          networkFeeInfo: data.networkFeeInfo ?? '',
        });
      } else {
        setWithdrawQuote(null);
      }
    } catch {
      setWithdrawQuote(null);
    } finally {
      setWithdrawQuoteLoading(false);
    }
  }, []);

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
    loadAddresses();
  }, [token, authVerified, user, router]);

  useEffect(() => {
    if (!user) return;
    setTransactionsLoading(true);
    walletAPI
      .getTransactions(50)
      .then((res) => setTransactions(res.data?.items ?? []))
      .catch(() => setTransactions([]))
      .finally(() => setTransactionsLoading(false));
  }, [user]);

  useEffect(() => {
    if (!user || activeTab !== 'deposit') return;
    setMyDepositsLoading(true);
    walletAPI
      .getMyDeposits(15)
      .then((res) => setMyDeposits(res.data?.deposits ?? []))
      .catch(() => setMyDeposits([]))
      .finally(() => setMyDepositsLoading(false));
  }, [user, activeTab]);

  useEffect(() => {
    if (activeTab === 'withdraw' && user) {
      setWithdrawalsLoading(true);
      walletAPI
        .getWithdrawals()
        .then((res) => setWithdrawals(res.data?.items?.slice(0, 10) ?? []))
        .catch(() => setWithdrawals([]))
        .finally(() => setWithdrawalsLoading(false));
    }
  }, [activeTab, user]);

  useEffect(() => {
    if (activeTab !== 'withdraw') return;
    const raw = withdrawAmount.trim();
    const num = parseFloat(raw);
    if (raw === '' || Number.isNaN(num) || num <= 0) {
      setWithdrawQuote(null);
      return;
    }
    const t = setTimeout(() => fetchWithdrawQuote(withdrawNetwork, num), 300);
    return () => clearTimeout(t);
  }, [activeTab, withdrawNetwork, withdrawAmount, fetchWithdrawQuote]);

  const loadAddresses = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await walletAPI.getAddresses();
      setAddresses(res.data.addresses ?? {});
    } catch (e) {
      console.error('Failed to load addresses:', e);
      setAddresses({});
      setError('Failed to load addresses');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!selectedNetwork) return;
    try {
      setGenerating(true);
      setError(null);
      await walletAPI.createAddress(selectedNetwork);
      await loadAddresses();
    } catch (e: unknown) {
      const data = e && typeof e === 'object' && 'response' in e ? (e as { response?: { data?: Record<string, unknown> } }).response?.data : undefined;
      const msg = data && typeof data === 'object' && (data.message || data.error)
        ? String(data.message ?? data.error)
        : 'Failed to generate address';
      setError(msg);
    } finally {
      setGenerating(false);
    }
  };

  const balance = user?.balance ?? 0;
  const balanceFormatted = balance.toFixed(2);
  const minWithdraw = MIN_WITHDRAW[withdrawNetwork] ?? 1;
  const amountNum = parseFloat(withdrawAmount);
  const amountValid = !Number.isNaN(amountNum) && amountNum > 0;
  const amountAboveMin = amountValid && amountNum >= minWithdraw;
  const amountWithinBalance = amountValid && amountNum <= balance;
  const addressError = validateAddress(withdrawNetwork, withdrawAddress);
  const addressValid = !addressError;

  const receiveAmountValid = useMemo(
    () => withdrawQuote != null && withdrawQuote.amountToSend > 0,
    [withdrawQuote]
  );

  const withdrawFormValid = useMemo(() => {
    if (!amountValid || !amountAboveMin || !amountWithinBalance || !addressValid || withdrawSubmitting) return false;
    if (!receiveAmountValid) return false;
    return true;
  }, [amountValid, amountAboveMin, amountWithinBalance, addressValid, withdrawSubmitting, receiveAmountValid]);

  const withdrawButtonDisabled = !withdrawFormValid;

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (withdrawButtonDisabled) return;
    setWithdrawError(null);
    setWithdrawSuccess(null);
    setWithdrawSuccessBreakdown(null);
    setWithdrawSubmitting(true);
    try {
      const res = await walletAPI.withdraw({
        network: withdrawNetwork,
        toAddress: withdrawAddress.trim(),
        amount: amountNum,
      });
      const newBalance = res.data?.updatedBalance;
      if (newBalance != null) useAuthStore.getState().updateBalance(newBalance);
      const b = res.data?.breakdown;
      if (b) {
        setWithdrawSuccessBreakdown({
          amountRequested: b.amountRequested,
          feeUsd: b.feeUsd,
          amountToSend: b.amountToSend,
          currency: b.currency ?? (withdrawNetwork === 'SOL' ? 'SOL' : 'USDT'),
        });
      }
      setWithdrawSuccess('Withdrawal request submitted.');
      setWithdrawError(null);
      playWithdrawSuccess();
      setWithdrawAmount('');
      setWithdrawAddress('');
      setWithdrawQuote(null);
      setWithdrawals((prev) => {
        const wr = res.data?.request;
        if (wr) return [wr, ...prev].slice(0, 10);
        return prev;
      });
    } catch (e: unknown) {
      const data = e && typeof e === 'object' && 'response' in e ? (e as { response?: { data?: Record<string, unknown> } }).response?.data : undefined;
      const msg = data && typeof data === 'object' && (data.message || data.error)
        ? String(data.message ?? data.error)
        : 'Withdrawal failed';
      setWithdrawError(msg);
    } finally {
      setWithdrawSubmitting(false);
    }
  };

  const authLoading = Boolean(token && !authVerified);
  if (authLoading || !token || (authVerified && user === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-700 dark:text-dark-text-secondary">
        <div className="flex items-center gap-2">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-500 border-t-transparent" />
          <span>{authLoading ? 'Checking auth…' : 'Redirecting…'}</span>
        </div>
      </div>
    );
  }
  if (!user) return null;

  const currentAddress = addresses[selectedNetwork];

  return (
    <div className="max-w-2xl mx-auto p-6 text-gray-900 dark:text-dark-text-primary min-h-screen">
      <h1 className="text-2xl font-bold mb-6 text-primary-600 dark:text-primary-400">Wallet</h1>

      <div className="bg-white dark:bg-dark-card p-6 rounded-2xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] mb-6">
        <h2 className="text-gray-500 dark:text-dark-text-muted text-xs font-bold uppercase mb-2">Balance</h2>
        <p className="text-3xl font-bold text-green-600 dark:text-dark-live-text">${balanceFormatted}</p>
      </div>

      <div className="flex rounded-xl bg-gray-200 dark:bg-dark-secondary p-1 mb-6">
        <button
          type="button"
          onClick={() => setActiveTab('deposit')}
          className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
            activeTab === 'deposit' ? 'bg-primary-600 text-white' : 'text-gray-600 dark:text-dark-text-secondary hover:text-gray-900 dark:hover:text-dark-text-primary'
          }`}
        >
          Deposit
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('withdraw')}
          className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
            activeTab === 'withdraw' ? 'bg-primary-600 text-white' : 'text-gray-600 dark:text-dark-text-secondary hover:text-gray-900 dark:hover:text-dark-text-primary'
          }`}
        >
          Withdraw
        </button>
      </div>

      {activeTab === 'deposit' && (
        <div className="bg-white dark:bg-dark-card p-6 rounded-2xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
          <h2 className="text-gray-500 dark:text-dark-text-muted text-xs font-bold uppercase mb-2">Deposit address</h2>
          <p className="text-amber-600 dark:text-amber-400 text-sm mb-4">
            Minimum deposit: $1 (Solana USDC, Polygon USDT). Deposits below minimum are not credited.
          </p>

          <div className="flex flex-wrap gap-2 mb-4">
            {DEPOSIT_NETWORKS.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setSelectedNetwork(n.id)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition ${
                  selectedNetwork === n.id
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-200 dark:bg-dark-secondary text-gray-700 dark:text-dark-text-primary hover:bg-gray-300 dark:hover:bg-dark-card-hover'
                }`}
              >
                {n.label}
              </button>
            ))}
          </div>

          {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

          {loading ? (
            <p className="text-gray-500 dark:text-dark-text-secondary">Loading...</p>
          ) : currentAddress ? (
            <>
              {selectedNetwork === 'SOL' && (
                <p className="text-sm text-blue-600 dark:text-blue-400 mb-3">
                  Send only <strong>USDC</strong> (SPL token) to this address. Your wallet will send to the USDC token account for this address. Do not send native SOL.
                </p>
              )}
              <div className="relative">
                <div className="bg-gray-100 dark:bg-dark-secondary p-3 rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] mb-3">
                  <code className="text-sm text-primary-700 dark:text-primary-300 break-all">{currentAddress}</code>
                </div>
                {copyTooltip && (
                  <div
                    className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full mb-1 px-3 py-1.5 rounded-lg bg-green-600 dark:bg-green-500 text-white text-sm font-medium shadow-lg animate-copy-tooltip-in"
                    style={{ marginBottom: '4px' }}
                  >
                    Copied ✓
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(currentAddress);
                  setCopyTooltip(true);
                  setTimeout(() => setCopyTooltip(false), 1200);
                }}
                className="w-full bg-primary-600 hover:bg-primary-500 dark:bg-primary-500 dark:hover:bg-primary-600 active:scale-[0.98] p-2 rounded-xl text-sm font-bold text-white transition-transform duration-150"
              >
                Copy address
              </button>

              {selectedNetwork === 'MATIC' && (
                <>
                  <button
                    type="button"
                    onClick={() => { setPolygonPaidOpen(true); setPolygonSubmitResult(null); setPolygonTxHash(''); }}
                    className="mt-3 w-full bg-emerald-600 hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-600 active:scale-[0.98] p-2 rounded-xl text-sm font-bold text-white transition-transform duration-150"
                  >
                    I paid
                  </button>
                  {polygonPaidOpen && (
                    <div className="mt-4 p-4 rounded-xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-gray-50 dark:bg-dark-secondary">
                      <p className="text-sm text-gray-600 dark:text-dark-text-secondary mb-2">
                        Paste the <strong>Transaction Hash</strong> from Polygonscan (the payment to your deposit address). Admin will verify and credit once. One hash = one credit only.
                      </p>
                      <input
                        type="text"
                        value={polygonTxHash}
                        onChange={(e) => { setPolygonTxHash(e.target.value); setPolygonSubmitResult(null); }}
                        placeholder="0x..."
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-card text-gray-900 dark:text-dark-text-primary font-mono text-sm mb-2"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            const h = polygonTxHash.trim();
                            if (!h) { setPolygonSubmitResult('Enter Transaction Hash'); return; }
                            setPolygonSubmitLoading(true);
                            setPolygonSubmitResult(null);
                            try {
                              const res = await walletAPI.submitPolygonTxHash(h);
                              setPolygonSubmitResult(res.data?.message ?? 'Submitted.');
                            } catch (e: unknown) {
                              const data = e && typeof e === 'object' && 'response' in e ? (e as { response?: { data?: { error?: string } } }).response?.data : undefined;
                              setPolygonSubmitResult(data?.error ?? 'Submit failed');
                            } finally {
                              setPolygonSubmitLoading(false);
                            }
                          }}
                          disabled={polygonSubmitLoading}
                          className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50"
                        >
                          {polygonSubmitLoading ? 'Sending…' : 'Submit'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPolygonPaidOpen(false)}
                          className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm"
                        >
                          Close
                        </button>
                      </div>
                      {polygonSubmitResult && (
                        <p className={`mt-2 text-sm ${polygonSubmitResult.includes('Submitted') || polygonSubmitResult === 'Submitted.' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {polygonSubmitResult}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

              <div className="mt-6 pt-4 border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
                <h3 className="text-gray-500 dark:text-dark-text-muted text-xs font-bold uppercase mb-2">Your deposit status</h3>
                <p className="text-sm text-gray-600 dark:text-dark-text-secondary mb-2">
                  Amounts you sent and their status. USDC is detected every 1–2 minutes; if it does not appear, обратитесь в саппорт в правом нижнем углу.
                </p>
                {myDepositsLoading ? (
                  <p className="text-sm text-gray-500">Loading…</p>
                ) : myDeposits.length === 0 ? (
                  <p className="text-sm text-gray-500">No deposit records yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {myDeposits.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-medium text-gray-800 dark:text-dark-text-primary">
                          ${typeof d.amountUsd === 'number' ? d.amountUsd.toFixed(2) : d.rawAmount?.toFixed(2) ?? '—'} ({d.network})
                        </span>
                        <span className={`${d.status === 'CREDITED' ? 'text-green-600 dark:text-green-400' : d.status === 'FAILED' ? 'text-amber-600' : 'text-gray-500'}`}>
                          {d.status}
                          {d.isBelowMinimum ? ' (below min)' : ''}
                        </span>
                        {d.txHash && d.network === 'SOL' && (
                          <a
                            href={`https://solscan.io/tx/${d.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-600 dark:text-primary-400 hover:underline"
                          >
                            View on Solscan
                          </a>
                        )}
                        <span className="text-gray-400 dark:text-dark-text-muted text-xs">{format(new Date(d.createdAt), 'PPp')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-gray-500 dark:text-dark-text-secondary mb-3">No address yet</p>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                className="w-full bg-primary-600 hover:bg-primary-500 dark:bg-primary-500 dark:hover:bg-primary-600 disabled:opacity-50 p-2 rounded-xl text-sm font-bold text-white transition-all"
              >
                {generating ? 'Generating...' : 'Generate address'}
              </button>
            </>
          )}
        </div>
      )}

      {activeTab === 'withdraw' && (
        <>
          <div className="bg-white dark:bg-dark-card p-6 rounded-2xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] mb-6">
            <h2 className="text-gray-500 dark:text-dark-text-muted text-xs font-bold uppercase mb-4">Withdraw</h2>
            <p className="text-sm text-gray-600 dark:text-dark-text-secondary mb-2">Available balance: ${balanceFormatted}</p>
            <p className="text-sm text-amber-600 dark:text-amber-400 mb-4">
              Minimum withdrawal: $1 (Polygon, Solana)
            </p>

            <form onSubmit={handleWithdraw} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Network</label>
                <select
                  value={withdrawNetwork}
                  onChange={(e) => setWithdrawNetwork(e.target.value as 'MATIC' | 'SOL')}
                  disabled={withdrawSubmitting}
                  className="w-full px-4 py-2 rounded-lg bg-gray-100 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] text-gray-900 dark:text-dark-text-primary disabled:opacity-50"
                >
                  {WITHDRAW_NETWORKS.map((n) => (
                    <option key={n.id} value={n.id}>{n.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">To address</label>
                <input
                  type="text"
                  value={withdrawAddress}
                  onChange={(e) => { setWithdrawAddress(e.target.value); setWithdrawError(null); }}
                  disabled={withdrawSubmitting}
                  placeholder={withdrawNetwork === 'MATIC' ? '0x...' : 'Base58 address'}
                  className="w-full px-4 py-2 rounded-lg bg-gray-100 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] text-gray-900 dark:text-dark-text-primary placeholder:dark:text-dark-text-muted disabled:opacity-50"
                />
                {addressError && !withdrawSuccess && <p className="mt-1 text-sm text-red-400">{addressError}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Amount (you pay), USD</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={withdrawAmount}
                  onChange={(e) => { setWithdrawAmount(e.target.value); setWithdrawError(null); }}
                  disabled={withdrawSubmitting}
                  className="w-full px-4 py-2 rounded-lg bg-gray-100 dark:bg-dark-secondary border border-gray-300 dark:border-[rgba(255,255,255,0.08)] text-gray-900 dark:text-dark-text-primary disabled:opacity-50"
                />
                {withdrawAmount && !amountValid && <p className="mt-1 text-sm text-red-400">Enter a valid amount</p>}
                {amountValid && !amountAboveMin && <p className="mt-1 text-sm text-red-400">Minimum for {withdrawNetwork} is ${minWithdraw}</p>}
                {amountValid && amountAboveMin && !amountWithinBalance && <p className="mt-1 text-sm text-red-400">Amount exceeds available balance</p>}
              </div>

              <div className="rounded-xl bg-gray-100 dark:bg-slate-700/60 border border-gray-200 dark:border-slate-600 p-4 space-y-2">
                <p className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Estimated receive</p>
                {withdrawQuoteLoading && !withdrawQuote ? (
                  <p className="text-sm text-gray-500">Calculating…</p>
                ) : withdrawQuote ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500 dark:text-slate-400">Amount (you pay)</span>
                      <span className="text-gray-900 dark:text-slate-100 font-medium">${withdrawQuote.amountRequested.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm items-center gap-2">
                      <span className="text-gray-500 dark:text-slate-400 flex items-center gap-1">
                        Estimated fee
                        <span
                          className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-gray-600 text-gray-300 text-xs cursor-help"
                          title="Fees are required by the blockchain and may vary."
                        >
                          ?
                        </span>
                      </span>
                      <span className="text-white font-medium">
                        {withdrawQuote.feeUsd === 0 ? 'Fee paid by platform' : `$${withdrawQuote.feeUsd.toFixed(2)}`}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm pt-1 border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
                      <span className="text-gray-700 dark:text-dark-text-secondary font-medium">You will receive</span>
                      <span className="text-green-400 font-bold">
                        {withdrawQuote.amountToSend <= 0
                          ? '$0.00'
                          : `$${withdrawQuote.amountToSend.toFixed(2)} ${withdrawQuote.currency}`}
                      </span>
                    </div>
                    {withdrawQuote.amountToSend <= 0 && amountValid && amountNum > 0 && (
                      <p className="text-xs text-amber-400">Amount too small after fee. Increase amount.</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-dark-text-secondary">Enter an amount to see estimate.</p>
                )}
              </div>

              {withdrawError && <p className="text-sm text-red-400">{withdrawError}</p>}
              {withdrawSuccess && (
                <div className="animate-withdraw-success-in text-sm text-green-400 space-y-1">
                  <p className="font-semibold text-green-600 dark:text-green-400">Withdrawal Created</p>
                  {withdrawSuccessBreakdown && (
                    <div className="mt-2 p-4 rounded-xl bg-green-900/20 dark:bg-dark-live-bg/30 border border-green-700/50 dark:border-green-500/30 text-green-300 dark:text-dark-live-text text-xs space-y-2">
                      <p><span className="text-green-500 dark:text-dark-text-secondary">Amount:</span> ${withdrawSuccessBreakdown.amountRequested.toFixed(2)}</p>
                      <p><span className="text-green-500 dark:text-dark-text-secondary">Network:</span> {withdrawSuccessBreakdown.currency}</p>
                      <p><span className="text-green-500 dark:text-dark-text-secondary">Estimated receive:</span> ${withdrawSuccessBreakdown.amountToSend.toFixed(2)} {withdrawSuccessBreakdown.currency}</p>
                    </div>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={withdrawButtonDisabled}
                className="w-full py-3 rounded-xl font-semibold bg-primary-600 dark:bg-primary-500 text-white hover:bg-primary-500 dark:hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
              >
                {withdrawSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                    Submitting…
                  </>
                ) : (
                  'Withdraw'
                )}
              </button>
            </form>
          </div>

          <div className="bg-white dark:bg-dark-card p-6 rounded-2xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
            <h3 className="text-gray-500 dark:text-dark-text-muted text-xs font-bold uppercase mb-3">Recent withdrawals (last 10)</h3>
            {withdrawalsLoading ? (
              <p className="text-gray-500 dark:text-dark-text-secondary text-sm">Loading…</p>
            ) : withdrawals.length === 0 ? (
              <p className="text-gray-500 dark:text-dark-text-secondary text-sm">No withdrawals yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="text-gray-500 dark:text-dark-text-muted border-b border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
                      <th className="py-2 pr-4">Network</th>
                      <th className="py-2 pr-4">Requested</th>
                      <th className="py-2 pr-4">Fee</th>
                      <th className="py-2 pr-4">You receive</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withdrawals.map((w) => (
                      <tr key={w.id} className="border-b border-gray-100 dark:border-[rgba(255,255,255,0.08)] dark:hover:bg-[rgba(255,255,255,0.04)] transition">
                        <td className="py-2 pr-4 text-gray-800 dark:text-dark-text-primary">{w.network}</td>
                        <td className="py-2 pr-4">${(w.amountGross ?? 0).toFixed(2)}</td>
                        <td className="py-2 pr-4 text-gray-500 dark:text-dark-text-secondary">
                          {(w.fee ?? 0) === 0 ? '—' : `$${(w.fee ?? 0).toFixed(2)}`}
                        </td>
                        <td className="py-2 pr-4 text-green-600 dark:text-dark-live-text font-medium">${(w.amountNet ?? 0).toFixed(2)}</td>
                        <td className="py-2 pr-4">
                          <span className={
                            w.status === 'COMPLETED' ? 'text-green-600 dark:text-dark-live-text' :
                            w.status === 'FAILED' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                          }>
                            {w.status === 'COMPLETED' ? 'APPROVED' : w.status}
                          </span>
                        </td>
                        <td className="py-2 text-gray-500 dark:text-dark-text-muted">{format(new Date(w.createdAt), 'PPp')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <div className="mt-8 bg-white dark:bg-dark-card rounded-2xl border border-gray-200 dark:border-[rgba(255,255,255,0.08)] p-6">
        <h3 className="text-gray-700 dark:text-dark-text-primary font-semibold mb-4">Transactions history</h3>
        {transactionsLoading ? (
          <p className="text-gray-500 dark:text-dark-text-secondary text-sm">Loading…</p>
        ) : transactions.length === 0 ? (
          <p className="text-gray-500 dark:text-dark-text-secondary text-sm">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-gray-500 dark:text-dark-text-muted border-b border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Amount (gross)</th>
                  <th className="py-2 pr-3">Fee</th>
                  <th className="py-2 pr-3">Net</th>
                  <th className="py-2 pr-3">Currency</th>
                  <th className="py-2 pr-3">Network</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Date (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={`${tx.type}-${tx.id}`} className="border-b border-gray-100 dark:border-[rgba(255,255,255,0.08)] dark:hover:bg-[rgba(255,255,255,0.04)] transition">
                    <td className="py-2 pr-3 font-medium text-gray-800 dark:text-dark-text-primary">{tx.type}</td>
                    <td className="py-2 pr-3 text-gray-700 dark:text-dark-text-secondary">${tx.amountGross.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-gray-500 dark:text-dark-text-muted">
                      {tx.fee === 0 ? '—' : `$${tx.fee.toFixed(2)}`}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={tx.type === 'Deposit' ? 'text-green-600 dark:text-dark-live-text' : 'text-gray-700 dark:text-dark-text-secondary'}>
                        ${tx.netAmount.toFixed(2)}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-dark-text-secondary">{tx.currency}</td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-dark-text-secondary">{tx.network}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={
                          tx.status === 'Credited' || tx.status === 'Completed'
                            ? 'text-green-600 dark:text-dark-live-text'
                            : tx.status === 'Failed'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-600 dark:text-amber-400'
                        }
                      >
                        {tx.status}
                      </span>
                    </td>
                    <td className="py-2 text-gray-500 dark:text-dark-text-muted">{format(new Date(tx.createdAt), 'PPp')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
