import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Search, Users } from 'lucide-react';
import { api } from '../api/client';
import type { CustomerUserItem, PaginationInfo } from '../types/admin';

function formatRp(n: number) {
  return `Rp${n.toLocaleString('id-ID')}`;
}

export function CustomersPage() {
  const [users, setUsers] = useState<CustomerUserItem[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 25, total: 0, totalPages: 1 });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getUsers({
        page,
        limit: 25,
        search: search.trim() || undefined,
      });
      setUsers(res.data.items);
      setPagination(res.data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar pengguna');
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Daftar Pengguna</h2>
          <p className="text-sm text-slate-400">
            Pelanggan terdaftar dari bot WhatsApp & Telegram beserta total transaksi dan saldo kredit refund.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Muat Ulang
        </button>
      </div>

      {error && (
        <div className="p-3.5 rounded-lg bg-red-950/50 border border-red-800/60 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="p-4 border-b border-[#1f2b42] flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              aria-label="Cari pengguna"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Cari kode pelanggan, ID Telegram, no WA, username..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
            />
          </div>
          <div className="inline-flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <Users className="w-4 h-4 text-[#4b8bff]" />
            <span>{pagination.total} pengguna terdaftar</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-2.5 px-4">Kode Pelanggan</th>
                <th className="py-2.5 px-4">Identitas Platform</th>
                <th className="py-2.5 px-4 text-right">Total Transaksi</th>
                <th className="py-2.5 px-4 text-right">Total Belanja Sukses</th>
                <th className="py-2.5 px-4 text-right">Saldo Refund</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Terdaftar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-sm">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 px-4 text-center text-slate-400">
                    Memuat daftar pengguna...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 px-4 text-center text-slate-400">
                    Belum ada pengguna pelanggan tercatat.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="hover:bg-[#19243b]">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-[#4b8bff] whitespace-nowrap">
                      {u.customer_code}
                    </td>
                    <td className="py-3 px-4">
                      {u.identities.length === 0 ? (
                        <span className="text-xs text-slate-500">-</span>
                      ) : (
                        <div className="space-y-1">
                          {u.identities.map((idn) => (
                            <div key={idn.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                              <span
                                className={`px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold ${
                                  idn.platform === 'WHATSAPP'
                                    ? 'bg-emerald-950/70 border border-emerald-800/60 text-emerald-300'
                                    : idn.platform === 'TELEGRAM'
                                    ? 'bg-sky-950/70 border border-sky-800/60 text-sky-300'
                                    : 'bg-slate-800 border border-slate-700 text-slate-300'
                                }`}
                              >
                                {idn.platform}
                              </span>
                              <span className="font-mono text-slate-200">{idn.platform_user_id}</span>
                              {idn.platform_username && (
                                <span className="text-slate-400">({idn.platform_username})</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                      <span>{u.total_transactions}</span>
                      <span className="text-xs text-emerald-400 ml-1">({u.success_transactions} sukses)</span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-100 whitespace-nowrap">
                      {formatRp(u.total_spent)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-300 whitespace-nowrap">
                      {formatRp(u.refund_balance)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs font-semibold">
                      <span className={u.status === 'ACTIVE' ? 'text-emerald-400' : 'text-red-400'}>
                        {u.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-400 whitespace-nowrap">
                      <div>{new Date(u.created_at).toLocaleDateString('id-ID')}</div>
                      {u.last_transaction_at && (
                        <div className="text-[11px] text-slate-500">
                          Order: {new Date(u.last_transaction_at).toLocaleDateString('id-ID')}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-[#1f2b42] flex items-center justify-between text-xs text-slate-400">
          <span>
            Halaman {pagination.page} dari {pagination.totalPages} ({pagination.total} pengguna)
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 bg-[#192233] border border-[#2a3852] text-slate-200 rounded-md hover:bg-[#232e42] disabled:opacity-40 cursor-pointer"
            >
              Sebelumnya
            </button>
            <button
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 bg-[#192233] border border-[#2a3852] text-slate-200 rounded-md hover:bg-[#232e42] disabled:opacity-40 cursor-pointer"
            >
              Berikutnya
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
