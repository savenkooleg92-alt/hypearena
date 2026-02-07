import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Добавляем токен авторизации к каждому запросу
api.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;

// Auth API
export const authAPI = {
  register: (data: { email: string; username: string; password: string }) =>
    api.post('/auth/register', data),
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
};

// Markets API
export const marketsAPI = {
  getAll: (params?: { status?: string; category?: string; subCategory?: string; q?: string }) =>
    api.get('/markets', { params }),
  getOne: (id: string) => api.get(`/markets/${id}`),
  create: (data: {
    title: string;
    description?: string;
    category?: string;
    outcomes: string[];
    endDate?: string;
    startsAt?: string;
  }) => api.post('/markets', data),
  resolve: (id: string, winningOutcome: string) =>
    api.post(`/markets/${id}/resolve`, { winningOutcome }),
  getEventMarkets: (eventKey: string) =>
    api.get<{ eventKey: string; markets: Array<{ id: string; title: string; status: string; outcomes: string[]; odds: Record<string, number>; totalVolume: number; startsAt?: string | null; winningOutcome?: string | null; marketType?: string | null }> }>(`/markets/event/${encodeURIComponent(eventKey)}`),
};

// Support API (auth required)
export const supportAPI = {
  createTicket: (formData: FormData) =>
    fetch(`${API_URL}/support/ticket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('token') : ''}`,
      },
      body: formData,
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Something went wrong');
      return data;
    }),
  getMyTickets: () => api.get<Array<{
    id: string;
    subject: string;
    description: string;
    attachments: string[];
    status: string;
    adminReply: string | null;
    repliedAt: string | null;
    createdAt: string;
  }>>('/support/my-tickets'),
};

// Chat API (per-event thread; eventKey = oracleMatchId ?? market.id)
export type ChatMessage = {
  id: string;
  userId: string | null;
  username: string;
  body: string;
  createdAt: string;
};

export const chatAPI = {
  getThread: (eventKey: string) =>
    api.get<{ threadId: string }>(`/chat/thread/${encodeURIComponent(eventKey)}`),
  getMessages: (eventKey: string, params?: { cursor?: string; limit?: number }) =>
    api.get<{ messages: ChatMessage[]; nextCursor: string | null }>(`/chat/thread/${encodeURIComponent(eventKey)}/messages`, { params }),
  postMessage: (eventKey: string, data: { body: string; anonymous?: boolean }) =>
    api.post<{ message: ChatMessage }>(`/chat/thread/${encodeURIComponent(eventKey)}/messages`, data),
};

// Bets API
export const betsAPI = {
  place: (data: { marketId: string; outcome: string; amount: number }) =>
    api.post('/bets', data),
  getMyBets: () => api.get('/bets/my-bets'),
};

// Users API
export const usersAPI = {
  getMe: () => api.get('/users/me'),
  getTransactions: () => api.get('/users/transactions'),
  updateProfile: (data: {
    currentPassword?: string;
    newPassword?: string;
    isAnonymous?: boolean;
  }) => api.patch('/users/me', data),
  requestEmailChange: (newEmail: string) =>
    api.post('/users/me/email/request', { newEmail }),
  confirmEmailChange: (newEmail: string, code: string) =>
    api.post('/users/me/email/confirm', { newEmail, code }),
};

// Wallet API (deposit addresses per network). Backend expects network: TRON | SOL | MATIC.
export type WithdrawalItem = {
  id: string;
  network: string;
  toAddress: string;
  amountGross: number;
  fee: number;
  amountNet: number;
  status: string;
  txId: string | null;
  error: string | null;
  createdAt: string;
};

export type WithdrawQuote = {
  amountRequested: number;
  feeUsd: number;
  amountToSend: number;
  currency: string;
  networkFeeInfo: string;
  minAmountRequested?: number;
};

export type WithdrawBreakdown = {
  amountRequested: number;
  feeUsd: number;
  amountToSend: number;
  currency: string;
  networkFeeInfo: string;
};

