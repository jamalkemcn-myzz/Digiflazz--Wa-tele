import React, { useEffect, useState, useCallback } from 'react';
import { Search, Eye, RefreshCw, X } from 'lucide-react';
import { api } from '../api/client';
import type { PaginationInfo, TransactionItem } from '../types/admin';

function formatRp(n: number) {
  return `Rp${n.toLocaleString('id-ID')}`;
}

function statusTone(status: string): string {
  if (status === 'SUCCESS') return 'text-emerald-400';
  if (['FAILED', 'REFUNDED', 'CANCELLED'].includes(status)) return 'text-red-400';
  if (['EXPIRED', 'UNKNOWN', 'PENDING_PAYMENT', 'SUPPLIER_PENDING', 'PAID_PROCESSING'].includes(status)) {
    return 'text-amber-400';
  }
  return 'text-slate-300';
}

export function TransactionsPage({ permissions }: { permissions: string[] }) {
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [platform, setPlatform] = useState('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTransactions({
        page,
        limit: 20,
        search: search.trim() || undefined,
        status,
        platform,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo ? `${dateTo}T23:59:59.999Z` : undefined,
      });
      setItems(res.data.items);
      setPagination(res.data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat transaksi');
    } finally {
      setLoading(false);
    }
  }, [search, status, platform, dateFrom, dateTo]);

  useEffect(() => {
    void load(1);
  }, [load]);

  async function openDetail(txId: string) {
    setDetailLoading(true);
    setFeedback(null);
    try {
      const res = await api.getTransactionDetail(txId);
      setSelectedDetail(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengambil detail transaksi');
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleReconcile(txId: string) {
    setReconciling(true);
    setFeedback(null);
    try {
      await api.reconcileTransaction(txId);
      setFeedback(`Rekonsiliasi / inquiry untuk ${txId} telah dijalankan.`);
      await openDetail(txId);
      await load(pagination.page);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Rekonsiliasi gagal');
    } finally {
      setReconciling(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Manajemen Transaksi</h2>
          <p className="text-sm text-slate-400">
            Total {pagination.total} transaksi tercatat pada SQLite
          </p>
        </div>
        <button
          onClick={() => void load(pagination.page)}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#60a5fa] bg-[#142b59] border border-[#254e9c] rounded-lg hover:bg-[#19356e] cursor-pointer whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(1);
        }}
        className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-3"
      >
        <div className="md:col-span-2 relative">
          <label htmlFor="tx-search" className="sr-only">Cari transaksi</label>
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            id="tx-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari ID transaksi, kode pelanggan, ref..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1668ff]"
          />
        </div>

        <div>
          <label htmlFor="tx-status" className="sr-only">Filter status</label>
          <select
            id="tx-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
          >
            <option value="ALL">Semua Status</option>
            <option value="PENDING_PAYMENT">PENDING_PAYMENT</option>
            <option value="PAID_PROCESSING">PAID_PROCESSING</option>
            <option value="SUPPLIER_PENDING">SUPPLIER_PENDING</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="FAILED">FAILED</option>
            <option value="EXPIRED">EXPIRED</option>
            <option value="UNKNOWN">UNKNOWN</option>
            <option value="REFUNDED">REFUNDED</option>
          </select>
        </div>

        <div>
          <label htmlFor="tx-platform" className="sr-only">Filter platform</label>
          <select
            id="tx-platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
          >
            <option value="ALL">Semua Platform</option>
            <option value="WHATSAPP">WHATSAPP</option>
            <option value="TELEGRAM">TELEGRAM</option>
            <option value="DASHBOARD">DASHBOARD</option>
          </select>
        </div>

        <div className="flex gap-2">
          <input
            type="date"
            aria-label="Tanggal mulai"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-1/2 px-2 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
          />
          <input
            type="date"
            aria-label="Tanggal akhir"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-1/2 px-2 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
          />
        </div>
      </form>

      {error && (
        <div className="p-4 bg-red-950/50 border border-red-800/60 rounded-lg text-sm text-red-200">{error}</div>
      )}

      {/* Table */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-3 px-4">ID Transaksi</th>
                <th className="py-3 px-4">Pelanggan</th>
                <th className="py-3 px-4">Produk</th>
                <th className="py-3 px-4">Tujuan</th>
                <th className="py-3 px-4 text-right">Total Bayar</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Waktu</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-sm">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={8} className="py-3 px-4">
                      <div className="h-5 bg-[#19243b] rounded animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 px-4 text-center text-sm text-slate-400">
                    Belum ada transaksi yang sesuai filter. Transaksi dari WhatsApp Bot dan Telegram Bot akan tampil di sini secara real-time.
                  </td>
                </tr>
              ) : (
                items.map((tx) => (
                  <tr key={tx.transaction_id} className="hover:bg-[#19243b]">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-[#4b8bff] tabular-nums">
                      {tx.transaction_id}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-400">
                      {tx.customer_code} · {tx.platform}
                    </td>
                    <td className="py-3 px-4 text-slate-100">
                      <div className="font-medium text-sm">{tx.product_name_snapshot}</div>
                      <div className="text-xs font-mono text-slate-400">{tx.product_sku_snapshot}</div>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-300 tabular-nums">
                      {tx.destination_masked}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-slate-100 tabular-nums">
                      {formatRp(tx.payment_amount)}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`font-mono text-xs font-semibold ${statusTone(tx.transaction_status)}`}>
                        {tx.transaction_status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-400 tabular-nums">
                      {new Date(tx.created_at).toLocaleString('id-ID')}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => void openDetail(tx.transaction_id)}
                        aria-label={`Detail transaksi ${tx.transaction_id}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Detail
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
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

      {/* Transaction Detail Modal */}
      {(selectedDetail || detailLoading) && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-label="Detail Transaksi"
            className="bg-[#131c2e] border border-[#26334a] rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-5"
          >
            <div className="flex items-center justify-between border-b border-[#1f2b42] pb-4">
              <div>
                <h3 className="text-lg font-bold text-[#60a5fa] font-mono">
                  {selectedDetail?.transaction?.transaction_id || 'Memuat...'}
                </h3>
                <p className="text-xs text-slate-400">
                  {selectedDetail?.transaction?.customer_code} · {selectedDetail?.transaction?.platform}
                </p>
              </div>
              <button
                onClick={() => setSelectedDetail(null)}
                aria-label="Tutup detail transaksi"
                className="p-2 text-slate-400 hover:text-slate-100 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {feedback && (
              <div className="p-3 rounded-lg bg-[#0f1727] border border-[#1f2b42] text-xs text-slate-200">{feedback}</div>
            )}

            {selectedDetail?.transaction && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-400">Status Transaksi</p>
                    <p className={`font-mono font-semibold ${statusTone(selectedDetail.transaction.transaction_status)}`}>
                      {selectedDetail.transaction.transaction_status}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Status Pembayaran</p>
                    <p className="font-mono font-semibold text-slate-100">{selectedDetail.transaction.payment_status}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Status Supplier</p>
                    <p className="font-mono font-semibold text-slate-100">{selectedDetail.transaction.supplier_status}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Harga Supplier</p>
                    <p className="font-mono tabular-nums text-slate-200">{formatRp(selectedDetail.transaction.supplier_price_snapshot)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Margin</p>
                    <p className="font-mono tabular-nums text-emerald-400">{formatRp(selectedDetail.transaction.margin_snapshot)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Diskon / Kode Unik</p>
                    <p className="font-mono tabular-nums text-slate-200">
                      -{formatRp(selectedDetail.transaction.discount_snapshot)} / +{selectedDetail.transaction.unique_code}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Total Pembayaran</p>
                    <p className="font-mono font-bold tabular-nums text-slate-100">
                      {formatRp(selectedDetail.transaction.payment_amount)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Gateway Ref</p>
                    <p className="font-mono text-xs text-slate-300 break-all">{selectedDetail.transaction.gateway_reference || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Supplier Ref / SN</p>
                    <p className="font-mono text-xs text-slate-300 break-all">
                      {selectedDetail.transaction.supplier_reference || '-'} {selectedDetail.transaction.supplier_sn ? `· ${selectedDetail.transaction.supplier_sn}` : ''}
                    </p>
                  </div>
                </div>

                {permissions.includes('transactions:reconcile') && (
                  <div className="flex items-center justify-between pt-3 border-t border-[#1f2b42]">
                    <span className="text-xs text-slate-400">
                      Kelayakan Refund: {selectedDetail.refundEligibility?.reason || '-'}
                    </span>
                    <button
                      disabled={reconciling}
                      onClick={() => void handleReconcile(selectedDetail.transaction.transaction_id)}
                      className="px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    >
                      {reconciling ? 'Memeriksa...' : 'Inquiry & Rekonsiliasi Manual'}
                    </button>
                  </div>
                )}

                <div>
                  <h4 className="text-xs font-semibold text-slate-300 mb-2">Riwayat Perubahan Status</h4>
                  <div className="border border-[#1f2b42] rounded-lg divide-y divide-[#1e293d] bg-[#0f1727]">
                    {(selectedDetail.history || []).map((h: any) => (
                      <div key={h.id} className="px-3 py-2 text-xs flex flex-wrap justify-between gap-2">
                        <div>
                          <span className="font-mono font-semibold text-slate-100">{h.old_status || 'START'} → {h.new_status}</span>
                          <span className="text-slate-400 ml-2">({h.source})</span>
                          <p className="text-slate-400 mt-0.5">{h.description}</p>
                        </div>
                        <span className="font-mono text-slate-500 tabular-nums">
                          {new Date(h.created_at).toLocaleString('id-ID')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
