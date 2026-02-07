'use client';

import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { rouletteAPI, usersAPI } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { getPublicDisplayName } from '@/lib/displayName';
import { usePotCount } from '@/hooks/usePotCount';
import {
  playRouletteBetPlace,
  playRouletteNewPlayer,
  playRoulettePotIncrease,
  playRouletteCountdownTick,
  playRouletteWheelSpin,
  playRouletteWinner,
  playRouletteLose,
  playRouletteAmbientStart,
  playRouletteAmbientStop,
} from '@/lib/soundStore';
import SoundControl from '@/components/SoundControl';

type Round = {
  id: string;
  roundNumber: number;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  seedHash: string | null;
  clientSeed: string;
  nonce: number;
  totalTickets: number;
  potCents: number;
  feeCents: number;
  winnerUserId: string | null;
  winningTicket: number | null;
  createdAt: string;
  serverSeed?: string;
  bets: Array<{
    id: string;
    userId: string;
    username?: string;
    isAnonymous?: boolean;
    amountCents: number;
    ticketsFrom: number;
    ticketsTo: number;
    createdAt: string;
  }>;
};

const MIN_BET = 0.1;
const POLL_MS = 4000;
const POLL_MS_RESOLVING = 1500; // poll more often while waiting for resolve
const SPIN_STRIP_COPIES = 6;
const MIN_SEGMENT_PX = 24;
const SPIN_LOOPS_MIN = 3;
const SPIN_LOOPS_MAX = 6;
const SPIN_DURATION_MS = 5000;

/** Stable hash from string to [0, 1) for deterministic "random" inside winner segment */
function stableHashTo01(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 1e7) / 1e7;
}

type BetLike = { userId: string; username?: string; isAnonymous?: boolean; ticketsFrom: number; ticketsTo: number };

function computeFinalOffsetPx(
  bets: BetLike[],
  totalTickets: number,
  winningTicket: number,
  roundIdForSeed: string,
  containerWidth: number
): number {
  const byUser = new Map<string, { tickets: number; label: string }>();
  for (const b of bets) {
    const tickets = b.ticketsTo - b.ticketsFrom + 1;
    const label = getPublicDisplayName(
      { username: b.username ?? '', isAnonymous: b.isAnonymous },
      true
    ).slice(0, 12) || '#';
    const cur = byUser.get(b.userId);
    if (!cur) byUser.set(b.userId, { tickets, label });
    else cur.tickets += tickets;
  }
  const stripWidth = Math.max(containerWidth || 800, 400);
  const n = byUser.size;
  const minPerSegment = n > 0 ? stripWidth / n : MIN_SEGMENT_PX;
  let segments = Array.from(byUser.entries()).map(([userId, d]) => ({
    userId,
    label: d.label,
    tickets: d.tickets,
    widthPx: Math.max((d.tickets / totalTickets) * stripWidth, minPerSegment),
  }));
  const total = segments.reduce((s, seg) => s + seg.widthPx, 0);
  if (total > 0) {
    const scale = stripWidth / total;
    segments = segments.map((seg) => ({ ...seg, widthPx: seg.widthPx * scale }));
  }
  const ticketEnds: number[] = [];
  let acc = 0;
  for (const s of segments) {
    acc += s.tickets;
    ticketEnds.push(acc);
  }
  let winnerSegmentIndex = 0;
  for (let i = 0; i < ticketEnds.length; i++) {
    if (winningTicket <= ticketEnds[i]!) {
      winnerSegmentIndex = i;
      break;
    }
  }
  let winnerSegmentStartPx = 0;
  for (let i = 0; i < winnerSegmentIndex; i++) winnerSegmentStartPx += segments[i]!.widthPx;
  const winnerSegmentWidthPx = segments[winnerSegmentIndex]!.widthPx;
  const seed = `${roundIdForSeed}-${winningTicket}`;
  const rand01 = stableHashTo01(seed);
  const randInside = rand01 * winnerSegmentWidthPx;
  const loops =
    SPIN_LOOPS_MIN + Math.floor(stableHashTo01(seed + '-loops') * (SPIN_LOOPS_MAX - SPIN_LOOPS_MIN + 1));
  const needleCenterPx = stripWidth / 2;
  return winnerSegmentStartPx + randInside - needleCenterPx + loops * stripWidth;
}

function useCountdown(endsAt: string | null, status: string) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (status !== 'OPEN' || !endsAt) {
      setSecondsLeft(null);
      return;
    }
    const update = () => {
      const end = new Date(endsAt).getTime();
      const now = Date.now();
      const diff = Math.max(0, Math.floor((end - now) / 1000));
      setSecondsLeft(diff);
    };
    update();
    const t = setInterval(update, 500);
    return () => clearInterval(t);
  }, [endsAt, status]);
  return secondsLeft;
}