export const walletAPI = {
  getAddresses: () => api.get<{ addresses: Record<string, string> }>('/wallet/addresses'),
  createAddress: (network: 'TRON' | 'SOL' | 'MATIC') =>
    api.post<{ address: string }>('/wallet/address', { network }),
  getWithdrawQuote: (network: 'TRON' | 'MATIC' | 'SOL', amount: number) =>
    api.get<{ ok: boolean } & WithdrawQuote>('/wallet/withdraw/quote', {
      params: { network, amount },
    }),
  withdraw: (data: { network: 'TRON' | 'MATIC' | 'SOL'; toAddress: string; amount: number }) =>
    api.post<{
      ok: boolean;
      request: WithdrawalItem;
      updatedBalance: number;
      breakdown?: WithdrawBreakdown;
    }>('/wallet/withdraw', data),
  getWithdrawals: () =>
    api.get<{ ok: boolean; items: WithdrawalItem[] }>('/wallet/withdraw'),
  getMyDeposits: (limit?: number) =>
    api.get<{
      deposits: Array<{
        id: string;
        network: string;
        txHash: string;
        depositAddress: string;
        rawAmount: number;
        amountUsd: number;
        status: string;
        isBelowMinimum: boolean | null;
        createdAt: string;
      }>;
    }>('/wallet/me/deposits', { params: limit != null ? { limit } : {} }),
  getTransactions: (limit?: number) =>
    api.get<{
      ok: boolean;
      items: Array<{
        id: string;
        type: 'Deposit' | 'Withdraw';
        amountGross: number;
        fee: number;
        netAmount: number;
        currency: string;
        network: string;
        status: string;
        createdAt: string;
      }>;
    }>('/wallet/transactions', { params: limit != null ? { limit } : {} }),
  /** Polygon "I paid" — submit Transaction Hash; one hash = one credit (admin verifies). */
  submitPolygonTxHash: (txHash: string) =>
    api.post<{ ok: boolean; message?: string }>('/wallet/polygon-tx-submit', { txHash }),
};

