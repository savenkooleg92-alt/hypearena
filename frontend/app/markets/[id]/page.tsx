'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { marketsAPI, betsAPI, usersAPI, chatAPI, type ChatMessage } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useBalanceCount } from '@/hooks/useBalanceCount';
import { playBetConfirm } from '@/lib/soundStore';
import { format } from 'date-fns';

/** Platform fee (parimutuel). Must match backend. */
const PLATFORM_FEE = 0.015;

interface RelatedMarket {
  id: string;
  title: string;
  status: string;
  outcomes: string[];
  odds: Record<string, number>;
  totalVolume: number;
  startsAt?: string | null;
  winningOutcome?: string | null;
  marketType?: string | null;
}

interface Market {
  id: string;
  title: string;
  description?: string;
  category?: string;
  status: string;
  outcomes: string[];
  odds: Record<string, number>;
  totalVolume: number;
  startsAt?: string | null;
  endsAt?: string | null;
  resolvedAt?: string | null;
  winningOutcome?: string | null;
  eventKey?: string;
  relatedMarkets?: RelatedMarket[];
  creator: {
    id: string;
    username: string;
  };
  bets: Array<{
    id: string;
    outcome: string;
    amount: number;
    user: {
      username: string;
    };
  }>;
}

function formatUTC(date: string): string {
  return new Date(date).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
}

/** Cybersport/sports: 30 min after start we show ENDED (awaiting result); matches backend resolution window. */
const CYBERSPORT_ENDED_AFTER_MS = 30 * 60 * 1000;

/** Non-Politics lifecycle. AWAITING_RESULT = match ended, manual confirm needed. */
function getMarketLifecycleStatus(market: Market): 'UPCOMING' | 'LIVE' | 'ENDED' | 'RESOLVED' | 'AWAITING_RESULT' {
  if (market.status === 'RESOLVED' || market.status === 'CLOSED') return 'RESOLVED';
  if (market.status === 'AWAITING_RESULT') return 'AWAITING_RESULT';
  if (market.status === 'CANCELLED') return 'ENDED';
  const now = Date.now();
  const startsAt = market.startsAt ? new Date(market.startsAt).getTime() : null;
  const endAt = market.endsAt ? new Date(market.endsAt).getTime() : null;
  if (endAt != null && now >= endAt) return 'ENDED';
  if (startsAt != null && now >= startsAt + CYBERSPORT_ENDED_AFTER_MS) return 'ENDED';
  if (startsAt != null && startsAt > now) return 'UPCOMING';
  if (startsAt != null && startsAt <= now) return 'LIVE';
  return market.status === 'OPEN' ? 'LIVE' : 'ENDED';
}

/** Politics-only. */
function getPoliticsLifecycleStatus(market: Market): 'UPCOMING' | 'LIVE' | 'ENDED' | 'RESOLVED' | 'AWAITING_RESULT' {
  if (market.status === 'RESOLVED' || market.status === 'CLOSED' || market.status === 'CANCELLED') return 'RESOLVED';
  if (market.status === 'AWAITING_RESULT') return 'AWAITING_RESULT';
  const now = Date.now();
  const startsAt = market.startsAt ? new Date(market.startsAt).getTime() : null;
  const endsAt = market.endsAt ? new Date(market.endsAt).getTime() : null;
  if (startsAt != null && now < startsAt) return 'UPCOMING';
  if (endsAt != null && now >= endsAt) return 'ENDED';
  if ((startsAt != null && now >= startsAt && (endsAt == null || now < endsAt)) || (startsAt == null && endsAt != null && now < endsAt)) return 'LIVE';
  return 'ENDED';
}

function getLifecycleStatus(market: Market): 'UPCOMING' | 'LIVE' | 'ENDED' | 'RESOLVED' | 'AWAITING_RESULT' {
  if (market.category === 'politics') return getPoliticsLifecycleStatus(market);
  return getMarketLifecycleStatus(market);
}

const POLL_CHAT_MS = 2500;

