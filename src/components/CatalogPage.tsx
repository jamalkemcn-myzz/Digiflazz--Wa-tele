import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, Pencil, X } from 'lucide-react';
import { api } from '../api/client';
import type { CategoryItem, ProductItem } from '../types/admin';

type SubTab = 'products' | 'categories' | 'margins';

function formatRp(n: number) {
  return `Rp${n.toLocaleString('id-ID')}`;
}

function sanitizeNumericInput(raw: string, allowDecimal = false): string {
  let cleaned = allowDecimal ? raw.replace(/[^\d.]/g, '') : raw.replace(/\D/g, '');
  if (allowDecimal) {
    const firstDot = cleaned.indexOf('.');
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
    }
  }
  // Normalize leading zeros like "030" -> "30" while keeping "0" or "0.xxx"
  cleaned = cleaned.replace(/^0+(?=\d)/, '');
  return cleaned;
}

export function CatalogPage({ initialTab = 'products', permissions }: { initialTab?: SubTab; permissions: string[] }) {
  const [tab, setTab] = useState<SubTab>(initialTab);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [globalMarginType, setGlobalMarginType] = useState<'FIXED' | 'PERCENT'>('FIXED');
  const [globalMarginValueStr, setGlobalMarginValueStr] = useState('1000');
  const [globalMaxMarginStr, setGlobalMaxMarginStr] = useState('');
  const [marginHistory, setMarginHistory] = useState<any[]>([]);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Forms (numeric fields stored as sanitized strings to avoid leading-zero input glitches like "030")
  const [newCatName, setNewCatName] = useState('');
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [confirmDeleteProductId, setConfirmDeleteProductId] = useState<number | null>(null);
  const [newProd, setNewProd] = useState({
    sku: '',
    name: '',
    categoryId: '',
    supplierPrice: '',
    marginType: '' as '' | 'FIXED' | 'PERCENT',
    marginValue: '',
    maxMargin: '',
  });
  const [editingCategoryMargin, setEditingCategoryMargin] = useState<{
    id: number;
    name: string;
    marginType: '' | 'FIXED' | 'PERCENT';
    marginValue: string;
    maxMargin: string;
  } | null>(null);
  const [previewCost, setPreviewCost] = useState('20000');

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [prodRes, catRes, marginRes, syncRes] = await Promise.all([
        api.getProducts({ page: 1, limit: 50, search: search.trim() || undefined }),
        api.getCategories(),
        api.getMargins(),
        api.getSyncLogs(),
      ]);
      setProducts(prodRes.data.items);
      setCategories(catRes.data);
      const gm = marginRes.data.globalMargin;
      setGlobalMarginType(gm.type === 'PERCENT' ? 'PERCENT' : 'FIXED');
      setGlobalMarginValueStr(String(gm.value ?? 1000));
      setGlobalMaxMarginStr(gm.maxMargin !== null && gm.maxMargin !== undefined ? String(gm.maxMargin) : '');
      setMarginHistory(marginRes.data.history);
      setSyncLogs(syncRes.data);
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memuat katalog' });
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function handleSyncDigiflazz() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.syncDigiflazz();
      setMessage({
        type: 'ok',
        text: `Sinkronisasi selesai: ${res.data.successCount} produk diperbarui, ${res.data.deletedCount ?? 0} tidak tersedia dihapus, ${res.data.failureCount} gagal.`,
      });
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Sinkronisasi Digiflazz gagal' });
    } finally {
      setBusy(false);
    }
  }

  function startEditProduct(p: ProductItem) {
    setEditingSku(p.sku);
    setNewProd({
      sku: p.sku,
      name: p.name,
      categoryId: p.category_id ? String(p.category_id) : '',
      supplierPrice: String(p.supplier_price),
      marginType: p.margin_type ?? '',
      marginValue: p.margin_value !== null ? String(p.margin_value) : '',
      maxMargin: p.max_margin !== null && p.max_margin !== undefined ? String(p.max_margin) : '',
    });
    setMessage(null);
  }

  function resetProductForm() {
    setEditingSku(null);
    setNewProd({ sku: '', name: '', categoryId: '', supplierPrice: '', marginType: '', marginValue: '', maxMargin: '' });
  }

  async function handleSaveProduct(e: React.FormEvent) {
    e.preventDefault();
    if (!newProd.sku.trim() || !newProd.name.trim() || !newProd.supplierPrice) {
      setMessage({ type: 'err', text: 'SKU, nama produk, dan harga supplier wajib diisi.' });
      return;
    }
    if (newProd.marginType && newProd.marginValue === '') {
      setMessage({ type: 'err', text: 'Nilai override margin produk wajib diisi jika jenis margin dipilih.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.saveProduct({
        sku: newProd.sku.trim(),
        name: newProd.name.trim(),
        categoryId: newProd.categoryId ? Number(newProd.categoryId) : null,
        supplierPrice: Number(newProd.supplierPrice),
        marginType: newProd.marginType || null,
        marginValue: newProd.marginType && newProd.marginValue !== '' ? Number(newProd.marginValue) : null,
        maxMargin: newProd.marginType === 'PERCENT' && newProd.maxMargin !== '' ? Number(newProd.maxMargin) : null,
      });
      resetProductForm();
      setMessage({ type: 'ok', text: editingSku ? 'Produk berhasil diperbarui.' : 'Produk berhasil disimpan.' });
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menyimpan produk' });
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleProduct(p: ProductItem) {
    setBusy(true);
    try {
      await api.toggleProductStatus(p.id, p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE');
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal mengubah status produk' });
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProduct(p: ProductItem) {
    setBusy(true);
    setMessage(null);
    try {
      await api.deleteProduct(p.id);
      setConfirmDeleteProductId(null);
      if (editingSku === p.sku) {
        resetProductForm();
      }
      setMessage({ type: 'ok', text: `Produk ${p.name} (${p.sku}) berhasil dihapus.` });
      await loadAll();
    } catch (err) {
      setConfirmDeleteProductId(null);
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menghapus produk' });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newCatName.trim()) {
      setMessage({ type: 'err', text: 'Nama kategori wajib diisi.' });
      return;
    }
    setBusy(true);
    try {
      await api.createCategory({ name: newCatName.trim() });
      setNewCatName('');
      setMessage({ type: 'ok', text: 'Kategori berhasil ditambahkan.' });
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menambah kategori' });
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteCategory(c: CategoryItem) {
    setBusy(true);
    setMessage(null);
    try {
      await api.deleteCategory(c.id);
      setMessage({ type: 'ok', text: `Kategori ${c.name} dihapus.` });
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menghapus kategori' });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCategoryMargin(e: React.FormEvent) {
    e.preventDefault();
    if (!editingCategoryMargin) return;
    if (editingCategoryMargin.marginType && editingCategoryMargin.marginValue === '') {
      setMessage({ type: 'err', text: 'Masukkan nilai margin kategori.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const mType = editingCategoryMargin.marginType || null;
      const mVal = mType ? Number(editingCategoryMargin.marginValue) : null;
      const mMax = mType === 'PERCENT' && editingCategoryMargin.maxMargin !== '' ? Number(editingCategoryMargin.maxMargin) : null;
      const res = await api.setCategoryMargin(editingCategoryMargin.id, mType, mVal, mMax);
      setMessage({
        type: 'ok',
        text: `Margin kategori ${editingCategoryMargin.name} diperbarui (${res.data.updatedProducts} produk dihitung ulang).`,
      });
      setEditingCategoryMargin(null);
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menyimpan margin kategori' });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveGlobalMargin(e: React.FormEvent) {
    e.preventDefault();
    if (globalMarginValueStr.trim() === '') {
      setMessage({ type: 'err', text: 'Nilai margin global wajib diisi.' });
      return;
    }
    const parsedVal = Number(globalMarginValueStr);
    const parsedMax =
      globalMarginType === 'PERCENT' && globalMaxMarginStr.trim() !== '' ? Number(globalMaxMarginStr) : null;
    if (!Number.isFinite(parsedVal) || parsedVal < 0) {
      setMessage({ type: 'err', text: 'Nilai margin global tidak valid.' });
      return;
    }
    if (parsedMax !== null && (!Number.isFinite(parsedMax) || parsedMax < 0)) {
      setMessage({ type: 'err', text: 'Nilai maksimal margin tidak valid.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.setGlobalMargin(globalMarginType, parsedVal, parsedMax);
      setMessage({
        type: 'ok',
        text: `Margin global diperbarui (${res.data.updatedProducts} produk dihitung ulang untuk transaksi baru).`,
      });
      await loadAll();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menyimpan margin global' });
    } finally {
      setBusy(false);
    }
  }

  const parsedPreviewCost = Math.max(0, Number(previewCost) || 0);
  const parsedGmVal = Math.max(0, Number(globalMarginValueStr) || 0);
  const parsedGmMax =
    globalMarginType === 'PERCENT' && globalMaxMarginStr.trim() !== ''
      ? Math.max(0, Math.round(Number(globalMaxMarginStr) || 0))
      : null;

  const rawPreviewMarginAmt =
    globalMarginType === 'FIXED'
      ? Math.round(parsedGmVal)
      : Math.ceil((parsedPreviewCost * parsedGmVal) / 100);
  const isPreviewCapped = parsedGmMax !== null && rawPreviewMarginAmt > parsedGmMax;
  const previewMarginAmt = isPreviewCapped ? parsedGmMax! : rawPreviewMarginAmt;
  const previewSelling = parsedPreviewCost + previewMarginAmt;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Katalog Produk, Kategori & Margin</h2>
          <p className="text-sm text-slate-400">
            Prioritas margin: Produk → Kategori → Global. Perubahan margin hanya berlaku untuk transaksi baru.
          </p>
        </div>
        {permissions.includes('products:write') && (
          <button
            onClick={() => void handleSyncDigiflazz()}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            Sinkronisasi Harga Digiflazz
          </button>
        )}
      </div>

      {/* Sub-navigation segmented buttons */}
      <div className="inline-flex flex-wrap max-w-full items-center gap-1 p-1 bg-[#0f1727] rounded-lg border border-[#1f2b42]">
        {(['products', 'categories', 'margins'] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              tab === t ? 'bg-[#1668ff] text-white shadow-xs' : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            {t === 'products' ? 'Daftar Produk' : t === 'categories' ? 'Kategori' : 'Pengaturan Margin'}
          </button>
        ))}
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

      {tab === 'products' && (
        <div className="space-y-5">
          {permissions.includes('products:write') && (
            <form onSubmit={handleSaveProduct} className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  {editingSku ? `Edit Produk (${editingSku})` : 'Tambah / Perbarui Produk'}
                </span>
                {editingSku && (
                  <button
                    type="button"
                    onClick={resetProductForm}
                    className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-100 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                    Batal Edit
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                <div>
                  <label htmlFor="prod-sku" className="block text-xs font-medium text-slate-400 mb-1">SKU Digiflazz</label>
                  <input
                    id="prod-sku"
                    type="text"
                    value={newProd.sku}
                    readOnly={Boolean(editingSku)}
                    onChange={(e) => setNewProd({ ...newProd, sku: e.target.value })}
                    placeholder="TSEL10"
                    className={`w-full px-3 py-2 text-sm border border-[#28354e] rounded-lg font-mono placeholder:text-slate-500 ${
                      editingSku ? 'bg-[#192233] text-slate-400' : 'bg-[#0d1422] text-slate-100'
                    }`}
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="prod-name" className="block text-xs font-medium text-slate-400 mb-1">Nama Produk</label>
                  <input
                    id="prod-name"
                    type="text"
                    value={newProd.name}
                    onChange={(e) => setNewProd({ ...newProd, name: e.target.value })}
                    placeholder="Pulsa Telkomsel 10.000"
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="prod-cat" className="block text-xs font-medium text-slate-400 mb-1">Kategori</label>
                  <select
                    id="prod-cat"
                    value={newProd.categoryId}
                    onChange={(e) => setNewProd({ ...newProd, categoryId: e.target.value })}
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
                  >
                    <option value="">Pilih kategori</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="prod-cost" className="block text-xs font-medium text-slate-400 mb-1">Harga Supplier (Rp)</label>
                  <input
                    id="prod-cost"
                    type="text"
                    inputMode="numeric"
                    value={newProd.supplierPrice}
                    onChange={(e) => setNewProd({ ...newProd, supplierPrice: sanitizeNumericInput(e.target.value, false) })}
                    placeholder="10200"
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  {editingSku ? 'Perbarui Produk' : 'Simpan Produk'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <div>
                  <label htmlFor="prod-margin-type" className="block text-xs font-medium text-slate-400 mb-1">
                    Override Margin Produk
                  </label>
                  <select
                    id="prod-margin-type"
                    value={newProd.marginType}
                    onChange={(e) => {
                      const nextType = e.target.value as '' | 'FIXED' | 'PERCENT';
                      setNewProd({
                        ...newProd,
                        marginType: nextType,
                        marginValue: nextType === '' ? '' : newProd.marginValue,
                        maxMargin: nextType === 'PERCENT' ? newProd.maxMargin : '',
                      });
                    }}
                    className="w-full px-3 py-1.5 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
                  >
                    <option value="">Ikuti Kategori / Global</option>
                    <option value="FIXED">Nominal Tetap (Rp)</option>
                    <option value="PERCENT">Persentase (%)</option>
                  </select>
                </div>
                {newProd.marginType && (
                  <div>
                    <label htmlFor="prod-margin-val" className="block text-xs font-medium text-slate-400 mb-1">
                      {newProd.marginType === 'PERCENT' ? 'Nilai Margin (%)' : 'Nilai Margin (Rp)'}
                    </label>
                    <input
                      id="prod-margin-val"
                      type="text"
                      inputMode="decimal"
                      value={newProd.marginValue}
                      onChange={(e) =>
                        setNewProd({
                          ...newProd,
                          marginValue: sanitizeNumericInput(e.target.value, newProd.marginType === 'PERCENT'),
                        })
                      }
                      placeholder={newProd.marginType === 'FIXED' ? '1500' : '30'}
                      className="w-full px-3 py-1.5 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                    />
                  </div>
                )}
                {newProd.marginType === 'PERCENT' && (
                  <div>
                    <label htmlFor="prod-margin-max" className="block text-xs font-medium text-slate-400 mb-1">
                      Maksimal Margin (Rp, Opsional)
                    </label>
                    <input
                      id="prod-margin-max"
                      type="text"
                      inputMode="numeric"
                      value={newProd.maxMargin}
                      onChange={(e) =>
                        setNewProd({
                          ...newProd,
                          maxMargin: sanitizeNumericInput(e.target.value, false),
                        })
                      }
                      placeholder="3000 (opsional)"
                      className="w-full px-3 py-1.5 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                    />
                  </div>
                )}
              </div>
            </form>
          )}

          <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
            <div className="p-4 border-b border-[#1f2b42] flex flex-wrap items-center justify-between gap-3">
              <input
                type="text"
                aria-label="Cari produk"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari SKU atau nama produk..."
                className="w-full max-w-sm px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
              />
              <span className="text-xs text-slate-400 tabular-nums">{products.length} produk ditampilkan</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                    <th className="py-2.5 px-4">SKU</th>
                    <th className="py-2.5 px-4">Nama Produk</th>
                    <th className="py-2.5 px-4">Kategori</th>
                    <th className="py-2.5 px-4 text-right">Harga Supplier</th>
                    <th className="py-2.5 px-4 text-right">Margin</th>
                    <th className="py-2.5 px-4 text-right">Harga Jual</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e293d] text-sm">
                  {loading ? (
                    <tr><td colSpan={8} className="py-8 px-4 text-center text-slate-400">Memuat produk...</td></tr>
                  ) : products.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 px-4 text-center text-slate-400">
                        Belum ada produk. Jalankan Sinkronisasi Digiflazz atau tambahkan produk di atas.
                      </td>
                    </tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p.id} className="hover:bg-[#19243b]">
                        <td className="py-3 px-4 font-mono text-xs font-semibold text-[#4b8bff]">{p.sku}</td>
                        <td className="py-3 px-4 font-medium text-slate-100">
                          <div>{p.name}</div>
                          {p.margin_type && p.margin_value !== null && (
                            <div className="text-[11px] font-mono text-slate-400">
                              Override: {p.margin_type} ({p.margin_value}{p.margin_type === 'PERCENT' ? '%' : ''}{p.max_margin ? `, maks ${formatRp(p.max_margin)}` : ''})
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-400">{p.category_name || '-'}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">{formatRp(p.supplier_price)}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-400">
                          {formatRp(p.selling_price - p.supplier_price)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-100">
                          {formatRp(p.selling_price)}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs font-semibold">
                          <span className={p.status === 'ACTIVE' ? 'text-emerald-400' : 'text-slate-500'}>
                            {p.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {permissions.includes('products:write') && (
                            <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                              <button
                                onClick={() => startEditProduct(p)}
                                aria-label={`Edit produk ${p.sku}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                              >
                                <Pencil className="w-3 h-3" />
                                Edit
                              </button>
                              <button
                                onClick={() => void handleToggleProduct(p)}
                                className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                              >
                                {p.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
                              </button>
                              {confirmDeleteProductId === p.id ? (
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleDeleteProduct(p)}
                                    aria-label={`Konfirmasi hapus produk ${p.sku}`}
                                    className="px-2.5 py-1 text-xs font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                                  >
                                    Konfirmasi
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setConfirmDeleteProductId(null)}
                                    className="px-2 py-1 text-xs text-slate-300 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                                  >
                                    Batal
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setConfirmDeleteProductId(p.id)}
                                  aria-label={`Hapus produk ${p.sku}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-red-400 border border-red-900/60 rounded-md hover:bg-red-950/50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  Hapus
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {syncLogs.length > 0 && (
            <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-4">
              <h3 className="text-sm font-semibold text-slate-100 mb-3">Riwayat Sinkronisasi Digiflazz</h3>
              <div className="divide-y divide-[#1e293d] text-xs">
                {syncLogs.slice(0, 5).map((l: any) => (
                  <div key={l.id} className="py-2 flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-slate-200">{l.status} · Sukses: {l.success_count} · Gagal: {l.failure_count}</span>
                    <span className="font-mono text-slate-400 tabular-nums">{new Date(l.started_at).toLocaleString('id-ID')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'categories' && (
        <div className="space-y-5">
          {permissions.includes('categories:write') && (
            <form onSubmit={handleCreateCategory} className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-4 flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="cat-name" className="block text-xs font-medium text-slate-400 mb-1">Nama Kategori Baru</label>
                <input
                  id="cat-name"
                  type="text"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="Contoh: Voucher Game"
                  className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer whitespace-nowrap"
              >
                Tambah Kategori
              </button>
            </form>
          )}

          {editingCategoryMargin && permissions.includes('margins:write') && (
            <form onSubmit={handleSaveCategoryMargin} className="bg-[#131c2e] border border-[#2a3852] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-100">
                  Atur Override Margin Kategori: {editingCategoryMargin.name}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingCategoryMargin(null)}
                  className="text-xs text-slate-400 hover:text-slate-100 cursor-pointer"
                >
                  Tutup
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                <div>
                  <label htmlFor="cat-margin-type" className="block text-xs font-medium text-slate-400 mb-1">Jenis Margin</label>
                  <select
                    id="cat-margin-type"
                    value={editingCategoryMargin.marginType}
                    onChange={(e) => {
                      const nextType = e.target.value as '' | 'FIXED' | 'PERCENT';
                      setEditingCategoryMargin({
                        ...editingCategoryMargin,
                        marginType: nextType,
                        marginValue: nextType === '' ? '' : editingCategoryMargin.marginValue,
                        maxMargin: nextType === 'PERCENT' ? editingCategoryMargin.maxMargin : '',
                      });
                    }}
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
                  >
                    <option value="">Ikuti Margin Global</option>
                    <option value="FIXED">Nominal Tetap (Rp)</option>
                    <option value="PERCENT">Persentase (%)</option>
                  </select>
                </div>
                {editingCategoryMargin.marginType && (
                  <div>
                    <label htmlFor="cat-margin-val" className="block text-xs font-medium text-slate-400 mb-1">
                      {editingCategoryMargin.marginType === 'PERCENT' ? 'Nilai Margin (%)' : 'Nilai Margin (Rp)'}
                    </label>
                    <input
                      id="cat-margin-val"
                      type="text"
                      inputMode="decimal"
                      value={editingCategoryMargin.marginValue}
                      onChange={(e) =>
                        setEditingCategoryMargin({
                          ...editingCategoryMargin,
                          marginValue: sanitizeNumericInput(
                            e.target.value,
                            editingCategoryMargin.marginType === 'PERCENT'
                          ),
                        })
                      }
                      placeholder={editingCategoryMargin.marginType === 'PERCENT' ? '30' : '1500'}
                      className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                    />
                  </div>
                )}
                {editingCategoryMargin.marginType === 'PERCENT' && (
                  <div>
                    <label htmlFor="cat-margin-max" className="block text-xs font-medium text-slate-400 mb-1">
                      Maksimal Margin (Rp, Opsional)
                    </label>
                    <input
                      id="cat-margin-max"
                      type="text"
                      inputMode="numeric"
                      value={editingCategoryMargin.maxMargin}
                      onChange={(e) =>
                        setEditingCategoryMargin({
                          ...editingCategoryMargin,
                          maxMargin: sanitizeNumericInput(e.target.value, false),
                        })
                      }
                      placeholder="3000 (opsional)"
                      className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                    />
                  </div>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer whitespace-nowrap"
                >
                  Simpan Margin Kategori
                </button>
              </div>
            </form>
          )}

          <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                    <th className="py-2.5 px-4">Nama Kategori</th>
                    <th className="py-2.5 px-4">Margin Kategori</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e293d] text-sm">
                  {categories.map((c) => (
                    <tr key={c.id} className="hover:bg-[#19243b]">
                      <td className="py-3 px-4 font-medium text-slate-100">{c.name}</td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-300">
                        {c.margin_type && c.margin_value !== null
                          ? `${c.margin_type} (${c.margin_value}${c.margin_type === 'PERCENT' ? '%' : ''}${c.max_margin ? `, maks ${formatRp(c.max_margin)}` : ''})`
                          : 'Ikuti Margin Global'}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs font-semibold">
                        <span className={c.status === 'ACTIVE' ? 'text-emerald-400' : 'text-slate-500'}>
                          {c.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex items-center gap-2">
                          {permissions.includes('margins:write') && (
                            <button
                              onClick={() =>
                                setEditingCategoryMargin({
                                  id: c.id,
                                  name: c.name,
                                  marginType: c.margin_type ?? '',
                                  marginValue: c.margin_value !== null ? String(c.margin_value) : '',
                                  maxMargin: c.max_margin !== null && c.max_margin !== undefined ? String(c.max_margin) : '',
                                })
                              }
                              className="px-2.5 py-1 text-xs text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                            >
                              Atur Margin
                            </button>
                          )}
                          {permissions.includes('categories:write') && (
                            <>
                              <button
                                onClick={() =>
                                  void api
                                    .updateCategory(c.id, { status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })
                                    .then(() => loadAll())
                                }
                                className="px-2.5 py-1 text-xs text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                              >
                                {c.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
                              </button>
                              <button
                                onClick={() => void handleDeleteCategory(c)}
                                aria-label={`Hapus kategori ${c.name}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-red-400 border border-red-900/60 rounded-md hover:bg-red-950/50 cursor-pointer whitespace-nowrap"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Hapus
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'margins' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <form onSubmit={handleSaveGlobalMargin} className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5 space-y-4">
              <h3 className="text-sm font-semibold text-slate-100">Margin Global Default</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="gm-type" className="block text-xs font-medium text-slate-400 mb-1">Jenis Margin</label>
                  <select
                    id="gm-type"
                    value={globalMarginType}
                    onChange={(e) => {
                      const nextType = e.target.value as 'FIXED' | 'PERCENT';
                      setGlobalMarginType(nextType);
                      if (nextType === 'FIXED') setGlobalMaxMarginStr('');
                    }}
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
                  >
                    <option value="FIXED">Nominal Tetap (Rp)</option>
                    <option value="PERCENT">Persentase (%)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="gm-val" className="block text-xs font-medium text-slate-400 mb-1">
                    {globalMarginType === 'PERCENT' ? 'Nilai Margin (%)' : 'Nilai Margin (Rp)'}
                  </label>
                  <input
                    id="gm-val"
                    type="text"
                    inputMode="decimal"
                    value={globalMarginValueStr}
                    onChange={(e) =>
                      setGlobalMarginValueStr(
                        sanitizeNumericInput(e.target.value, globalMarginType === 'PERCENT')
                      )
                    }
                    placeholder={globalMarginType === 'PERCENT' ? 'Contoh: 30' : 'Contoh: 1000'}
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                  />
                </div>
              </div>

              {globalMarginType === 'PERCENT' && (
                <div>
                  <label htmlFor="gm-max" className="block text-xs font-medium text-slate-400 mb-1">
                    Maksimal Margin (Rp, Opsional)
                  </label>
                  <input
                    id="gm-max"
                    type="text"
                    inputMode="numeric"
                    value={globalMaxMarginStr}
                    onChange={(e) => setGlobalMaxMarginStr(sanitizeNumericInput(e.target.value, false))}
                    placeholder="Contoh: 3000 — kosongkan jika tanpa batas maksimal"
                    className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    Jika diisi (misal 30% maks Rp3.000), keuntungan per transaksi tidak akan melebihi batas ini.
                  </p>
                </div>
              )}

              <div className="p-3.5 rounded-lg bg-[#0f1727] border border-[#1f2b42] space-y-2">
                <label htmlFor="preview-cost" className="block text-xs font-medium text-slate-400">
                  Simulasi Harga Jual (Masukkan Harga Supplier)
                </label>
                <input
                  id="preview-cost"
                  type="text"
                  inputMode="numeric"
                  value={previewCost}
                  onChange={(e) => setPreviewCost(sanitizeNumericInput(e.target.value, false))}
                  className="w-full px-3 py-1.5 text-sm bg-[#0b111e] border border-[#28354e] text-slate-100 rounded-md font-mono"
                />
                <p className="text-xs font-mono tabular-nums text-slate-300">
                  {formatRp(parsedPreviewCost)} + {formatRp(previewMarginAmt)}{' '}
                  {isPreviewCapped && (
                    <span className="text-amber-400">(dibatasi maks {formatRp(parsedGmMax!)}) </span>
                  )}
                  = <strong className="text-[#60a5fa]">{formatRp(previewSelling)}</strong>
                </p>
              </div>

              {permissions.includes('margins:write') && (
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer"
                >
                  Simpan Margin Global
                </button>
              )}
            </form>

            <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5">
              <h3 className="text-sm font-semibold text-slate-100 mb-3">Riwayat Perubahan Margin</h3>
              {marginHistory.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada perubahan margin tercatat.</p>
              ) : (
                <div className="divide-y divide-[#1e293d] text-xs max-h-80 overflow-y-auto">
                  {marginHistory.map((h: any) => (
                    <div key={h.id} className="py-2.5 flex justify-between gap-3">
                      <div>
                        <span className="font-semibold text-slate-100">{h.scope_type} ({h.scope_id})</span>
                        <p className="font-mono text-slate-300">
                          {h.old_margin_type || '-'} {h.old_margin_value ?? ''}
                          {h.old_max_margin ? ` (maks ${formatRp(h.old_max_margin)})` : ''} →{' '}
                          {h.new_margin_type || 'RESET'} {h.new_margin_value ?? ''}
                          {h.new_max_margin ? ` (maks ${formatRp(h.new_max_margin)})` : ''}
                        </p>
                      </div>
                      <div className="text-right text-slate-400 font-mono tabular-nums">
                        <div>{h.actor_id}</div>
                        <div>{new Date(h.created_at).toLocaleString('id-ID')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
