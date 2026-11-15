import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { RefundItem, RefundLedgerItem } from '../types/admin';

function formatRp(n: number) {
  return `Rp${n.toLocaleString('id-ID')}`;
}

export function RefundsPage({ permissions }: { permissions: string[] }) {
  const [refunds, setRefunds] = useState<RefundItem[]>([]);
  const [ledger, setLedger] = useState<RefundLedgerItem[]>([]);
  const [customers, setCustomers] = useState<Array<{ id: number; customer_code: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [adjForm, setAdjForm] = useState({
    customerId: '',
    transactionId: '',
    entryType: 'MANUAL_ADJUSTMENT_CREDIT' as 'MANUAL_ADJUSTMENT_CREDIT' | 'MANUAL_ADJUSTMENT_DEBIT',
    amount: '',
    reason: '',
  });

  async function load() {
    setLoading(true);
    try {
      const [refRes, cusRes] = await Promise.all([api.getRefunds(1), api.getCustomers()]);
      setRefunds(refRes.data.refunds.items);
      setLedger(refRes.data.ledger.items);
      setCustomers(cusRes.data);
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memuat data refund' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleAdjust(e: React.FormEvent) {
    e.preventDefault();
    if (!adjForm.customerId || !adjForm.amount || adjForm.reason.trim().length < 5) {
      setMessage({
        type: 'err',
        text: 'Pilih pelanggan, isi nominal positif, dan sertakan alasan minimal 5 karakter.',
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.adjustRefundLedger({
        customerId: Number(adjForm.customerId),
        transactionId: adjForm.transactionId.trim() || null,
        entryType: adjForm.entryType,
        amount: Number(adjForm.amount),
        reason: adjForm.reason.trim(),
      });
      setAdjForm({ ...adjForm, transactionId: '', amount: '', reason: '' });
      setMessage({
        type: 'ok',
        text: `Entri ledger ${res.data.ledgerId} dicatat. Kredit sebelum: ${formatRp(res.data.balanceBefore)}, sesudah: ${formatRp(res.data.balanceAfter)}.`,
      });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Penyesuaian gagal' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Refund Internal & Ledger</h2>
        <p className="text-sm text-slate-400">
          Kredit refund hanya dibuat untuk transaksi terverifikasi PAID yang gagal definitif oleh supplier. Sistem tidak menyediakan fitur deposit atau top-up saldo.
        </p>
      </div>

      {message && (
        <div
          className={`p-3.5 rounded-lg border text-sm ${
            message.type === 'ok'
              ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-200'
              : 'bg-red-950/50 border-red-800/60 text-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {permissions.includes('refunds:adjust') && (
        <form onSubmit={handleAdjust} className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">Penyesuaian Manual Ledger Refund (Khusus Owner)</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label htmlFor="adj-cus" className="block text-xs font-medium text-slate-400 mb-1">Pelanggan</label>
              <select
                id="adj-cus"
                value={adjForm.customerId}
                onChange={(e) => setAdjForm({ ...adjForm, customerId: e.target.value })}
                className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
              >
                <option value="">Pilih pelanggan</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.customer_code}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="adj-type" className="block text-xs font-medium text-slate-400 mb-1">Jenis Entri</label>
              <select
                id="adj-type"
                value={adjForm.entryType}
                onChange={(e) => setAdjForm({ ...adjForm, entryType: e.target.value as any })}
                className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
              >
                <option value="MANUAL_ADJUSTMENT_CREDIT">Kredit Penyesuaian (+)</option>
                <option value="MANUAL_ADJUSTMENT_DEBIT">Debit Penyesuaian (-)</option>
              </select>
            </div>
            <div>
              <label htmlFor="adj-amt" className="block text-xs font-medium text-slate-400 mb-1">Nominal (Rp)</label>
              <input
                id="adj-amt"
                type="number"
                min={1}
                value={adjForm.amount}
                onChange={(e) => setAdjForm({ ...adjForm, amount: e.target.value })}
                className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg font-mono"
              />
            </div>
            <div>
              <label htmlFor="adj-tx" className="block text-xs font-medium text-slate-400 mb-1">ID Transaksi (Opsional)</label>
              <input
                id="adj-tx"
                type="text"
                value={adjForm.transactionId}
                onChange={(e) => setAdjForm({ ...adjForm, transactionId: e.target.value })}
                placeholder="TRX-..."
                className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
              />
            </div>
            <div>
              <label htmlFor="adj-reason" className="block text-xs font-medium text-slate-400 mb-1">Alasan Wajib</label>
              <input
                id="adj-reason"
                type="text"
                value={adjForm.reason}
                onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })}
                placeholder="Koreksi / pencairan manual"
                className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer"
            >
              Catat Penyesuaian Ledger
            </button>
          </div>
        </form>
      )}

      {/* Refund Table */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#1f2b42]">
          <h3 className="text-sm font-semibold text-slate-100">Daftar Refund Transaksi</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-2.5 px-4">ID Transaksi</th>
                <th className="py-2.5 px-4">Pelanggan</th>
                <th className="py-2.5 px-4">Produk</th>
                <th className="py-2.5 px-4 text-right">Nominal Refund</th>
                <th className="py-2.5 px-4">Alasan</th>
                <th className="py-2.5 px-4">Waktu</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-sm">
              {loading ? (
                <tr><td colSpan={6} className="py-6 text-center text-slate-400">Memuat refund...</td></tr>
              ) : refunds.length === 0 ? (
                <tr><td colSpan={6} className="py-8 text-center text-slate-400">Belum ada refund transaksi.</td></tr>
              ) : (
                refunds.map((r) => (
                  <tr key={r.id} className="hover:bg-[#19243b]">
                    <td className="py-3 px-4 font-mono text-xs font-semibold text-[#4b8bff]">{r.transaction_id}</td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-300">{r.customer_code}</td>
                    <td className="py-3 px-4 text-slate-100">{r.product_name_snapshot}</td>
                    <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-emerald-400">
                      {formatRp(r.amount)}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-400">{r.reason}</td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-400 tabular-nums">
                      {new Date(r.processed_at).toLocaleString('id-ID')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Immutable Refund Ledger */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#1f2b42]">
          <h3 className="text-sm font-semibold text-slate-100">Buku Besar Refund (Immutable Append-Only)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-2.5 px-4">Ledger ID</th>
                <th className="py-2.5 px-4">Pelanggan</th>
                <th className="py-2.5 px-4">Tipe Entri</th>
                <th className="py-2.5 px-4 text-right">Nominal</th>
                <th className="py-2.5 px-4">Actor</th>
                <th className="py-2.5 px-4">Keterangan</th>
                <th className="py-2.5 px-4">Waktu</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-sm">
              {ledger.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-slate-400">Ledger masih kosong.</td></tr>
              ) : (
                ledger.map((l) => (
                  <tr key={l.ledger_id} className="hover:bg-[#19243b]">
                    <td className="py-2.5 px-4 font-mono text-xs font-semibold text-[#4b8bff]">{l.ledger_id}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-300">{l.customer_code}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-200">{l.entry_type}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-100">
                      {formatRp(l.amount)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-400">{l.actor_id}</td>
                    <td className="py-2.5 px-4 text-xs text-slate-400">{l.description}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-400 tabular-nums">
                      {new Date(l.created_at).toLocaleString('id-ID')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
