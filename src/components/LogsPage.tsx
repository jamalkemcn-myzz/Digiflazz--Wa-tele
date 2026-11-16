import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { PaginationInfo } from '../types/admin';

type LogTab = 'service' | 'transactions' | 'audit';

export function LogsPage() {
  const [tab, setTab] = useState<LogTab>('service');
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('ALL');
  const [items, setItems] = useState<any[]>([]);
  const [recentAudits, setRecentAudits] = useState<any[]>([]);
  const [auditsLoading, setAuditsLoading] = useState(true);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 25, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);

  const loadRecentAudits = useCallback(async () => {
    setAuditsLoading(true);
    try {
      const res = await api.getLogs({ type: 'audit', page: 1, limit: 5 });
      setRecentAudits(res.data.items || []);
    } catch {
      setRecentAudits([]);
    } finally {
      setAuditsLoading(false);
    }
  }, []);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const res = await api.getLogs({
        type: tab,
        page,
        limit: 25,
        search: search.trim() || undefined,
        level: tab === 'service' ? level : undefined,
      });
      setItems(res.data.items);
      setPagination(res.data.pagination);
    } finally {
      setLoading(false);
    }
  }, [tab, search, level]);

  useEffect(() => {
    void load(1);
  }, [load]);

  useEffect(() => {
    void loadRecentAudits();
  }, [loadRecentAudits]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Log Sistem, Transaksi & Audit</h2>
          <p className="text-sm text-slate-400">
            Seluruh log disanitasi otomatis dari API key, password, token, dan Pairing Code.
          </p>
        </div>
        <button
          onClick={() => {
            void load(pagination.page);
            void loadRecentAudits();
          }}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#60a5fa] bg-[#142b59] border border-[#254e9c] rounded-lg hover:bg-[#19356e] cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Log
        </button>
      </div>

      {/* Ringkasan 5 Audit Terbaru dari Database */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1f2b42] bg-[#0f1727] flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-200">
            Aktivitas Admin Terbaru (5 Audit Terakhir)
          </h3>
          <button
            type="button"
            onClick={() => setTab('audit')}
            className="text-xs font-medium text-[#60a5fa] hover:underline cursor-pointer"
          >
            Lihat Semua Audit
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] text-[11px] font-semibold text-slate-400 bg-[#0d1422]">
                <th className="py-2 px-4">Waktu</th>
                <th className="py-2 px-4">Actor</th>
                <th className="py-2 px-4">Aksi</th>
                <th className="py-2 px-4">Target / Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-xs">
              {auditsLoading ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
                    Memuat ringkasan audit...
                  </td>
                </tr>
              ) : recentAudits.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
                    Belum ada aktivitas audit tercatat.
                  </td>
                </tr>
              ) : (
                recentAudits.map((a) => (
                  <tr key={a.id} className="hover:bg-[#19243b]">
                    <td className="py-2 px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {new Date(a.created_at).toLocaleString('id-ID')}
                    </td>
                    <td className="py-2 px-4 font-mono font-semibold text-[#4b8bff] whitespace-nowrap">
                      {a.actor_id} ({a.actor_role})
                    </td>
                    <td className="py-2 px-4 text-slate-100 whitespace-nowrap">{a.action}</td>
                    <td className="py-2 px-4 font-mono text-slate-400 truncate max-w-md">
                      {a.details_safe || a.target_id || a.target_type || '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 bg-[#0f1727] rounded-lg border border-[#1f2b42]">
          {(['service', 'transactions', 'audit'] as LogTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                tab === t ? 'bg-[#1668ff] text-white shadow-xs' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {t === 'service' ? 'Service Logs' : t === 'transactions' ? 'Transaction Logs' : 'Audit Logs'}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          {tab === 'service' && (
            <select
              aria-label="Filter level log"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
            >
              <option value="ALL">Semua Level</option>
              <option value="info">INFO</option>
              <option value="warn">WARN</option>
              <option value="error">ERROR</option>
            </select>
          )}
          <input
            type="text"
            aria-label="Cari log"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari log..."
            className="px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg w-56"
          />
        </div>
      </div>

      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-2.5 px-4">Waktu</th>
                <th className="py-2.5 px-4">{tab === 'audit' ? 'Actor' : tab === 'transactions' ? 'ID Transaksi' : 'Service / Level'}</th>
                <th className="py-2.5 px-4">{tab === 'audit' ? 'Aksi' : tab === 'transactions' ? 'Transisi Status' : 'Pesan'}</th>
                <th className="py-2.5 px-4">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-xs">
              {loading ? (
                <tr><td colSpan={4} className="py-8 text-center text-slate-400">Memuat log...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={4} className="py-8 text-center text-slate-400">Belum ada catatan log.</td></tr>
              ) : (
                items.map((row) => (
                  <tr key={row.id} className="hover:bg-[#19243b]">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString('id-ID')}
                    </td>
                    <td className="py-2.5 px-4 font-mono font-semibold text-[#4b8bff]">
                      {tab === 'audit'
                        ? `${row.actor_id} (${row.actor_role})`
                        : tab === 'transactions'
                        ? row.transaction_id
                        : `${row.service} · ${String(row.level).toUpperCase()}`}
                    </td>
                    <td className="py-2.5 px-4 text-slate-100">
                      {tab === 'audit'
                        ? row.action
                        : tab === 'transactions'
                        ? `${row.old_status || 'START'} → ${row.new_status}`
                        : row.message}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-400 break-all max-w-md">
                      {tab === 'audit'
                        ? row.details_safe || row.target_id || '-'
                        : tab === 'transactions'
                        ? `${row.source}: ${row.description}`
                        : row.details_safe || row.transaction_id || '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-[#1f2b42] flex items-center justify-between text-xs text-slate-400">
          <span className="tabular-nums">
            Halaman {pagination.page} dari {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <button
              disabled={pagination.page <= 1}
              onClick={() => void load(pagination.page - 1)}
              className="px-3 py-1.5 text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md disabled:opacity-40 cursor-pointer"
            >
              Sebelumnya
            </button>
            <button
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => void load(pagination.page + 1)}
              className="px-3 py-1.5 text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md disabled:opacity-40 cursor-pointer"
            >
              Berikutnya
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
