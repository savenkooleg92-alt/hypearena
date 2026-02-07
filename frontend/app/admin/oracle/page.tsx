'use client';

import { useEffect, useState, useCallback } from 'react';
import api, { adminAPI } from '@/lib/api';

type MarketRow = {
  id: string;
  title: string;
  status: string;
  category: string | null;
  endDate: string | null;
  outcomes: string[];
};

export default function AdminOraclePage() {
  const [stats, setStats] = useState<{
    tokensRemaining: number;
    requestsInLastHour: number;
    shouldStop: boolean;
    nfl?: { requestsUsedToday: number; dailyLimit: number };
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [testNflLoading, setTestNflLoading] = useState(false);
  const [testNflResult, setTestNflResult] = useState<{
    requestsUsedBefore: number;
    requestsUsedAfter: number;
    gamesCount?: number;
    message?: string;
    error?: string;
  } | null>(null);
  const [lastSync, setLastSync] = useState<{
    created: number;
    skipped: number;
    errors?: string[];
    rateLimited?: boolean;
    matchesFound?: number;
  } | null>(null);
  const [lastResolve, setLastResolve] = useState<{ resolved: number; errors?: string[] } | null>(null);
  const [cancelStaleLoading, setCancelStaleLoading] = useState(false);
  const [cancelStaleResult, setCancelStaleResult] = useState<{ cancelled: number; errors?: string[] } | null>(null);
  const [resolveMatchId, setResolveMatchId] = useState('');
  const [resolveMatchLoading, setResolveMatchLoading] = useState(false);
  const [resolveMatchResult, setResolveMatchResult] = useState<{
    ok: boolean;
    winnerOutcome?: string;
    resolvedMarketIds?: string[];
    error?: string;
  } | null>(null);
  const [reopenMatchId, setReopenMatchId] = useState('');
  const [reopenLoading, setReopenLoading] = useState(false);
  const [reopenResult, setReopenResult] = useState<{
    ok: boolean;
    reopenedMarketIds?: string[];
    error?: string;
  } | null>(null);
  const [politicsEnded, setPoliticsEnded] = useState<MarketRow[]>([]);
  const [politicsResolvingId, setPoliticsResolvingId] = useState<string | null>(null);

  const loadPoliticsEnded = useCallback(() => {
    adminAPI.getMarkets({ status: 'OPEN' }).then((res) => {
      const list = Array.isArray(res.data) ? res.data : [];
      const now = new Date().getTime();
      const ended = list.filter(
        (m: MarketRow) =>
          m.category === 'politics' &&
          m.status === 'OPEN' &&
          m.endDate &&
          new Date(m.endDate).getTime() < now
      );
      setPoliticsEnded(ended);
    }).catch(() => setPoliticsEnded([]));
  }, []);

  useEffect(() => {
    loadPoliticsEnded();
  }, [loadPoliticsEnded]);

  const resolvePoliticsMarket = (marketId: string, winningOutcome: string) => {
    setPoliticsResolvingId(marketId);
    adminAPI
      .resolveMarket(marketId, winningOutcome)
      .then(() => {
        loadPoliticsEnded();
        loadStats();
      })
      .catch((e) => alert(e.response?.data?.error ?? 'Failed to resolve'))
      .finally(() => setPoliticsResolvingId(null));
  };

  const loadStats = () => {
    adminAPI
      .getStats()
      .then((res) => setStats(res.data.oracle))
      .catch(() => setStats(null));
  };

  useEffect(() => {
    loadStats();
    const t = setInterval(loadStats, 10000);
    return () => clearInterval(t);
  }, []);

  const runSync = () => {
    setSyncing(true);
    adminAPI
      .oracleSync()
      .then((res) => {
        setLastSync({
          created: res.data.created,
          skipped: res.data.skipped,
          errors: res.data.errors,
          rateLimited: res.data.rateLimited,
          matchesFound: res.data.matchesFound,
        });
        loadStats();
      })
      .catch((e) => alert(e.response?.data?.error ?? e.message))
      .finally(() => setSyncing(false));
  };

  const runResolve = () => {
    setResolving(true);
    adminAPI
      .oracleResolve()
      .then((res) => {
        setLastResolve({
          resolved: res.data.resolved,
          errors: res.data.errors?.length ? res.data.errors : undefined,
        });
        loadStats();
      })
      .catch((e) => {
        const msg = e.response?.data?.message ?? e.response?.data?.error ?? e.message;
        setLastResolve({ resolved: 0, errors: [String(msg)] });
      })
      .finally(() => setResolving(false));
  };

  const runCancelStale = () => {
    setCancelStaleLoading(true);
    setCancelStaleResult(null);
    adminAPI
      .oracleCancelStale()
      .then((res) => {
        setCancelStaleResult({
          cancelled: res.data.cancelled,
          errors: res.data.errors?.length ? res.data.errors : undefined,
        });
      })
      .catch((e) => {
        setCancelStaleResult({ cancelled: 0, errors: [e.response?.data?.error ?? e.message] });
      })
      .finally(() => setCancelStaleLoading(false));
  };

  const runReopenMatch = () => {
    const id = reopenMatchId.trim();
    if (!id) {
      alert('Введите oracleMatchId (CANCELLED маркеты по этому матчу будут возвращены в OPEN)');
      return;
    }
    setReopenLoading(true);
    setReopenResult(null);
    adminAPI
      .oracleReopenMatch(id)
      .then((res) => {
        setReopenResult({
          ok: res.data.ok,
          reopenedMarketIds: res.data.reopenedMarketIds,
          error: res.data.error,
        });
        if (res.data.ok && res.data.reopenedMarketIds?.length) setResolveMatchId(id);
      })
      .catch((e) => setReopenResult({ ok: false, error: e.response?.data?.error ?? e.message }))
      .finally(() => setReopenLoading(false));
  };

  const runResolveMatch = () => {
    const id = resolveMatchId.trim();
    if (!id) {
      alert('Введите oracleMatchId (из БД: Market.oracleMatchId или из логов резолва)');
      return;
    }
    setResolveMatchLoading(true);
    setResolveMatchResult(null);
    adminAPI
      .oracleResolveMatch(id)
      .then((res) => {
        setResolveMatchResult({
          ok: res.data.ok,
          winnerOutcome: res.data.winnerOutcome,
          resolvedMarketIds: res.data.resolvedMarketIds,
          error: res.data.error,
        });
        if (res.data.ok) loadStats();
      })
      .catch((e) => {
        setResolveMatchResult({
          ok: false,
          error: e.response?.data?.error ?? e.message,
        });
      })
      .finally(() => setResolveMatchLoading(false));
  };

  const runTestNfl = () => {
    setTestNflLoading(true);
    setTestNflResult(null);
    const request =
      typeof adminAPI.oracleTestApisports === 'function'
        ? adminAPI.oracleTestApisports()
        : api.post<{
            ok: boolean;
            sport: string;
            requestsUsedBefore: number;
            requestsUsedAfter: number;
            gamesCount?: number;
            message?: string;
            error?: string;
          }>('/admin/oracle/test-apisports');
    request
      .then((res) => {
        const d = res.data;
        setTestNflResult({
          requestsUsedBefore: d.requestsUsedBefore,
          requestsUsedAfter: d.requestsUsedAfter,
          gamesCount: d.gamesCount,
          message: d.message,
          error: d.error,
        });
        loadStats();
      })
      .catch((e) => {
        const err = e.response?.data?.error ?? e.response?.data?.message ?? e.message;
        setTestNflResult({ requestsUsedBefore: 0, requestsUsedAfter: 0, error: String(err) });
      })
      .finally(() => setTestNflLoading(false));
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Oracle</h1>
      {stats && (
        <div className="mb-6 p-4 bg-white dark:bg-dark-card rounded-lg shadow border border-transparent dark:border-[rgba(255,255,255,0.08)]">
          <p><strong>PandaScore (e-sports)</strong></p>
          <p><strong>Tokens remaining:</strong> {stats.tokensRemaining}</p>
          <p><strong>Requests in last hour:</strong> {stats.requestsInLastHour}</p>
          <p><strong>Rate limit active:</strong> {stats.shouldStop ? 'Yes' : 'No'}</p>
          {stats.nfl != null && (
            <>
              <p className="mt-3"><strong>API-Sports NFL</strong></p>
              <p><strong>Requests used today:</strong> {stats.nfl.requestsUsedToday} / {stats.nfl.dailyLimit}</p>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        <button
          onClick={runSync}
          disabled={syncing}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {syncing ? 'Running…' : 'Run sync (discovery)'}
        </button>
        <button
          onClick={runResolve}
          disabled={resolving}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {resolving ? 'Running…' : 'Run resolve'}
        </button>
        <button
          onClick={runTestNfl}
          disabled={testNflLoading}
          className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
        >
          {testNflLoading ? 'Running…' : 'Test NFL request'}
        </button>
        <button
          onClick={runCancelStale}
          disabled={cancelStaleLoading}
          className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
        >
          {cancelStaleLoading ? 'Running…' : 'Cancel stale markets'}
        </button>
      </div>
      <div className="mt-6 p-4 bg-white dark:bg-dark-card rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
        <p className="font-medium text-gray-900 dark:text-white mb-3">Politics — Set outcome / Resolve</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          OPEN Politics markets whose end date has passed (ENDED). Set winning outcome to move to RESOLVED.
        </p>
        {politicsEnded.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No ENDED Politics markets.</p>
        ) : (
          <ul className="space-y-3">
            {politicsEnded.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 p-2 bg-gray-50 dark:bg-dark-secondary rounded">
                <span className="font-medium text-gray-900 dark:text-white truncate max-w-[280px]" title={m.title}>
                  {m.title}
                </span>
                <select
                  id={`outcome-${m.id}`}
                  className="px-2 py-1 border border-gray-300 dark:border-[rgba(255,255,255,0.2)] dark:bg-dark-card dark:text-dark-text-primary rounded text-sm"
                >
                  {m.outcomes.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const sel = document.getElementById(`outcome-${m.id}`) as HTMLSelectElement | null;
                    const outcome = sel?.value;
                    if (outcome) resolvePoliticsMarket(m.id, outcome);
                  }}
                  disabled={politicsResolvingId === m.id}
                  className="px-3 py-1 bg-emerald-600 text-white rounded text-sm hover:bg-emerald-700 disabled:opacity-50"
                >
                  {politicsResolvingId === m.id ? '…' : 'Set outcome / Resolve'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-6 p-4 bg-white dark:bg-dark-card rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
        <p className="font-medium text-gray-900 dark:text-white mb-2">Reopen CANCELLED match (eSports)</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
          Вернёт CANCELLED маркеты в OPEN (reverse refund). После этого нажми «Resolve this match» ниже.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={reopenMatchId}
            onChange={(e) => setReopenMatchId(e.target.value)}
            placeholder="oracleMatchId"
            className="px-3 py-2 border border-gray-300 dark:border-[rgba(255,255,255,0.2)] dark:bg-dark-secondary dark:text-dark-text-primary rounded-lg min-w-[120px]"
          />
          <button
            onClick={runReopenMatch}
            disabled={reopenLoading || !reopenMatchId.trim()}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
          >
            {reopenLoading ? '…' : 'Reopen match'}
          </button>
        </div>
        {reopenResult && (
          <div className="mt-2 text-sm">
            {reopenResult.ok ? (
              <p className="text-green-600 dark:text-green-400">
                Reopened: {reopenResult.reopenedMarketIds?.length ?? 0} market(s). Use «Resolve this match» below.
              </p>
            ) : (
              <p className="text-red-600 dark:text-red-400">{reopenResult.error ?? 'Error'}</p>
            )}
          </div>
        )}
      </div>
      <div className="mt-6 p-4 bg-white dark:bg-dark-card rounded-lg border border-gray-200 dark:border-[rgba(255,255,255,0.08)]">
        <p className="font-medium text-gray-900 dark:text-white mb-2">Resolve one match (eSports)</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
          oracleMatchId — из БД (Market.oracleMatchId) или из логов. Закроет все OPEN match_winner по этому матчу с победителем.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={resolveMatchId}
            onChange={(e) => setResolveMatchId(e.target.value)}
            placeholder="oracleMatchId"
            className="px-3 py-2 border border-gray-300 dark:border-[rgba(255,255,255,0.2)] dark:bg-dark-secondary dark:text-dark-text-primary rounded-lg min-w-[120px]"
          />
          <button
            onClick={runResolveMatch}
            disabled={resolveMatchLoading || !resolveMatchId.trim()}
            className="px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50"
          >
            {resolveMatchLoading ? 'Running…' : 'Resolve this match'}
          </button>
        </div>
      </div>
      {testNflResult && (
        <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded text-sm">
          <p><strong>Test result:</strong> requestsUsedBefore={testNflResult.requestsUsedBefore}, requestsUsedAfter={testNflResult.requestsUsedAfter}{testNflResult.gamesCount != null ? `, gamesCount=${testNflResult.gamesCount}` : ''}</p>
          {testNflResult.message && <p>{testNflResult.message}</p>}
          {testNflResult.error && <p className="text-red-600 dark:text-red-400">{testNflResult.error}</p>}
        </div>
      )}
      {cancelStaleResult && (
        <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-800 rounded text-sm">
          <p><strong>Cancel stale:</strong> cancelled {cancelStaleResult.cancelled} markets</p>
          {cancelStaleResult.errors?.length ? (
            <p className="text-amber-600 dark:text-amber-400 mt-1">Errors: {cancelStaleResult.errors.join('; ')}</p>
          ) : null}
        </div>
      )}
      {resolveMatchResult && (
        <div className="mt-4 p-3 bg-gray-100 dark:bg-gray-800 rounded text-sm">
          {resolveMatchResult.ok ? (
            <>
              <p><strong>Resolve match:</strong> ok, winner = {resolveMatchResult.winnerOutcome ?? '—'}</p>
              <p>Resolved market IDs: {resolveMatchResult.resolvedMarketIds?.length ? resolveMatchResult.resolvedMarketIds.join(', ') : '—'}</p>
            </>
          ) : (
            <p className="text-red-600 dark:text-red-400">{resolveMatchResult.error ?? 'Error'}</p>
          )}
        </div>
      )}
      {(lastSync || lastResolve) && (
        <div className="mt-4 text-sm text-gray-500">
          {lastSync && (
            <>
              <p>Last sync: created {lastSync.created}, skipped {lastSync.skipped}</p>
              {typeof lastSync.matchesFound === 'number' && (
                <p>Upcoming matches from PandaScore: {lastSync.matchesFound}</p>
              )}
              {lastSync.rateLimited && (
                <p className="text-amber-600 dark:text-amber-400">Rate limit. Wait and try again.</p>
              )}
              {lastSync.errors?.length ? (
                <p className="text-amber-600 dark:text-amber-400">Errors: {lastSync.errors.join('; ')}</p>
              ) : null}
              {lastSync.created === 0 && lastSync.skipped === 0 && !lastSync.rateLimited && !lastSync.errors?.length && (
                <p className="text-gray-500 dark:text-gray-400">No new markets: either no upcoming matches in 15min–72h window, or hourly cap reached. Discovery also runs automatically every 30 min.</p>
              )}
            </>
          )}
          {lastResolve && (
            <>
              <p>Last resolve: {lastResolve.resolved} markets resolved</p>
              {lastResolve.errors?.length ? (
                <p className="mt-1 text-amber-600 dark:text-amber-400">Errors: {lastResolve.errors.join('; ')}</p>
              ) : null}
            </>
          )}
        </div>
      )}
      <div className="mt-6 p-3 bg-blue-50 dark:bg-blue-900/20 rounded text-sm text-blue-800 dark:text-blue-200">
        <p className="font-medium">Авто-резолв</p>
        <p>Следующие игровые события (новые матчи с outcomeTeamIds) автоматически перейдут в RESOLVED: watcher каждые 2 мин проверяет PandaScore, определяет победителя по teamId/имени и начисляет выигрыш. 404 → CANCELLED; timeout/429/5xx → retry до 10 раз, затем CANCELLED.</p>
        <p className="mt-2 font-medium">Upcoming и крипто</p>
        <p>Upcoming (киберспорт): discovery запускается при старте бэкенда и каждые 30 мин — создаются рынки по матчам CS2/Dota2/LoL из PandaScore (окно 15 мин–72 ч). Кнопка «Run sync» вызывает тот же discovery.</p>
        <p>Крипто: 3 рынка в день (BTC, ETH, SOL — выше/ниже линии) создаются автоматически каждые 30 мин. Если не видно — проверьте ORACLE_CREATOR_USER_ID; рынки в статусе CANCELLED на главной не показываются.</p>
      </div>
    </div>
  );
}