function formatCountdown(s: number | null): string {
  if (s === null) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function RoulettePage() {
  const router = useRouter();
  const { user, token, authVerified } = useAuthStore();
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [betAmount, setBetAmount] = useState('');
  const [placingBet, setPlacingBet] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [spinState, setSpinState] = useState<
    { status: 'idle' } | { status: 'spinning'; spinRoundId: string; finalOffsetPx: number } | { status: 'done'; spinRoundId: string; finalOffsetPx: number }
  >({ status: 'idle' });
  const wheelContainerWidthRef = useRef(0);
  const [suspense, setSuspense] = useState(false);
  const [provablyFairOpen, setProvablyFairOpen] = useState(false);
  const [potGlow, setPotGlow] = useState(false);
  const [betButtonShake, setBetButtonShake] = useState(false);
  const [betButtonSuccess, setBetButtonSuccess] = useState(false);
  const [resultBanner, setResultBanner] = useState<{ type: 'won' | 'lost'; amountCents?: number } | null>(null);
  const resultBannerRoundIdRef = useRef<string | null>(null);
  const resultBannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRoundRef = useRef<Round | null>(null);
  const seenBetIdsRef = useRef<Set<string>>(new Set());
  const lastClearedRoundIdRef = useRef<string | null>(null);
  const countdownTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayPotCents = usePotCount(round?.potCents ?? 0);

  const fetchCurrent = useCallback(() => {
    rouletteAPI
      .getCurrent()
      .then((res) => {
        const data = res.data as Round;
        const lock = spinLockRef.current;
        if (lock && data.id !== lock.spinRoundId) {
          return;
        }
        setRound(data);
        setError(null);
      })
      .catch((e) => setError(e.response?.data?.error ?? e.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    fetchCurrentRef.current = fetchCurrent;
  }, [fetchCurrent]);

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
    fetchCurrent();
    const interval = setInterval(fetchCurrent, POLL_MS);
    return () => clearInterval(interval);
  }, [token, authVerified, user, router, fetchCurrent]);

  const isWaitingForResolveForPoll =
    round?.status === 'OPEN' && round?.endsAt != null && new Date(round.endsAt).getTime() <= Date.now();
  useEffect(() => {
    if (!isWaitingForResolveForPoll || !token || !user) return;
    const id = setInterval(fetchCurrent, POLL_MS_RESOLVING);
    return () => clearInterval(id);
  }, [isWaitingForResolveForPoll, token, user, fetchCurrent]);

  const secondsLeft = useCountdown(round?.endsAt ?? null, round?.status ?? '');

  const handlePlaceBet = async () => {
    if (!user) {
      router.push('/login');
      return;
    }
    const amount = Number(betAmount);
    if (!Number.isFinite(amount) || amount < MIN_BET) {
      setBetButtonShake(true);
      setTimeout(() => setBetButtonShake(false), 400);
      alert(`Minimum bet is $${MIN_BET.toFixed(2)}`);
      return;
    }
    const balance = user.balance ?? 0;
    const balanceCents = Math.round(balance * 100);
    const amountCents = Math.round(amount * 100);
    if (amountCents > balanceCents) {
      setBetButtonShake(true);
      setTimeout(() => setBetButtonShake(false), 400);
      alert('Insufficient balance');
      return;
    }
    setPlacingBet(true);
    try {
      const res = await rouletteAPI.placeBet(amount);
      if (res.data && (res.data as { ok?: boolean }).ok) {
        setRound((res.data as { round: Round }).round as Round);
        setBetAmount('');
        setBetButtonSuccess(true);
        setTimeout(() => setBetButtonSuccess(false), 500);
        playRouletteBetPlace();
        const me = await usersAPI.getMe().catch(() => null);
        if (me?.data?.balance != null) useAuthStore.getState().updateBalance(me.data.balance);
        fetchCurrent();
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      setBetButtonShake(true);
      setTimeout(() => setBetButtonShake(false), 400);
      alert(err.response?.data?.error ?? err.message ?? 'Bet failed');
    } finally {
      setPlacingBet(false);
    }
  };

  // Pot glow when pot updates
  useEffect(() => {
    if (round?.potCents == null) return;
    setPotGlow(true);
    const t = setTimeout(() => setPotGlow(false), 700);
    return () => clearTimeout(t);
  }, [round?.potCents]);

  // Reset seen bet ids only when round id changes (new round)
  useEffect(() => {
    if (round?.id && lastClearedRoundIdRef.current !== round.id) {
      lastClearedRoundIdRef.current = round.id;
      seenBetIdsRef.current = new Set();
    }
  }, [round?.id]);

  // Sound + animation: new participant, pot increase
  useEffect(() => {
    if (!round) return;
    const prev = prevRoundRef.current;
    if (prev?.id === round.id) {
      const prevBetIds = new Set(prev.bets?.map((b) => b.id) ?? []);
      const prevPot = prev.potCents ?? 0;
      for (const b of round.bets ?? []) {
        if (!prevBetIds.has(b.id)) {
          playRouletteNewPlayer();
          break;
        }
      }
      if (round.potCents > prevPot) {
        playRoulettePotIncrease(round.potCents - prevPot);
      }
    }
    prevRoundRef.current = round;
  }, [round]);

  // Countdown urgency: tick sound when < 10s
  useEffect(() => {
    if (secondsLeft == null || secondsLeft > 10 || round?.status !== 'OPEN') {
      if (countdownTickRef.current) {
        clearInterval(countdownTickRef.current);
        countdownTickRef.current = null;
      }
      return;
    }
    playRouletteCountdownTick();
    countdownTickRef.current = setInterval(() => playRouletteCountdownTick(), 1000);
    return () => {
      if (countdownTickRef.current) clearInterval(countdownTickRef.current);
    };
  }, [secondsLeft, round?.status]);

  const onSpinEndRef = useRef<(() => void) | null>(null);
  const spinRoundIdRef = useRef<string | null>(null);
  const spinLockRef = useRef<{ spinRoundId: string } | null>(null);
  const fetchCurrentRef = useRef<() => void>(() => {});
  const prevRoundStatusRef = useRef<string | null>(null);
  const [spinSkipReason, setSpinSkipReason] = useState<string | null>(null);

  // When FINISHED + winningTicket/winnerUserId: run spin once per round (including on refresh — force spin debug).
  // Conditions that PREVENT animation: !isFinished; already ran for this round; no bets.
  useEffect(() => {
    const status = round?.status ?? null;
    const winningTicket = round?.winningTicket ?? null;
    const winnerUserId = round?.winnerUserId ?? null;
    const isFinished = status === 'FINISHED' && (winningTicket != null || winnerUserId != null);

    if (!isFinished) {
      prevRoundStatusRef.current = status;
      const reason = status !== 'FINISHED'
        ? `Round not FINISHED (status=${status ?? 'null'})`
        : 'No winningTicket or winnerUserId';
      setSpinSkipReason(reason);
      return;
    }

    console.log('[spin] round FINISHED payload', round);

    if (
      (spinState.status === 'spinning' || spinState.status === 'done') &&
      spinState.spinRoundId === round!.id
    ) {
      console.log('[spin] skip: already ran for this round', round!.id);
      setSpinSkipReason('Already ran for this round');
      return;
    }

    const totalTickets = round!.totalTickets || 1;
    const bets = round!.bets ?? [];
    if (bets.length === 0) {
      console.warn('[spin] skip: no bets');
      prevRoundStatusRef.current = status;
      setSpinSkipReason('No bets');
      return;
    }

    setSpinSkipReason(null);
    prevRoundStatusRef.current = status;

    const winningT = winningTicket ?? 1;
    const finalOffsetPx = computeFinalOffsetPx(
      bets,
      totalTickets,
      winningT,
      round!.id,
      wheelContainerWidthRef.current || 800
    );

    // Force spin debug: always run animation once per FINISHED round (even on refresh)
    console.log('[spin] start roundId=', round!.id);
    console.log('[spin] finalOffset', finalOffsetPx);
    spinRoundIdRef.current = round!.id;
    spinLockRef.current = { spinRoundId: round!.id };
    setSpinState({ status: 'spinning', spinRoundId: round!.id, finalOffsetPx });
    setSpinning(true);
    setSuspense(false);
    playRouletteWheelSpin();
  }, [round?.id, round?.status, round?.winningTicket, round?.winnerUserId, round?.bets, round?.totalTickets, spinState]);

  useEffect(() => {
    if (round?.status !== 'FINISHED' || round.winningTicket == null) return;
    const roundId = round.id;
    const winningTicket = round.winningTicket;
    const bets = round.bets ?? [];
    const potCents = round.potCents;
    const totalTickets = round.totalTickets;
    const userId = user?.id;
    onSpinEndRef.current = () => {
      const currentSpinId = spinRoundIdRef.current;
      const isTest = currentSpinId != null && String(currentSpinId).startsWith('test-');
      console.log('[spin] transitionend roundId=', isTest ? currentSpinId : roundId);
      setSpinning(false);
      setSpinState((s) =>
        s.status === 'spinning' ? { status: 'done', spinRoundId: s.spinRoundId, finalOffsetPx: s.finalOffsetPx } : s
      );
      spinRoundIdRef.current = null;
      if (isTest) {
        spinLockRef.current = null;
        return;
      }
      const winnerBet = bets.find((b) => winningTicket >= b.ticketsFrom && winningTicket <= b.ticketsTo);
      const showWinBanner = () => {
        if (winnerBet && winnerBet.userId === userId) {
          console.log('[spin] show winner popup userId=', userId);
          playRouletteWinner();
          const feeCents = Math.floor(potCents * 0.05);
          const winnerProb = (winnerBet.ticketsTo - winnerBet.ticketsFrom + 1) / totalTickets;
          const feeWaived = winnerProb >= 0.95;
          const payoutCents = potCents - (feeWaived ? 0 : feeCents);
          resultBannerRoundIdRef.current = roundId;
          setResultBanner({ type: 'won', amountCents: payoutCents });
          if (resultBannerTimeoutRef.current) clearTimeout(resultBannerTimeoutRef.current);
          resultBannerTimeoutRef.current = setTimeout(() => {
            resultBannerTimeoutRef.current = null;
            setResultBanner(null);
          }, 2000);
        } else if (userId && bets.some((b) => b.userId === userId)) {
          playRouletteLose();
        } else {
          playRouletteWinner();
        }
      };
      setTimeout(() => {
        showWinBanner();
        setTimeout(() => {
          spinLockRef.current = null;
          console.log('[spin] allow next round');
          fetchCurrentRef.current();
        }, 600);
      }, 450);
      if (userId && bets.some((b) => b.userId === userId)) {
        usersAPI.getMe().then((r) => {
          if (r.data?.balance != null) useAuthStore.getState().updateBalance(r.data.balance);
        }).catch(() => {});
      }
    };
  }, [round?.id, round?.status, round?.winningTicket]);

  // Roulette ambient: start when on page with sound on, stop on leave/tab hidden
  useEffect(() => {
    playRouletteAmbientStart();
    return () => playRouletteAmbientStop();
  }, []);

  const uniqueParticipants = useMemo(() => {
    const bets = round?.bets ?? [];
    const byUser = new Map<string, { totalCents: number; ticketsFrom: number; ticketsTo: number; username?: string; isAnonymous?: boolean; isWinner: boolean }>();
    const winningTicket = round?.winningTicket ?? null;
    for (const b of bets) {
      const cur = byUser.get(b.userId);
      const tickets = b.ticketsTo - b.ticketsFrom + 1;
      const isWinner = winningTicket != null && winningTicket >= b.ticketsFrom && winningTicket <= b.ticketsTo;
      if (!cur) {
        byUser.set(b.userId, {
          totalCents: b.amountCents,
          ticketsFrom: b.ticketsFrom,
          ticketsTo: b.ticketsTo,
          username: b.username,
          isAnonymous: b.isAnonymous,
          isWinner,
        });
      } else {
        cur.totalCents += b.amountCents;
        cur.ticketsTo = b.ticketsTo;
        cur.isWinner = cur.isWinner || isWinner;
      }
    }
    return Array.from(byUser.entries()).map(([userId, data]) => ({ userId, ...data }));
  }, [round?.bets, round?.winningTicket]);
  const playersCount = uniqueParticipants.length;

  const authLoading = Boolean(token && !authVerified);
  if (!token || authLoading || (authVerified && user === null)) {
    return (
      <div className="container mx-auto px-4 py-8 flex justify-center items-center min-h-[40vh]">
        <div className="flex items-center gap-2 text-gray-600 dark:text-dark-text-secondary">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-500 border-t-transparent" />
          <span>{authLoading ? 'Checking auth…' : 'Redirecting…'}</span>
        </div>
      </div>
    );
  }

  if (loading && !round) {
    return (
      <div className="container mx-auto px-4 py-8 flex justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error && !round) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">{error}</div>
      </div>
    );
  }

  const potDollars = ((round?.potCents ?? 0) / 100).toFixed(2);
  const isWaitingForResolve =
    round?.status === 'OPEN' &&
    round?.endsAt != null &&
    new Date(round.endsAt).getTime() <= Date.now();
  return (
    <div className="min-h-screen">
      <div className="container mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-dark-text-primary mb-1">Roulette</h1>
        <p className="text-sm text-gray-600 dark:text-dark-text-secondary mb-4">
          CS:GO Lounge style · 2 min rounds · 1 ticket = $0.01 · 5% fee (waived if winner had ≥95% chance)
        </p>
      </div>

      {/* 1. WHEEL — full width hero */}
      <div className="w-full px-4 pb-4">
        <div className="max-w-[1600px] mx-auto">
          {resultBanner && resultBanner.type === 'won' && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-roulette-win-modal"
              role="alert"
              aria-live="assertive"
            >
              <div className="relative bg-gradient-to-r from-emerald-500 to-green-600 text-white text-center px-10 py-8 rounded-2xl shadow-2xl border-4 border-white/30">
                <button
                  type="button"
                  onClick={() => {
                    if (resultBannerTimeoutRef.current) {
                      clearTimeout(resultBannerTimeoutRef.current);
                      resultBannerTimeoutRef.current = null;
                    }
                    setResultBanner(null);
                  }}
                  className="absolute top-2 right-2 p-1 rounded-full text-white/90 hover:bg-white/20 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/50"
                  aria-label="Close"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <p className="text-3xl md:text-4xl font-bold mb-1">You won!</p>
                <p className="text-4xl md:text-5xl font-extrabold">${((resultBanner.amountCents ?? 0) / 100).toFixed(2)}</p>
                <p className="text-sm mt-2 opacity-90">Added to your balance</p>
              </div>
            </div>
          )}
          <div className="rounded-xl overflow-hidden bg-gray-900 dark:bg-black shadow-xl border border-gray-800 dark:border-[rgba(255,255,255,0.08)]">
            <RouletteWheel
              round={round}
              spinState={spinState}
              spinning={spinning}
              suspense={suspense}
              resolving={isWaitingForResolve}
              onContainerResize={(w) => { wheelContainerWidthRef.current = w; }}
              onTransitionEnd={() => onSpinEndRef.current?.()}
            />
          </div>
          {user?.isAdmin === true && round?.bets && round.bets.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => {
                  const totalTickets = round.totalTickets || 1;
                  const fakeWinningTicket = Math.floor(totalTickets / 2) + 1;
                  const finalOffsetPx = computeFinalOffsetPx(
                    round.bets,
                    totalTickets,
                    fakeWinningTicket,
                    round.id + '-test',
                    wheelContainerWidthRef.current || 800
                  );
                  const testId = `test-${Date.now()}`;
                  spinRoundIdRef.current = testId;
                  setSpinState({ status: 'spinning', spinRoundId: testId, finalOffsetPx });
                  setSpinning(true);
                  setSuspense(false);
                  playRouletteWheelSpin();
                  setSpinSkipReason(null);
                }}
                disabled={spinning}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white"
              >
                Test spin (debug)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 2. Compact controls under wheel */}
      <div className="container mx-auto px-4 max-w-[1600px] flex justify-center">
        <div className="flex flex-wrap items-center justify-center gap-4 py-4">
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-lg p-4 border border-transparent dark:border-[rgba(255,255,255,0.08)] flex flex-wrap items-center gap-6">
            {round && (
              <span className="text-xs font-semibold text-primary-600 dark:text-primary-400">Round #{round.roundNumber}</span>
            )}
            <div className={`rounded-lg px-2 transition-all duration-300 ${potGlow ? 'animate-roulette-pot-glow' : ''}`}>
              <p className="text-xs text-gray-500 dark:text-dark-text-muted">Pot</p>
              <p className="text-lg font-bold text-primary-600 dark:text-primary-400">${(displayPotCents / 100).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-dark-text-muted">Players</p>
              <p className="text-lg font-bold text-gray-900 dark:text-dark-text-primary">{playersCount}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-dark-text-muted">Tickets</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-dark-text-primary">{round?.totalTickets ?? 0}</p>
            </div>
            <div className={secondsLeft != null && secondsLeft < 15 && round?.status === 'OPEN' ? 'animate-roulette-countdown-urgency' : ''}>
              <p className="text-xs text-gray-500 dark:text-dark-text-muted">Time left</p>
              <p className={`text-lg font-bold ${secondsLeft != null && secondsLeft < 15 && round?.status === 'OPEN' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-dark-text-primary'}`}>
                {isWaitingForResolve ? 'Resolving…' : round?.status === 'OPEN' ? formatCountdown(secondsLeft ?? null) : round?.status ?? '—'}
              </p>
            </div>
            {round?.status === 'OPEN' && !isWaitingForResolve && (
              <div className="flex items-end gap-2">
                <div>
                  <label htmlFor="roulette-bet-amount" className="block text-xs text-gray-500 dark:text-dark-text-muted">Place bet</label>
                  <div className="flex gap-2 mt-0.5">
                    <input
                      id="roulette-bet-amount"
                      type="number"
                      min={MIN_BET}
                      step="0.01"
                      value={betAmount}
                      onChange={(e) => setBetAmount(e.target.value)}
                      placeholder={`Min $${MIN_BET}`}
                      className="w-24 rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.08)] bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text-primary px-2 py-1.5 text-sm"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const me = await usersAPI.getMe().catch(() => null);
                        const balance = me?.data?.balance ?? user?.balance ?? 0;
                        const num = typeof balance === 'number' && Number.isFinite(balance) ? balance : 0;
                        if (me?.data?.balance != null) useAuthStore.getState().updateBalance(me.data.balance);
                        setBetAmount(String(Math.floor(num * 100) / 100));
                      }}
                      className="shrink-0 px-2 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-[rgba(255,255,255,0.2)] text-gray-700 dark:text-dark-text-secondary hover:bg-gray-100 dark:hover:bg-dark-secondary"
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      onClick={handlePlaceBet}
                      disabled={placingBet}
                      className={`shrink-0 px-4 py-1.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 font-medium text-sm ${
                        betButtonShake ? 'animate-roulette-button-shake' : ''
                      } ${betButtonSuccess ? 'animate-roulette-button-success' : ''}`}
                    >
                      {placingBet ? '…' : 'Bet'}
                    </button>
                  </div>
                  {betAmount && (() => {
                    const amount = Number(betAmount);
                    if (!Number.isFinite(amount) || amount < MIN_BET) return null;
                    const totalTickets = round?.totalTickets ?? 0;
                    const potCents = round?.potCents ?? 0;
                    const newTickets = Math.round(amount * 100);
                    const totalAfter = totalTickets + newTickets;
                    if (totalAfter <= 0) return null;
                    const potAfterBet = potCents / 100 + amount;
                    const feeRate = newTickets / totalAfter >= 0.95 ? 0 : 0.05;
                    const potentialWin = potAfterBet * (1 - feeRate);
                    return (
                      <p className="text-xs font-medium text-primary-600 dark:text-primary-400 mt-1">
                        If you win: ~${potentialWin.toFixed(2)}
                      </p>
                    );
                  })()}
                </div>
              </div>
            )}
            <div className="border-l border-gray-200 dark:border-[rgba(255,255,255,0.08)] pl-4">
              <SoundControl />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Participants — full width under wheel */}
      <div className="container mx-auto px-4 max-w-[1600px] mt-4">
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-lg p-5 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-dark-text-primary mb-3">Participants</h2>
          {uniqueParticipants.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-dark-text-secondary">No participants yet.</p>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {uniqueParticipants.map((p) => {
                const potCents = round?.potCents ?? 1;
                const pct = Math.round((p.totalCents / potCents) * 100);
                const isNew = !seenBetIdsRef.current.has(p.userId);
                if (isNew) seenBetIdsRef.current.add(p.userId);
                const showWinnerUi = round?.status === 'FINISHED' && !spinning;
                const isLoser = showWinnerUi && user && p.userId === user.id && !p.isWinner;
                return (
                  <li
                    key={p.userId}
                    className={`flex justify-between items-center text-sm py-2 px-3 rounded-lg border border-gray-100 dark:border-[rgba(255,255,255,0.06)] ${
                      isNew ? 'animate-roulette-participant-enter' : ''
                    } ${showWinnerUi && p.isWinner ? 'ring-1 ring-amber-400/50 bg-amber-500/10 dark:bg-amber-500/10' : ''} ${isLoser ? 'opacity-60' : ''}`}
                  >
                    <span className="font-medium text-gray-900 dark:text-dark-text-primary truncate mr-2">
                      {getPublicDisplayName({ username: p.username ?? '', isAnonymous: p.isAnonymous }, true) || p.userId.slice(0, 8)}
                      {showWinnerUi && p.isWinner && <span className="ml-1 text-[10px] font-bold uppercase text-amber-600 dark:text-amber-400">Winner</span>}
                    </span>
                    <span className="text-primary-600 dark:text-primary-400 shrink-0">${(p.totalCents / 100).toFixed(2)}</span>
                    <span className="text-xs text-gray-500 dark:text-dark-text-muted shrink-0 w-10 text-right">{pct}%</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="container mx-auto px-4 max-w-[1600px]">
        {/* 3. Bets This Round */}
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-dark-text-primary mb-3">Bets This Round</h2>
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-lg p-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
            {!round?.bets?.length ? (
              <p className="text-gray-500 dark:text-dark-text-secondary text-sm">No bets yet.</p>
            ) : (
              <ul className="space-y-2 max-h-64 overflow-y-auto">
                {round.bets.map((b) => (
                  <li
                    key={b.id}
                    className="flex justify-between items-center py-2 border-b border-gray-100 dark:border-[rgba(255,255,255,0.08)] last:border-0"
                  >
                    <span className="font-medium text-gray-900 dark:text-dark-text-primary">
                      {getPublicDisplayName(
                        { username: b.username ?? '', isAnonymous: b.isAnonymous },
                        true
                      ) || b.userId.slice(0, 8)}
                    </span>
                    <span className="text-primary-600 dark:text-primary-400 font-semibold">${(b.amountCents / 100).toFixed(2)}</span>
                    <span className="text-xs text-gray-500 dark:text-dark-text-muted">{(b.ticketsTo - b.ticketsFrom + 1)} tkts</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 4. Provably Fair block — clickable opens modal */}
        <section className="mt-8">
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-lg p-6 border border-transparent dark:border-[rgba(255,255,255,0.08)]">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-dark-text-primary mb-2">
              <button
                type="button"
                onClick={() => setProvablyFairOpen(true)}
                className="cursor-pointer underline decoration-transparent hover:decoration-current underline-offset-2 transition text-left"
              >
                Provably fair
              </button>
            </h2>
            {round?.seedHash && (
              <p className="text-xs text-gray-500 dark:text-dark-text-secondary break-all">
                Seed hash: <code className="bg-gray-100 dark:bg-dark-secondary px-1 rounded">{round.seedHash}</code>
              </p>
            )}
            {round?.status === 'FINISHED' && round?.serverSeed && !spinning && (
              <p className="text-xs text-gray-500 dark:text-dark-text-secondary break-all mt-2">
                Server seed (revealed): <code className="bg-gray-100 dark:bg-dark-secondary px-1 rounded">{round.serverSeed}</code>
              </p>
            )}
            <p className="text-xs text-gray-500 dark:text-dark-text-muted mt-1">
              Client seed: {round?.clientSeed ?? '—'} · Nonce: {round?.nonce ?? '—'}
            </p>
            {round?.status === 'FINISHED' && round?.winningTicket != null && !spinning && (
              <p className="text-sm font-medium text-primary-600 dark:text-primary-400 mt-2">Winning ticket: {round.winningTicket}</p>
            )}
          </div>
        </section>

        <div className="mt-8 pb-8">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-dark-text-primary mb-4">Your roulette history</h2>
          <p className="text-sm text-gray-500 dark:text-dark-text-muted mb-3">One row per round: total stake and total result (won or lost).</p>
          <RouletteHistory refreshWhenRoundFinished={round?.status === 'FINISHED' ? round.id : undefined} />
        </div>
      </div>

      <ProvablyFairModal open={provablyFairOpen} onClose={() => setProvablyFairOpen(false)} />
    </div>
  );
}

function ProvablyFairModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[200] flex items-end md:items-center justify-center p-0 md:p-4 bg-black/60 dark:bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provably-fair-title"
    >
      <div
        className="bg-white dark:bg-dark-card w-full md:max-w-lg md:rounded-xl shadow-2xl min-h-[70vh] md:min-h-0 md:max-h-[90vh] overflow-y-auto p-6 md:p-8 border-t md:border border-gray-200 dark:border-[rgba(255,255,255,0.08)] rounded-t-xl md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="provably-fair-title" className="text-xl font-bold text-gray-900 dark:text-dark-text-primary mb-4">
          Provably Fair
        </h2>
        <div className="text-sm text-gray-700 dark:text-dark-text-secondary space-y-3">
          <p>This roulette uses provably fair randomization.</p>
          <p>
            Before each round starts, the server generates a secret Server Seed and publishes its Server Seed Hash (SHA-256).
            This guarantees the seed was fixed before bets were placed and cannot be changed.
          </p>
          <p>The final result is generated using:</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Server Seed (hidden until round ends)</li>
            <li>Client Seed</li>
            <li>Nonce (round counter)</li>
          </ul>
          <p>After the round ends, the Server Seed is revealed.</p>
          <p>Players can verify:</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>The Server Seed matches the published hash</li>
            <li>The roulette result was generated deterministically</li>
          </ul>
          <p>
            <strong>Hashing algorithm:</strong> SHA-256. The server hashes the Server Seed to produce the published Seed Hash.
            The winning ticket is derived by hashing <code className="bg-gray-100 dark:bg-dark-secondary px-1 rounded text-xs">serverSeed:clientSeed:nonce</code> with SHA-256, then taking the first 16 hex characters modulo total tickets, plus 1.
          </p>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-primary-600 dark:bg-primary-500 text-white rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

type SpinSegment = { userId: string; label: string; tickets: number; widthPx: number };

function buildSegmentsFromBets(bets: Round['bets'], totalTickets: number, stripWidth: number): SpinSegment[] {
  if (!bets.length || totalTickets <= 0) return [];
  const byUser = new Map<string, { tickets: number; label: string }>();
  for (const b of bets) {
    const tickets = b.ticketsTo - b.ticketsFrom + 1;
    const label = getPublicDisplayName(
      { username: b.username ?? '', isAnonymous: b.isAnonymous },
      true
    ).slice(0, 12) || '#';
    const cur = byUser.get(b.userId);
    if (!cur) byUser.set(b.userId, { tickets, label });
    else cur.tickets += tickets;
  }
  const n = byUser.size;
  const minPerSegment = n > 0 ? stripWidth / n : MIN_SEGMENT_PX;
  const segments = Array.from(byUser.entries()).map(([userId, d]) => ({
    userId,
    label: d.label,
    tickets: d.tickets,
    widthPx: Math.max((d.tickets / totalTickets) * stripWidth, minPerSegment),
  }));
  const total = segments.reduce((s, seg) => s + seg.widthPx, 0);
  if (total <= 0) return segments;
  const scale = stripWidth / total;
  return segments.map((seg) => ({ ...seg, widthPx: seg.widthPx * scale }));
}

function RouletteWheel({
  round,
  spinState,
  spinning,
  suspense,
  resolving,
  onContainerResize,
  onTransitionEnd,
}: {
  round: Round | null;
  spinState: { status: 'idle' } | { status: 'spinning'; spinRoundId: string; finalOffsetPx: number } | { status: 'done'; spinRoundId: string; finalOffsetPx: number };
  spinning: boolean;
  suspense?: boolean;
  resolving?: boolean;
  onContainerResize?: (width: number) => void;
  onTransitionEnd?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const totalTickets = round?.totalTickets ?? 1;
  const bets = round?.bets ?? [];
  const status = round?.status ?? '';
  const winningTicket = round?.winningTicket ?? null;
  const stripWidth = containerWidth > 0 ? containerWidth : 800;

  const stripSegments = useMemo(
    () => buildSegmentsFromBets(bets, totalTickets, stripWidth),
    [bets, totalTickets, stripWidth]
  );
  const stripWidthPx = stripWidth * SPIN_STRIP_COPIES;
  const colors = ['#ef4444', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#ec4899'];

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      setContainerWidth(w);
      onContainerResize?.(w);
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [onContainerResize]);

  const isSpinningThisRound =
    spinState.status === 'spinning' &&
    round &&
    (spinState.spinRoundId === round.id || String(spinState.spinRoundId).startsWith('test-'));
  const isDoneThisRound =
    spinState.status === 'done' &&
    round &&
    (spinState.spinRoundId === round.id || String(spinState.spinRoundId).startsWith('test-'));
  const finalOffsetPx = (spinState.status === 'spinning' || spinState.status === 'done') ? spinState.finalOffsetPx : 0;

  useLayoutEffect(() => {
    const isThisSpin =
      round && (spinState.status === 'spinning' || spinState.status === 'done')
        ? (spinState.spinRoundId === round.id || String(spinState.spinRoundId).startsWith('test-'))
        : false;
    if (spinState.status !== 'spinning' || !round || !isThisSpin) return;
    const track = trackRef.current;
    if (!track) return;

    const onEnd = () => {
      track.removeEventListener('transitionend', onEnd);
      onTransitionEnd?.();
    };
    track.addEventListener('transitionend', onEnd);

    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
    const rafId = requestAnimationFrame(() => {
      track.style.transition = `transform ${SPIN_DURATION_MS}ms cubic-bezier(0.12, 0, 0.08, 1)`;
      track.style.transform = `translateX(-${spinState.finalOffsetPx}px)`;
    });
    return () => {
      cancelAnimationFrame(rafId);
      track.removeEventListener('transitionend', onEnd);
    };
  }, [
    spinState.status,
    spinState.status === 'spinning' || spinState.status === 'done' ? spinState.spinRoundId : null,
    spinState.status === 'spinning' || spinState.status === 'done' ? spinState.finalOffsetPx : 0,
    round?.id,
    onTransitionEnd,
  ]);

  const trackTransform =
    isDoneThisRound
      ? `translateX(-${finalOffsetPx}px)`
      : 'translateX(0)';
  const trackTransition = 'transform 0.15s ease-out';
  const styleControlledByEffect = isSpinningThisRound;

  if (!bets.length) {
    return (
      <div className="h-32 md:h-40 rounded-lg bg-gray-100 dark:bg-dark-secondary flex items-center justify-center text-gray-500 dark:text-dark-text-secondary animate-roulette-wheel-idle">
        No bets — wheel will appear when round has bets
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-lg bg-gray-900 h-28 md:h-36 lg:h-40"
    >
      <div
        ref={trackRef}
        className="absolute inset-y-0 left-0 flex will-change-transform"
        style={{
          width: stripWidthPx,
          ...(styleControlledByEffect ? {} : { transform: trackTransform, transition: trackTransition }),
        }}
      >
        {Array.from({ length: SPIN_STRIP_COPIES }, (_, copy) =>
          stripSegments.map((seg, i) => (
            <div
              key={`${copy}-${seg.userId}-${i}`}
              className="flex-shrink-0 h-full flex items-center justify-center text-white text-sm font-semibold border-r border-white/20"
              style={{
                width: seg.widthPx,
                minWidth: seg.widthPx,
                backgroundColor: colors[i % colors.length],
              }}
            >
              {seg.label}
            </div>
          ))
        )}
      </div>
      <div
        className="absolute top-0 bottom-0 left-1/2 w-1 pointer-events-none z-10"
        style={{
          transform: 'translateX(-50%)',
          background: 'linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.95) 5%, #fff 50%, rgba(255,255,255,0.95) 95%, transparent 100%)',
          boxShadow: '0 0 12px rgba(255,255,255,0.9), 0 0 24px rgba(0,0,0,0.3)',
        }}
      />
      {status === 'FINISHED' && winningTicket != null && !spinning && (
        <p className="absolute bottom-1 left-2 text-xs text-white/90 z-10">
          Winner: ticket #{winningTicket}
        </p>
      )}
    </div>
  );
}

type MyBetRow = {
  id: string;
  roundId: string;
  roundNumber: number;
  amountCents: number;
  ticketsFrom: number;
  ticketsTo: number;
  won: boolean;
  payoutCents: number | null;
  createdAt: string;
  roundStatus: string;
};

function RouletteHistory({ refreshWhenRoundFinished }: { refreshWhenRoundFinished?: string }) {
  const [myBets, setMyBets] = useState<MyBetRow[]>([]);

  useEffect(() => {
    rouletteAPI.getMyBets(200).then((res) => setMyBets(res.data ?? [])).catch(() => {});
  }, [refreshWhenRoundFinished]);

  const byRound = useMemo(() => {
    const map = new Map<
      string,
      { roundNumber: number; totalStakeCents: number; payoutCents: number; firstAt: string }
    >();
    for (const b of myBets) {
      const cur = map.get(b.roundId);
      const addPayout = b.won && b.payoutCents != null ? b.payoutCents : 0;
      if (!cur) {
        map.set(b.roundId, {
          roundNumber: b.roundNumber,
          totalStakeCents: b.amountCents,
          payoutCents: addPayout,
          firstAt: b.createdAt,
        });
      } else {
        cur.totalStakeCents += b.amountCents;
        cur.payoutCents += addPayout;
        if (b.createdAt < cur.firstAt) cur.firstAt = b.createdAt;
      }
    }
    return Array.from(map.entries())
      .map(([roundId, d]) => ({
        roundId,
        roundNumber: d.roundNumber,
        totalStakeCents: d.totalStakeCents,
        resultCents: d.payoutCents - d.totalStakeCents,
        firstAt: d.firstAt,
      }))
      .sort((a, b) => new Date(b.firstAt).getTime() - new Date(a.firstAt).getTime());
  }, [myBets]);

  if (!byRound.length) {
    return <p className="text-gray-500 dark:text-dark-text-secondary">No rounds with your bets yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left text-gray-700 dark:text-dark-text-secondary">
        <thead>
          <tr className="border-b border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
            <th className="py-2 dark:text-dark-text-muted">Date</th>
            <th className="py-2 dark:text-dark-text-muted">Round</th>
            <th className="py-2 dark:text-dark-text-muted">Total stake</th>
            <th className="py-2 dark:text-dark-text-muted">Result</th>
          </tr>
        </thead>
        <tbody>
          {byRound.map((r) => (
            <tr key={r.roundId} className="border-b border-gray-100 dark:border-[rgba(255,255,255,0.08)] dark:hover:bg-[rgba(255,255,255,0.04)] transition">
              <td className="py-2 dark:text-dark-text-secondary">
                {new Date(r.firstAt).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="py-2 font-medium dark:text-dark-text-primary">#{r.roundNumber}</td>
              <td className="py-2 dark:text-dark-text-secondary">${(r.totalStakeCents / 100).toFixed(2)}</td>
              <td className={`py-2 font-semibold ${r.resultCents >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {r.resultCents >= 0 ? '+' : ''}${(r.resultCents / 100).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