// Admin API (requires admin JWT)
export const adminAPI = {
  getStats: () => api.get<{
    platformBalance: number;
    depositsToday: number;
    depositsTotal: number;
    pendingWithdrawals: number;
    openMarkets: number;
    oracle: {
      tokensRemaining: number;
      requestsInLastHour: number;
      shouldStop: boolean;
      nfl?: { requestsUsedToday: number; dailyLimit: number };
    };
    roulette?: { totalVolumeCents: number; totalFeesCents: number; feesWaivedCount: number };
  }>('/admin/stats'),
  getMarkets: (params?: { status?: string; title?: string; awaiting?: boolean }) =>
    api.get('/admin/markets', { params: params?.awaiting ? { ...params, awaiting: '1' } : params }),
  removeMarket: (id: string, options?: { refund: boolean }) =>
    api.post(`/admin/markets/${id}/remove`, options ?? {}, { timeout: 15000 }),
  resolveMarket: (id: string, winningOutcome: string) =>
    api.post(`/admin/markets/${id}/resolve`, { winningOutcome }),
  getPendingMarkets: () => api.get('/admin/markets/pending'),
  updateMarket: (id: string, data: { title?: string; description?: string; category?: string; subCategory?: string; outcomes?: string[]; endDate?: string | null; startsAt?: string | null }) =>
    api.patch(`/admin/markets/${id}`, data),
  approveMarket: (id: string) => api.post(`/admin/markets/${id}/approve`),
  rejectMarket: (id: string) => api.post(`/admin/markets/${id}/reject`),
  createMarket: (data: {
    title: string;
    description?: string;
    category?: string;
    outcomes: string[];
    endDate?: string;
    startsAt?: string;
  }) => api.post('/admin/markets', data),
  getSupportTickets: (status?: string) =>
    api.get<Array<{
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
    }>>('/admin/support/tickets', { params: status ? { status } : undefined }),
  replySupportTicket: (id: string, reply: string) =>
    api.post(`/admin/support/${id}/reply`, { reply }),
  closeSupportTicket: (id: string) => api.post(`/admin/support/${id}/close`),
  getBets: () => api.get('/admin/bets'),
  getDeposits: () => api.get('/admin/deposits'),
  getDepositsSol: () =>
    api.get<
      Array<{
        id: string;
        userId: string;
        network: string;
        txHash: string;
        depositAddress: string;
        rawAmount: number;
        amountUsd: number;
        priceUsed: number | null;
        status: string;
        isBelowMinimum: boolean;
        sweepTxId: string | null;
        createdAt: string;
        user: { id: string; username: string };
      }>
    >('/admin/deposits/sol'),
  getDepositsSolPending: () =>
    api.get<{
      pending: Array<{
        id: string;
        txHash: string;
        depositAddress: string;
        amountUsd: number;
        status: string;
        user: { id: string; username: string; email: string };
      }>;
      count: number;
    }>('/admin/deposits/sol/pending'),
  runSolUsdcCreditStep: () =>
    api.post<{ ok: boolean; credited: number; errors?: string[] }>('/admin/deposits/run-usdc-credit-step'),
  creditOneSolUsdc: (txHash: string) =>
    api.post<{ ok: boolean; alreadyCredited?: boolean; credited?: boolean; userId?: string; amountUsd?: number; previousStatus?: string; error?: string }>('/admin/deposits/credit-one-sol-usdc', { txHash }),
  reconcileSolUsdc: () =>
    api.post<{ ok: boolean; detected: number; confirmed: number; failed: number; swept: number; credited: number; errors?: string[] }>('/admin/solana/usdc/reconcile'),
  reconcileSolUsdcByTxHash: (txHash: string) =>
    api.post<{ ok: boolean; alreadyCredited?: boolean; credited?: boolean; userId?: string; amountUsd?: number; previousStatus?: string; error?: string }>(`/admin/solana/usdc/reconcile/${encodeURIComponent(txHash)}`),
  sweepSolUsdcToMaster: () =>
    api.post<{ ok: boolean; swept: number; sweptTxIds?: string[]; errors?: string[] }>('/admin/solana/usdc/sweep-pending'),
  runSolUsdcDepositCycle: () =>
    api.post<{
      ok: boolean;
      detected: number;
      confirmed: number;
      failed: number;
      swept: number;
      credited: number;
      errors?: string[];
    }>('/admin/deposits/run-usdc-cycle'),
  getDepositsTron: () =>
    api.get<
      Array<{
        id: string;
        userId: string;
        network: string;
        txHash: string;
        depositAddress: string;
        rawAmount: number;
        amountUsd: number;
        status: string;
        sweepTxId: string | null;
        createdAt: string;
        user: { id: string; username: string };
      }>
    >('/admin/deposits/tron'),
  getDepositsPolygon: () =>
    api.get<
      Array<{
        id: string;
        userId: string;
        network: string;
        txHash: string;
        depositAddress: string;
        rawAmount: number;
        amountUsd: number;
        status: string;
        sweepTxId: string | null;
        createdAt: string;
        user: { id: string; username: string };
      }>
    >('/admin/deposits/polygon'),
  runTronUsdtCycle: () =>
    api.post<{
      ok: boolean;
      detected: number;
      confirmed: number;
      failed: number;
      credited: number;
      errors?: string[];
    }>('/admin/tron/usdt/run-cycle'),
  sweepTronUsdtToMaster: () =>
    api.post<{ ok: boolean; sweptCount: number; results?: Array<{ network: string; address: string; amount: number; txId: string; success: boolean; error?: string }> }>(
      '/admin/tron/usdt/sweep'
    ),
  runPolygonUsdtCycle: () =>
    api.post<{
      ok: boolean;
      detected: number;
      confirmed: number;
      failed?: number;
      credited: number;
      swept?: number;
      errors?: string[];
    }>('/admin/polygon/usdt/run-cycle'),
  sweepPolygonUsdtToMaster: () =>
    api.post<{ ok: boolean; sweptCount: number; message?: string; results?: Array<{ network: string; address: string; amount: number; txId: string; success: boolean; error?: string }> }>(
      '/admin/polygon/usdt/sweep'
    ),
  creditPolygonDeposit: (body: { txHash: string; depositAddress: string; amountUsd: number }) =>
    api.post<{ ok: boolean; credited?: boolean; error?: string }>('/admin/polygon/credit-deposit', body),
  creditPolygonDepositByTxHash: (txHash: string) =>
    api.post<{
      ok: boolean;
      credited?: boolean;
      alreadyCredited?: boolean;
      depositAddress?: string;
      amountUsd?: number;
      error?: string;
    }>('/admin/polygon/credit-by-tx', { txHash }),
  /** Зачислить по tx hash и сразу отправить POL на адрес + sweep на мастер. */
  creditAndSweepPolygon: (txHash: string) =>
    api.post<{
      ok: boolean;
      credited: boolean;
      depositAddress?: string;
      sweptCount: number;
      results?: Array<{ address: string; amount: number; txId: string; success: boolean; error?: string }>;
      message?: string;
      error?: string;
    }>('/admin/polygon/credit-and-sweep', { txHash }),
  getPolygonUserSubmissions: () =>
    api.get<
      Array<{
        id: string;
        userId: string;
        txHash: string;
        status: string;
        createdAt: string;
        creditedAt: string | null;
        amountUsd: number | null;
        depositAddress: string | null;
        adminNote: string | null;
        user: { id: string; username: string; email: string };
      }>
    >('/admin/polygon/user-submissions'),
  creditPolygonUserSubmission: (id: string) =>
    api.post<{
      ok: boolean;
      credited?: boolean;
      alreadyCredited?: boolean;
      amountUsd?: number;
      depositAddress?: string;
      sweptCount?: number;
      results?: Array<{ address: string; amount: number; txId: string; success: boolean; error?: string }>;
      message?: string;
      error?: string;
    }>('/admin/polygon/user-submissions/credit', { id }),
  backfillSolUsdcDeposit: (body: { txHash: string; userEmail: string; amountUsd?: number }) =>
    api.post<{
      ok: boolean;
      alreadyCredited?: boolean;
      credited?: boolean;
      userId?: string;
      amountUsd?: number;
      error?: string;
      message?: string;
    }>('/admin/deposits/backfill-sol-usdc', body),
  getWithdrawals: () => api.get('/admin/withdrawals'),
  getWithdrawalsStats: () =>
    api.get<{
      totalWithdrawalsToday: number;
      totalWithdrawalsVolume: number;
      pendingCount: number;
      failedCount: number;
      approvedCount: number;
    }>('/admin/withdrawals/stats'),
  approveWithdrawal: (id: string) => api.post(`/admin/withdrawals/${id}/approve`),
  rejectWithdrawal: (id: string, data?: { error?: string }) => api.post(`/admin/withdrawals/${id}/reject`, data ?? {}),
  sendWithdrawalPayout: (id: string) => api.post<{ ok: boolean; request: unknown; txId: string }>(`/admin/withdrawals/${id}/send-payout`),
  retryWithdrawal: (id: string) => api.post(`/admin/withdrawals/${id}/retry`),
  sendAllApprovedWithdrawals: () =>
    api.post<{ ok: boolean; sent: number; failed: number; results: Array<{ id: string; txId?: string; error?: string }> }>('/admin/withdrawals/send-all-approved'),
  failWithdrawal: (id: string, data?: { error?: string }) => api.post(`/admin/withdrawals/${id}/fail`, data ?? {}),
  oracleSync: () => api.post('/admin/oracle/sync'),
  oracleResolve: () => api.post('/admin/oracle/resolve'),
  oracleCancelStale: () =>
    api.post<{ ok: boolean; cancelled: number; errors: string[] }>('/admin/oracle/cancel-stale'),
  oracleReopenMatch: (oracleMatchId: string) =>
    api.post<{ ok: boolean; oracleMatchId: string; reopenedMarketIds: string[]; error?: string }>(
      '/admin/oracle/reopen-match',
      { oracleMatchId }
    ),
  oracleResolveMatch: (oracleMatchId: string) =>
    api.post<{
      ok: boolean;
      oracleMatchId: string;
      matchStatus?: string;
      winnerOutcome?: string;
      resolvedMarketIds: string[];
      error?: string;
    }>('/admin/oracle/resolve-match', { oracleMatchId }),
  /** POST /api/admin/oracle/test-apisports — one NFL request, returns requestsUsedBefore/After */
  oracleTestApisports: () =>
    api.post<{
      ok: boolean;
      sport: string;
      requestsUsedBefore: number;
      requestsUsedAfter: number;
      gamesCount?: number;
      message?: string;
      error?: string;
    }>('/admin/oracle/test-apisports'),
  getRouletteCurrent: () => api.get('/admin/roulette/current'),
  getRouletteHistory: (limit?: number) => api.get('/admin/roulette/history', { params: limit != null ? { limit } : {} }),
  rouletteResolve: () => api.post('/admin/roulette/resolve'),
};

// Roulette API (public + auth for bet)
export const rouletteAPI = {
  getCurrent: () => api.get<{
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
  }>('/roulette/current'),
  placeBet: (amount: number) => api.post<{ ok: true; round: unknown }>('/roulette/bet', { amount }),
  getMyBets: (limit?: number) =>
    api.get<Array<{
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
    }>>('/roulette/my-bets', { params: limit != null ? { limit } : {} }),
  getHistory: (limit?: number) =>
    api.get<Array<{
      id: string;
      roundNumber: number;
      status: string;
      startsAt: string | null;
      endsAt: string | null;
      seedHash: string | null;
      serverSeed: string | null;
      clientSeed: string;
      nonce: number;
      totalTickets: number;
      potCents: number;
      feeCents: number;
      winnerUserId: string | null;
      winningTicket: number | null;
      bets: Array<{ id: string; userId: string; username?: string; isAnonymous?: boolean; amountCents: number; ticketsFrom: number; ticketsTo: number }>;
    }>>('/roulette/history', { params: limit != null ? { limit } : {} }),
};