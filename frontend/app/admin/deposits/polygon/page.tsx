'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminAPI } from '@/lib/api';
import { format } from 'date-fns';

type PolygonDeposit = {
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
};

export default function AdminPolygonDepositsPage() {
  const [rows, setRows] = useState<PolygonDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleResult, setCycleResult] = useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);
  const [creditTxHash, setCreditTxHash] = useState('');
  const [creditAddress, setCreditAddress] = useState('');
  const [creditAmount, setCreditAmount] = useState('1.02');
  const [creditRunning, setCreditRunning] = useState(false);
  const [creditResult, setCreditResult] = useState<string | null>(null);
  const [creditByTxHash, setCreditByTxHash] = useState('');
  const [creditByTxRunning, setCreditByTxRunning] = useState(false);
  const [creditByTxResult, setCreditByTxResult] = useState<string | null>(null);
  const [creditAndSweepRunning, setCreditAndSweepRunning] = useState(false);
  const [creditAndSweepResult, setCreditAndSweepResult] = useState<string | null>(null);
  const [sweepDetails, setSweepDetails] = useState<Array<{ address: string; amount: number; txId: string; success: boolean; error?: string }>>([]);

  const load = () => {
    setLoading(true);
    adminAPI
      .getDepositsPolygon()
      .then((res) => setRows(res.data ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const runCycle = () => {
    setCycleRunning(true);
    setCycleResult(null);
    adminAPI
      .runPolygonUsdtCycle()
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setCycleResult(
            `Detected: ${d.detected}, Confirmed: ${d.confirmed}, Credited: ${d.credited}${d.swept != null ? `, Swept: ${d.swept}` : ''}${d.failed ? `, Failed: ${d.failed}` : ''}${d.errors?.length ? `. Errors: ${d.errors.length}` : ''}`
          );
          load();
        }
      })
      .catch(() => setCycleResult('Failed to run cycle'))
      .finally(() => setCycleRunning(false));
  };

  const runSweep = () => {
    setSweepRunning(true);
    setSweepResult(null);
    setSweepDetails([]);
    adminAPI
      .sweepPolygonUsdtToMaster()
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setSweepDetails(d.results ?? []);
          const succeeded = d.results?.filter((r) => r.success).length ?? 0;
          setSweepResult(
            d.message
              ? d.message
              : d.sweptCount > 0
                ? `Забрано с ${d.sweptCount} адресов. Успешно: ${succeeded}.`
                : d.results?.length
                  ? `Адресов проверено: ${d.results.length}. Забрано: 0. См. причины ниже.`
                  : 'Забрано: 0 адресов. См. причины ниже или запустите Run cycle.'
          );
          load();
        }
      })
      .catch(() => setSweepResult('Sweep failed'))
      .finally(() => setSweepRunning(false));
  };

  const runManualCredit = () => {
    const txHash = creditTxHash.trim();
    const depositAddress = creditAddress.trim();
    const amountUsd = parseFloat(creditAmount);
    if (!txHash || !depositAddress || Number.isNaN(amountUsd) || amountUsd <= 0) {
      setCreditResult('Укажите tx hash, адрес депозита и сумму (USD).');
      return;
    }
    setCreditRunning(true);
    setCreditResult(null);
    adminAPI
      .creditPolygonDeposit({ txHash, depositAddress, amountUsd })
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setCreditResult(d.credited ? 'Депозит зачислен пользователю.' : 'Депозит уже был зачислен ранее.');
          load();
        } else {
          setCreditResult(d?.error ?? 'Ошибка');
        }
      })
      .catch((err) => {
        const msg = err.response?.data?.error ?? err.message ?? 'Ошибка запроса';
        setCreditResult(String(msg));
      })
      .finally(() => setCreditRunning(false));
  };

  const runCreditByTxHash = () => {
    const txHash = creditByTxHash.trim();
    if (!txHash) {
      setCreditByTxResult('Вставьте tx hash (ссылку или только хеш).');
      return;
    }
    const hashOnly = txHash.replace(/^https:\/\/polygonscan\.com\/tx\//i, '').trim();
    const hex = hashOnly.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    const normalized = hex.length === 64 ? '0x' + hex.toLowerCase() : hashOnly.startsWith('0x') ? hashOnly : '0x' + hashOnly;
    if (hex.length !== 64) {
      setCreditByTxResult('Неверный tx hash: нужны 64 hex-символа. Уберите лишние символы (например ; в конце).');
      return;
    }
    setCreditByTxRunning(true);
    setCreditByTxResult(null);
    adminAPI
      .creditPolygonDepositByTxHash(normalized)
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          if (d.alreadyCredited) {
            setCreditByTxResult(`Уже зачислено ранее. Адрес: ${d.depositAddress?.slice(0, 10)}…, сумма: $${d.amountUsd ?? '?'}`);
          } else {
            setCreditByTxResult(`Зачислено $${d.amountUsd ?? '?'} на адрес ${d.depositAddress?.slice(0, 10)}…`);
          }
          load();
        } else {
          setCreditByTxResult(d?.error ?? 'Ошибка');
        }
      })
      .catch((err) => {
        setCreditByTxResult(err.response?.data?.error ?? err.message ?? 'Ошибка запроса');
      })
      .finally(() => setCreditByTxRunning(false));
  };

  const runCreditAndSweep = () => {
    const txHash = creditByTxHash.trim();
    if (!txHash) {
      setCreditAndSweepResult('Вставьте tx hash входящего перевода (Polygonscan → адрес → ERC-20 Transfers).');
      return;
    }
    const hashOnly = txHash.replace(/^https:\/\/polygonscan\.com\/tx\//i, '').trim();
    const hex = hashOnly.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    const normalized = hex.length === 64 ? '0x' + hex.toLowerCase() : hashOnly.startsWith('0x') ? hashOnly : '0x' + hashOnly;
    if (hex.length !== 64) {
      setCreditAndSweepResult('Неверный tx hash: должен быть 64 hex-символа (0x...). Уберите лишние символы, например точку с запятой.');
      return;
    }
    setCreditAndSweepRunning(true);
    setCreditAndSweepResult(null);
    setSweepDetails([]);
    adminAPI
      .creditAndSweepPolygon(normalized)
      .then((res) => {
        const d = res.data;
        if (d?.ok) {
          setSweepDetails(d.results ?? []);
          const swept = d.sweptCount ?? 0;
          setCreditAndSweepResult(
            swept > 0
              ? `Зачислено и забрано на мастер с ${swept} адреса(ов).`
              : d.message ?? (d.results?.length ? 'Забрано: 0. См. причины ниже.' : 'Готово.')
          );
          load();
        } else {
          setCreditAndSweepResult(d?.error ?? 'Ошибка');
        }
      })
      .catch((err) => {
        setCreditAndSweepResult(err.response?.data?.error ?? err.message ?? 'Ошибка запроса');
      })
      .finally(() => setCreditAndSweepRunning(false));
  };

  if (loading && rows.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <Link href="/admin/deposits" className="text-primary-600 hover:underline text-sm">
          ← All deposits
        </Link>
        <Link href="/admin/deposits/polygon-hashes" className="text-primary-600 hover:underline text-sm ml-2">
          Users hash Polygon
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Polygon USDT deposits</h1>
        <button
          type="button"
          onClick={runCycle}
          disabled={cycleRunning}
          className="ml-auto px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50"
        >
          {cycleRunning ? 'Running…' : 'Run Polygon USDT cycle'}
        </button>
        <button
          type="button"
          onClick={runSweep}
          disabled={sweepRunning}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
        >
          {sweepRunning ? 'Running…' : 'Sweep all Polygon USDT to Master'}
        </button>
      </div>
      {cycleResult && <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">{cycleResult}</p>}
      {sweepResult && (
        <div className="mb-3">
          <p className="text-sm text-violet-700 dark:text-violet-400">{sweepResult}</p>
          {sweepDetails.length > 0 && (
            <ul className="mt-2 text-xs text-gray-600 dark:text-gray-400 space-y-1">
              {sweepDetails.map((r, i) => (
                <li key={i} className="font-mono">
                  {r.address.slice(0, 10)}… — {r.success ? `OK, ${r.amount.toFixed(2)} USDT, tx: ${r.txId?.slice(0, 16)}…` : r.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Detects incoming USDT (ERC-20) to deposit addresses, credits after confirmation. Min $1. Sweep sends USDT from deposit wallets to master (uses MASTER_ADDRESS_POLYGON / key).
      </p>

      <div className="mb-6 p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
        <h2 className="text-sm font-semibold text-green-800 dark:text-green-200 mb-2">Зачислить по tx hash (только ссылка или хеш)</h2>
        <p className="text-xs text-green-700 dark:text-green-300 mb-3">
          Вставьте ссылку PolygonScan или только tx hash — адрес и сумма подставятся из блокчейна. Получатель должен быть нашим депозитным адресом (MATIC).
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <span className="text-xs text-gray-600 dark:text-gray-400">Tx hash или ссылка</span>
            <input
              type="text"
              value={creditByTxHash}
              onChange={(e) => setCreditByTxHash(e.target.value)}
              placeholder="0x001d2a84ba8ed0bb6f27ff..."
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-secondary text-sm font-mono"
            />
          </label>
          <button
            type="button"
            onClick={runCreditByTxHash}
            disabled={creditByTxRunning}
            className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-500 disabled:opacity-50"
          >
            {creditByTxRunning ? 'Проверяю…' : 'Зачислить по tx'}
          </button>
          <button
            type="button"
            onClick={runCreditAndSweep}
            disabled={creditAndSweepRunning || creditByTxRunning}
            className="px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
            title="Зачислить по tx → отправить POL на адрес → забрать токен на мастер. Может занять 1–2 минуты."
          >
            {creditAndSweepRunning ? 'Зачисляю и забираю… (1–2 мин)' : 'Зачислить и забрать на мастер'}
          </button>
        </div>
        {creditByTxResult && <p className="mt-2 text-sm text-green-800 dark:text-green-200">{creditByTxResult}</p>}
        {creditAndSweepResult && <p className="mt-2 text-sm text-emerald-800 dark:text-emerald-200">{creditAndSweepResult}</p>}
        {sweepDetails.length > 0 && creditAndSweepResult && (
          <ul className="mt-2 text-xs text-gray-600 dark:text-gray-400 space-y-1">
            {sweepDetails.map((r, i) => (
              <li key={i} className="font-mono">
                {r.address.slice(0, 10)}… — {r.success ? `OK, ${r.amount.toFixed(2)}, tx: ${r.txId?.slice(0, 16)}…` : r.error}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-6 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
        <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-200 mb-2">Зачислить депозит вручную (tx + адрес + сумма)</h2>
        <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">
          Если транзакция есть в PolygonScan, но после «Run cycle» депозит не появился — укажите данные из эксплорера и нажмите кнопку. Адрес должен быть в списке кошельков (MATIC).
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">Tx hash</span>
            <input
              type="text"
              value={creditTxHash}
              onChange={(e) => setCreditTxHash(e.target.value)}
              placeholder="0xb58e9f2ec320f9cd..."
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-secondary text-sm font-mono min-w-[280px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">Адрес депозита (получатель)</span>
            <input
              type="text"
              value={creditAddress}
              onChange={(e) => setCreditAddress(e.target.value)}
              placeholder="0xA4191B65dC404BE36f4..."
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-secondary text-sm font-mono min-w-[280px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600 dark:text-gray-400">Сумма (USD)</span>
            <input
              type="text"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
              placeholder="1.02"
              className="px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-dark-secondary text-sm w-24"
            />
          </label>
          <button
            type="button"
            onClick={runManualCredit}
            disabled={creditRunning}
            className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-500 disabled:opacity-50"
          >
            {creditRunning ? 'Зачисляю…' : 'Зачислить депозит'}
          </button>
        </div>
        {creditResult && <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">{creditResult}</p>}
      </div>

      <div className="bg-white dark:bg-dark-card rounded-lg shadow overflow-x-auto border border-transparent dark:border-[rgba(255,255,255,0.08)]">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-dark-secondary">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">User</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Tx hash</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Address</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Amount</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 text-sm">{r.user?.username ?? r.userId}</td>
                <td className="px-4 py-2 font-mono text-xs truncate max-w-[120px]" title={r.txHash}>
                  {r.txHash.slice(0, 12)}…
                </td>
                <td className="px-4 py-2 font-mono text-xs truncate max-w-[100px]" title={r.depositAddress}>
                  {r.depositAddress.slice(0, 8)}…
                </td>
                <td className="px-4 py-2">${r.amountUsd.toFixed(2)}</td>
                <td className="px-4 py-2 text-sm">{r.status}</td>
                <td className="px-4 py-2 text-sm text-gray-500">{format(new Date(r.createdAt), 'PPp')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-gray-500">No Polygon deposits.</p>}
      </div>
    </div>
  );
}
