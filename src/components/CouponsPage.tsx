import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { CouponItem } from '../types/admin';

function formatRp(n: number) {
  return `Rp${n.toLocaleString('id-ID')}`;
}

export function CouponsPage({ permissions }: { permissions: string[] }) {
  const [coupons, setCoupons] = useState<CouponItem[]>([]);
  const [usages, setUsages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [form, setForm] = useState({
    code: '',
    name: '',
    discountType: 'FIXED' as 'FIXED' | 'PERCENT',
    discountValue: '1000',
    minPurchase: '10000',
    maxDiscount: '',
    claimLimit: '100',
    startsAt: new Date().toISOString().slice(0, 16),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
  });

  async function load() {
    setLoading(true);
    try {
      const res = await api.getCoupons();
      setCoupons(res.data.coupons);
      setUsages(res.data.usages);
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memuat kupon' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) {
      setMessage({ type: 'err', text: 'Kode dan nama kupon wajib diisi.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.createCoupon({
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        minPurchase: Number(form.minPurchase) || 0,
        maxDiscount: form.maxDiscount ? Number(form.maxDiscount) : null,
        claimLimit: form.claimLimit ? Number(form.claimLimit) : null,
        startsAt: new Date(form.startsAt).toISOString(),
        expiresAt: new Date(form.expiresAt).toISOString(),
      });
      setForm({ ...form, code: '', name: '' });
      setMessage({ type: 'ok', text: 'Kupon promo berhasil dibuat.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal membuat kupon' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Kupon & Promo</h2>
        <p className="text-sm text-slate-400">
          Validasi diskon, minimal pembelian, batas klaim, dan masa berlaku dieksekusi atomik di backend.
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

      {permissions.includes('coupons:write') && (
        <form onSubmit={handleCreate} className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label htmlFor="cp-code" className="block text-xs font-medium text-slate-400 mb-1">Kode Kupon</label>
            <input
              id="cp-code"
              type="text"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="PROMO10"
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono uppercase"
            />
          </div>
          <div>
            <label htmlFor="cp-name" className="block text-xs font-medium text-slate-400 mb-1">Nama Promo</label>
            <input
              id="cp-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Diskon Pelanggan"
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
            />
          </div>
          <div>
            <label htmlFor="cp-type" className="block text-xs font-medium text-slate-400 mb-1">Jenis Diskon</label>
            <select
              id="cp-type"
              value={form.discountType}
              onChange={(e) => setForm({ ...form, discountType: e.target.value as 'FIXED' | 'PERCENT' })}
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
            >
              <option value="FIXED">Nominal Tetap (Rp)</option>
              <option value="PERCENT">Persentase (%)</option>
            </select>
          </div>
          <div>
            <label htmlFor="cp-val" className="block text-xs font-medium text-slate-400 mb-1">Nilai Diskon</label>
            <input
              id="cp-val"
              type="number"
              min={1}
              value={form.discountValue}
              onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg font-mono"
            />
          </div>
          <div>
            <label htmlFor="cp-min" className="block text-xs font-medium text-slate-400 mb-1">Minimal Pembelian (Rp)</label>
            <input
              id="cp-min"
              type="number"
              min={0}
              value={form.minPurchase}
              onChange={(e) => setForm({ ...form, minPurchase: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg font-mono"
            />
          </div>
          <div>
            <label htmlFor="cp-max" className="block text-xs font-medium text-slate-400 mb-1">Maksimal Potongan (Rp)</label>
            <input
              id="cp-max"
              type="number"
              min={0}
              value={form.maxDiscount}
              onChange={(e) => setForm({ ...form, maxDiscount: e.target.value })}
              placeholder="Opsional"
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
            />
          </div>
          <div>
            <label htmlFor="cp-limit" className="block text-xs font-medium text-slate-400 mb-1">Batas Klaim</label>
            <input
              id="cp-limit"
              type="number"
              min={1}
              value={form.claimLimit}
              onChange={(e) => setForm({ ...form, claimLimit: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg font-mono"
            />
          </div>
          <div>
            <label htmlFor="cp-exp" className="block text-xs font-medium text-slate-400 mb-1">Berakhir Pada</label>
            <input
              id="cp-exp"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              className="w-full px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg font-mono"
            />
          </div>
          <div className="md:col-span-4 flex justify-end">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Buat Kupon
            </button>
          </div>
        </form>
      )}

      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-2.5 px-4">Kode</th>
                <th className="py-2.5 px-4">Nama</th>
                <th className="py-2.5 px-4">Diskon</th>
                <th className="py-2.5 px-4 text-right">Min. Beli</th>
                <th className="py-2.5 px-4 text-right">Klaim</th>
                <th className="py-2.5 px-4">Kedaluwarsa</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-sm">
              {loading ? (
                <tr><td colSpan={8} className="py-8 text-center text-slate-400">Memuat kupon...</td></tr>
              ) : coupons.length === 0 ? (
                <tr><td colSpan={8} className="py-10 text-center text-slate-400">Belum ada kupon promo.</td></tr>
              ) : (
                coupons.map((c) => (
                  <tr key={c.id} className="hover:bg-[#19243b]">
                    <td className="py-3 px-4 font-mono text-xs font-bold text-[#4b8bff]">{c.code}</td>
                    <td className="py-3 px-4 text-slate-100">{c.name}</td>
                    <td className="py-3 px-4 font-mono text-xs tabular-nums text-slate-300">
                      {c.discount_type === 'FIXED' ? formatRp(c.discount_value) : `${c.discount_value}%`}
                      {c.max_discount ? ` (maks ${formatRp(c.max_discount)})` : ''}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-300">{formatRp(c.min_purchase)}</td>
                    <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-300">
                      {c.claimed_count} / {c.claim_limit ?? '∞'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-400 tabular-nums">
                      {new Date(c.expires_at).toLocaleDateString('id-ID')}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs font-semibold">
                      <span className={c.status === 'ACTIVE' ? 'text-emerald-400' : 'text-slate-500'}>
                        {c.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      {permissions.includes('coupons:write') && (
                        <>
                          <button
                            onClick={() =>
                              void api
                                .updateCoupon(c.id, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })
                                .then(() => load())
                            }
                            className="px-2.5 py-1 text-xs text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer"
                          >
                            {c.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
                          </button>
                          <button
                            onClick={() =>
                              void api
                                .deleteCoupon(c.id)
                                .then(() => load())
                                .catch((e) => setMessage({ type: 'err', text: e.message }))
                            }
                            aria-label={`Hapus kupon ${c.code}`}
                            className="inline-flex items-center px-2 py-1 text-xs text-red-400 border border-red-900/60 rounded-md hover:bg-red-950/50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {usages.length > 0 && (
        <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-100 mb-3">Riwayat Penggunaan Kupon</h3>
          <div className="divide-y divide-[#1e293d] text-xs">
            {usages.slice(0, 15).map((u: any) => (
              <div key={u.id} className="py-2 flex justify-between gap-4">
                <span className="font-mono text-slate-300">
                  {u.code} · {u.customer_code} · {u.transaction_id} · -{formatRp(u.discount_amount)}
                </span>
                <span className="font-mono text-slate-400 tabular-nums">{new Date(u.created_at).toLocaleString('id-ID')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