export default function MarketPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const [market, setMarket] = useState<Market | null>(null);
  const [loading, setLoading] = useState(true);
  const [betAmount, setBetAmount] = useState('');
  const [selectedOutcome, setSelectedOutcome] = useState('');
  const [placingBet, setPlacingBet] = useState(false);
  const [betSuccess, setBetSuccess] = useState(false);
  const displayBalance = useBalanceCount(user?.balance ?? 0);

  const [showMoreExpanded, setShowMoreExpanded] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sendAsAnonymous, setSendAsAnonymous] = useState(false);
  const [sendingChat, setSendingChat] = useState(false);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const chatListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMarket();
    const interval = setInterval(fetchMarket, 5000);
    return () => clearInterval(interval);
  }, [params.id]);

  const fetchMarket = async () => {
    try {
      const response = await marketsAPI.getOne(params.id as string);
      setMarket(response.data);
    } catch (error) {
      console.error('Failed to fetch market:', error);
    } finally {
      setLoading(false);
    }
  };

  const eventKey = market?.eventKey ?? market?.id ?? '';
  const relatedMarkets = market?.relatedMarkets ?? [];
  const otherMarkets = relatedMarkets.filter((m) => m.id !== market?.id);

  const fetchChatMessages = useCallback(() => {
    if (!eventKey) return;
    chatAPI
      .getMessages(eventKey, { limit: 50 })
      .then((res) => {
        const list = res.data?.messages ?? [];
        setChatMessages(list);
      })
      .catch(() => {});
  }, [eventKey]);

  useEffect(() => {
    if (!eventKey) return;
    chatAPI.getThread(eventKey).catch(() => {});
    fetchChatMessages();
    const t = setInterval(fetchChatMessages, POLL_CHAT_MS);
    return () => clearInterval(t);
  }, [eventKey, fetchChatMessages]);

  useEffect(() => {
    const el = chatListRef.current;
    if (!el || !chatAtBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, chatAtBottom]);

  const handleSendChat = async () => {
    const body = chatInput.trim();
    if (!body || !eventKey || sendingChat) return;
    if (!user) {
      router.push('/login');
      return;
    }
    setSendingChat(true);
    setChatInput('');
    try {
      await chatAPI.postMessage(eventKey, { body, anonymous: sendAsAnonymous });
      fetchChatMessages();
      setChatAtBottom(true);
    } catch (e: unknown) {
      const err = e && typeof e === 'object' && 'response' in e ? (e as { response?: { data?: { error?: string } } }).response?.data : undefined;
      alert(err?.error ?? 'Failed to send message');
      setChatInput(body);
    } finally {
      setSendingChat(false);
    }
  };

  const { totalPool, poolByOutcome } = useMemo(() => {
    const bets = market?.bets ?? [];
    const outcomes = market?.outcomes ?? [];
    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const b of bets) {
      byOutcome[b.outcome] = (byOutcome[b.outcome] ?? 0) + b.amount;
      total += b.amount;
    }
    for (const o of outcomes) {
      if (byOutcome[o] == null) byOutcome[o] = 0;
    }
    return { totalPool: total, poolByOutcome: byOutcome };
  }, [market?.bets, market?.outcomes]);

  const handlePlaceBet = async () => {
    if (placingBet) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!selectedOutcome || !betAmount) {
      alert('Please select an outcome and enter an amount');
      return;
    }
    const amount = parseFloat(betAmount);
    if (amount <= 0 || amount > (user.balance ?? 0)) {
      alert('Invalid bet amount');
      return;
    }
    if (!market) return;

    setPlacingBet(true);
    try {
      const response = await betsAPI.place({
        marketId: market.id,
        outcome: selectedOutcome,
        amount,
      });
      // Only treat as success when API returns 2xx (place succeeded)
      if (response.status === 201 && response.data) {
        const newBalance = response.data.updatedBalance;
        if (typeof newBalance === 'number') {
          useAuthStore.getState().updateBalance(newBalance);
        } else {
          usersAPI.getMe().then((r) => {
            if (r.data?.balance != null) useAuthStore.getState().updateBalance(r.data.balance);
          }).catch(() => {});
        }
        setBetAmount('');
        setSelectedOutcome('');
        setBetSuccess(true);
        playBetConfirm();
        setTimeout(() => setBetSuccess(false), 2500);
        fetchMarket().catch(() => console.error('Could not refresh market'));
      }
    } catch (error: any) {
      const message = error?.response?.data?.error ?? 'Failed to place bet';
      alert(message);
    } finally {
      setPlacingBet(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 dark:border-primary-400"></div>
        </div>
      </div>
    );
  }

  if (!market) {
    return (
      <div className="container mx-auto px-4 py-8">
        <p className="text-center text-gray-500 dark:text-dark-text-secondary">Market not found</p>
      </div>
    );
  }

  const lifecycle = market ? getLifecycleStatus(market) : ('ENDED' as const);
  const isPolitics = market?.category === 'politics';
  const canBet = Boolean(market?.status === 'OPEN' && (!isPolitics || lifecycle === 'LIVE'));
  const canResolve = Boolean(user && market && user.id === market.creator.id && market.status === 'OPEN');

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="bg-white dark:bg-dark-card rounded-lg shadow-lg p-6 mb-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <div className="flex justify-between items-start mb-4">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-dark-text-primary">
            {market.title}
          </h1>
          <span
            className={`px-3 py-1 text-sm rounded flex-shrink-0 ${
              lifecycle === 'UPCOMING'
                ? 'bg-slate-100 text-slate-700 dark:bg-dark-upcoming-bg dark:text-dark-upcoming-text'
                : lifecycle === 'LIVE'
                ? 'bg-green-100 text-green-800 dark:bg-dark-live-bg dark:text-dark-live-text'
                : lifecycle === 'AWAITING_RESULT'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                : lifecycle === 'ENDED'
                ? 'bg-blue-100 text-blue-800 dark:bg-dark-ended-bg dark:text-dark-ended-text'
                : lifecycle === 'RESOLVED'
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'bg-gray-100 text-gray-800 dark:bg-dark-secondary dark:text-dark-text-secondary'
            }`}
          >
            {lifecycle === 'AWAITING_RESULT' ? 'Awaiting result' : lifecycle}
          </span>
        </div>

        {isPolitics ? (
          <>
            {market.startsAt && (
              <p className="text-sm text-gray-500 dark:text-dark-text-secondary mb-1">
                Starts at: {formatUTC(market.startsAt)}
              </p>
            )}
            {lifecycle === 'LIVE' && (
              <p className="text-sm text-green-600 dark:text-dark-live-text mb-2">
                Live now — betting open until {market.endsAt ? formatUTC(market.endsAt) : 'close'}
              </p>
            )}
            {lifecycle === 'ENDED' && (
              <p className="text-sm text-gray-600 dark:text-dark-text-secondary mb-2">
                Ended at: {market.endsAt ? formatUTC(market.endsAt) : '—'}. Betting closed. Awaiting political outcome.
              </p>
            )}
            {lifecycle === 'RESOLVED' && market.winningOutcome && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400 mb-2">
                Resolved: {market.winningOutcome}
                {market.resolvedAt && ` at ${formatUTC(market.resolvedAt)}`}
              </p>
            )}
          </>
        ) : (
          <>
            {market.startsAt && (
              <p className="text-sm text-gray-500 dark:text-dark-text-secondary mb-2">
                Starts at: {formatUTC(market.startsAt)}
              </p>
            )}
            {lifecycle === 'LIVE' && (
              <p className="text-sm text-green-600 dark:text-dark-live-text mb-2">Live now</p>
            )}
            {lifecycle === 'RESOLVED' && market.winningOutcome && (
              <div className="mb-4 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300 mb-1">Result</p>
                <p className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
                  Winner: {market.winningOutcome}
                </p>
                {market.resolvedAt && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-500 mt-1">
                    Resolved at {formatUTC(market.resolvedAt)}
                  </p>
                )}
              </div>
            )}
            {lifecycle === 'AWAITING_RESULT' && (
              <p className="text-sm text-amber-600 dark:text-amber-400 mb-2">
                Match ended. Awaiting result confirmation.
              </p>
            )}
            {lifecycle === 'ENDED' && !market.winningOutcome && lifecycle !== 'AWAITING_RESULT' && (
              <p className="text-sm text-gray-500 dark:text-dark-text-secondary mb-2">
                Match ended. Awaiting result.
              </p>
            )}
          </>
        )}

        {market.description && (
          <p className="text-gray-600 dark:text-dark-text-secondary mb-4">{market.description}</p>
        )}

        <div className="grid md:grid-cols-2 gap-4 mb-6">
          {market.outcomes.map((outcome) => (
            <div
              key={outcome}
              className={`p-4 rounded-lg border-2 transition ${
                market.winningOutcome === outcome
                  ? 'border-green-500 bg-green-50 dark:bg-dark-live-bg/30 dark:border-green-500/70'
                  : selectedOutcome === outcome
                  ? 'border-primary-500 bg-primary-50 dark:bg-dark-secondary dark:border-primary-500'
                  : 'border-gray-200 dark:border-[rgba(255,255,255,0.08)] dark:bg-dark-secondary hover:dark:bg-dark-card-hover'
              }`}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-gray-900 dark:text-dark-text-primary flex items-center gap-2">
                  {outcome}
                  {market.winningOutcome === outcome && (
                    <span className="text-xs font-bold uppercase tracking-wide text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/40 px-2 py-0.5 rounded">
                      Winner
                    </span>
                  )}
                </span>
                <span className="text-sm font-semibold text-gray-600 dark:text-dark-text-secondary">
                  Pool: ${(poolByOutcome[outcome] ?? 0).toFixed(2)}
                </span>
              </div>
              {canBet && (
                <button
                  onClick={() => setSelectedOutcome(outcome)}
                  className={`w-full mt-2 px-4 py-2 rounded transition ${
                    selectedOutcome === outcome
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-100 dark:bg-dark-secondary text-gray-700 dark:text-dark-text-primary hover:dark:bg-dark-card-hover'
                  }`}
                >
                  Select
                </button>
              )}
              {market.status === 'OPEN' && !canBet && isPolitics && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Betting closed</p>
              )}
            </div>
          ))}
        </div>

        {canBet && user && (
          <div className="border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)] pt-4">
            {betSuccess && (
              <div className="mb-4 flex items-center gap-2 rounded-lg bg-green-500/10 dark:bg-dark-live-bg/30 border border-green-500/30 dark:border-green-500/40 px-4 py-3 text-green-700 dark:text-dark-live-text">
                <span className="animate-bet-success inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <span className="text-sm font-medium">Bet placed successfully</span>
              </div>
            )}
            <p className="text-sm text-gray-500 dark:text-dark-text-secondary mb-2">
              Total pool: ${totalPool.toFixed(2)}
              <span className="ml-2 text-xs text-gray-400 dark:text-dark-text-muted" title="Odds change dynamically based on the total pool">ⓘ</span>
            </p>
            <div className="flex gap-4">
              <input
                type="number"
                placeholder="Stake (bet amount)"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                className="flex-1 px-4 py-2 border rounded-lg dark:bg-dark-secondary dark:border-[rgba(255,255,255,0.08)] dark:text-dark-text-primary placeholder:dark:text-dark-text-muted"
                min="0.01"
                max={user.balance}
                step="0.01"
              />
              <button
                type="button"
                onClick={handlePlaceBet}
                disabled={placingBet || !selectedOutcome || !betAmount}
                className="flex items-center justify-center gap-2 px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-transform duration-150 ease-out min-w-[7rem]"
              >
                {placingBet ? (
                  <>
                    <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>Placing…</span>
                  </>
                ) : (
                  'Place Bet'
                )}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <p className="text-gray-500 dark:text-dark-text-secondary">
                Your balance: ${displayBalance.toFixed(2)}
              </p>
              {selectedOutcome && (
                <>
                  {betAmount && (() => {
                    const stake = parseFloat(betAmount);
                    if (!Number.isFinite(stake) || stake <= 0) return null;
                    const poolSelected = poolByOutcome[selectedOutcome] ?? 0;
                    const poolOpposite = totalPool - poolSelected;
                    const totalPoolWithStake = totalPool + stake;
                    const poolSelectedWithStake = poolSelected + stake;
                    const userShare = stake / poolSelectedWithStake;
                    const distributablePool = totalPoolWithStake * (1 - PLATFORM_FEE);
                    let potentialWin = userShare * distributablePool;
                    potentialWin = Math.min(potentialWin, poolOpposite);
                    const impliedOdds = stake > 0 ? potentialWin / stake : 0;
                    return (
                      <>
                        <p className="font-medium text-primary-600 dark:text-primary-400">
                          Potential win: ${potentialWin.toFixed(2)}
                        </p>
                        {impliedOdds > 0 && (
                          <span className="text-xs text-gray-400 dark:text-dark-text-muted">
                            ~{impliedOdds.toFixed(2)}x
                          </span>
                        )}
                      </>
                    );
                  })()}
                  {(!betAmount || parseFloat(betAmount) <= 0) && (
                    <p className="text-gray-400 dark:text-dark-text-muted">Potential win: —</p>
                  )}
                </>
              )}
            </div>
            <p className="text-xs text-gray-400 dark:text-dark-text-muted mt-1">
              Odds change dynamically based on the total pool. Payout is capped by the opposite side’s pool.
            </p>
          </div>
        )}

        {canResolve && (
          <div className="border-t border-gray-200 dark:border-[rgba(255,255,255,0.08)] pt-4 mt-4">
            <button
              type="button"
              onClick={async () => {
                const outcome = prompt('Enter winning outcome:');
                if (!outcome || !market.outcomes.includes(outcome)) return;
                try {
                  await marketsAPI.resolve(market.id, outcome);
                  alert('Market resolved!');
                  await fetchMarket();
                  const me = await usersAPI.getMe().catch(() => null);
                  if (me?.data?.balance != null) useAuthStore.getState().updateBalance(me.data.balance);
                } catch (error: any) {
                  alert(error?.response?.data?.error || 'Failed to resolve market');
                }
              }}
              className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              Resolve Market
            </button>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-dark-card rounded-lg shadow-lg p-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-dark-text-primary">
          Recent Bets
        </h2>
        <div className="space-y-2">
          {market.bets.slice(0, 10).map((bet) => (
            <div
              key={bet.id}
              className="flex justify-between items-center p-3 bg-gray-50 dark:bg-transparent dark:hover:bg-[rgba(255,255,255,0.04)] rounded transition"
            >
              <div>
                <span className="font-medium text-gray-900 dark:text-dark-text-primary">
                  {bet.user.username}
                </span>
                <span className="text-gray-600 dark:text-dark-text-secondary ml-2">
                  bet ${bet.amount.toFixed(2)} on {bet.outcome}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-sm text-gray-500 dark:text-dark-text-muted mt-4">
          Total Volume: ${market.totalVolume.toFixed(2)}
        </p>
      </div>

      {otherMarkets.length > 0 && (
        <div className="bg-white dark:bg-dark-card rounded-lg shadow-lg p-6 mt-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
          <button
            type="button"
            onClick={() => setShowMoreExpanded((e) => !e)}
            className="flex items-center justify-between w-full text-left"
          >
            <h2 className="text-xl font-bold text-gray-900 dark:text-dark-text-primary">
              More bets for this event
            </h2>
            <span className="text-primary-600 dark:text-primary-400 text-sm font-medium">
              {showMoreExpanded ? 'Show less' : 'Show more'}
            </span>
          </button>
          {showMoreExpanded && (
            <ul className="mt-4 space-y-3">
              <li className="p-3 rounded-lg border-2 border-primary-500 bg-primary-50 dark:bg-dark-secondary dark:border-primary-500">
                <span className="text-sm text-gray-500 dark:text-dark-text-muted block mb-1">Current market</span>
                <span className="font-semibold text-gray-900 dark:text-dark-text-primary">{market.title}</span>
                <div className="flex flex-wrap gap-2 mt-2">
                  {market.outcomes.map((o) => (
                    <span key={o} className="text-sm text-gray-600 dark:text-dark-text-secondary">
                      {o} {market.odds[o]?.toFixed(2)}x
                    </span>
                  ))}
                </div>
              </li>
              {otherMarkets.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/markets/${m.id}`}
                    className="block p-3 rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)] hover:bg-gray-50 dark:hover:bg-dark-card-hover transition"
                  >
                    <span className="font-medium text-gray-900 dark:text-dark-text-primary">{m.title}</span>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {m.outcomes.map((o) => (
                        <span key={o} className="text-sm text-gray-600 dark:text-dark-text-secondary">
                          {o} {m.odds[o]?.toFixed(2)}x
                        </span>
                      ))}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="bg-white dark:bg-dark-card rounded-lg shadow-lg p-6 mt-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-dark-text-primary">
          Event chat
        </h2>
        <div
          ref={chatListRef}
          className="h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)] bg-gray-50 dark:bg-dark-secondary p-3 mb-4 flex flex-col gap-2"
          onScroll={() => {
            const el = chatListRef.current;
            if (!el) return;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            setChatAtBottom(nearBottom);
          }}
        >
          {chatMessages.length === 0 ? (
            <p className="text-gray-500 dark:text-dark-text-secondary text-sm">No messages yet. Be the first to chat.</p>
          ) : (
            [...chatMessages].reverse().map((msg) => (
              <div key={msg.id} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium text-gray-900 dark:text-dark-text-primary text-sm">
                    {msg.username}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-dark-text-muted">
                    {format(new Date(msg.createdAt), 'PPp')}
                  </span>
                </div>
                <p className="text-gray-700 dark:text-dark-text-secondary text-sm break-words">{msg.body}</p>
              </div>
            ))
          )}
        </div>
        {user ? (
          <>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendChat()}
                placeholder="Type a message..."
                maxLength={500}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary placeholder:dark:text-dark-text-muted"
                disabled={sendingChat}
              />
              <button
                type="button"
                onClick={handleSendChat}
                disabled={sendingChat || !chatInput.trim()}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sendingChat ? 'Sending…' : 'Send'}
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-dark-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={sendAsAnonymous}
                onChange={(e) => setSendAsAnonymous(e.target.checked)}
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              Send as Anonymous
            </label>
            {user.isAnonymous && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Your nickname is hidden globally; messages will show as Anonymous.
              </p>
            )}
          </>
        ) : (
          <p className="text-gray-500 dark:text-dark-text-secondary text-sm">
            Login to chat.
          </p>
        )}
      </div>
    </div>
  );
}
