import React, { useEffect, useState } from 'react';
import { RefreshCw, CheckCircle2, AlertCircle, Clock, ShieldAlert } from 'lucide-react';
import { api } from '../api/client';
import type { OverviewData } from '../types/admin';

function formatRp(n: number) {
  return `Rp${n.toLocaleString('id-ID')}`;
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return 'Belum tersedia';
  return new Date(iso).toLocaleString('id-ID');
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getOverview();
      setData(res.data);
      setUpdatedAt(new Date().toLocaleTimeString('id-ID'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat ringkasan');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !data) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 bg-[#131c2e] border border-[#1f2b42] rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-[#131c2e] border border-red-800/60 rounded-lg p-6">
        <p className="text-sm font-medium text-red-400">{error}</p>
        <button
          onClick={() => void load()}
          className="mt-3 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer"
        >
          Muat Ulang
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { metrics, services, config, maintenanceMode } = data;
  const myzzReady = config.readiness.myzzstore.configured && config.readiness.myzzstore.apiSpecConfigured;

  const kpis = [
    { label: 'Transaksi Hari Ini', value: String(metrics.todayCount), sub: 'Pesanan masuk hari ini' },
    { label: 'Transaksi Bulan Ini', value: String(metrics.monthCount), sub: 'Akumulasi bulan berjalan' },
    { label: 'Transaksi Sukses', value: String(metrics.successCount), sub: 'Terpenuhi oleh supplier', tone: 'text-emerald-400' },
    { label: 'Transaksi Pending', value: String(metrics.pendingCount), sub: 'Menunggu pembayaran / supplier', tone: 'text-amber-400' },
    { label: 'Gagal Definitif', value: String(metrics.failedCount), sub: `Termasuk ${metrics.refundCount} refund`, tone: 'text-red-400' },
    { label: 'Invoice Kedaluwarsa', value: String(metrics.expiredCount), sub: 'Melewati batas 5 menit' },
    { label: 'Total Omzet', value: formatRp(metrics.totalRevenue), sub: 'Dari transaksi berstatus SUCCESS', tone: 'text-[#60a5fa]' },
    { label: 'Total Refund Internal', value: formatRp(metrics.totalRefunds), sub: 'Kredit ledger kegagalan definitif' },
  ];

  const statusRows = [
    {
      name: 'Backend Express API',
      ok: services.backend.status === 'UP',
      stateText: services.backend.status,
      detail: `Port ${config.port} · ${config.nodeEnv}`,
    },
    {
      name: 'Database SQLite',
      ok: services.database.status === 'CONNECTED',
      stateText: services.database.status,
      detail: 'Persistent storage (WAL mode)',
    },
    {
      name: 'WhatsApp Bot (Baileys)',
      ok: services.whatsapp.state === 'CONNECTED',
      stateText: services.whatsapp.state,
      detail: services.whatsapp.lastError || (services.whatsapp.hasSavedSession ? 'Sesi persisten tersimpan' : 'Belum dipairing'),
    },
    {
      name: 'Telegram Bot (Telegraf)',
      ok: services.telegram.state === 'CONNECTED',
      stateText: services.telegram.state,
      detail: services.telegram.botUsername
        ? `@${services.telegram.botUsername} (${services.telegram.mode || 'WEBHOOK'})`
        : services.telegram.lastError || 'Nonaktif / token belum diisi',
    },
    {
      name: 'Payment Gateway MyZZStore',
      ok: myzzReady,
      stateText: myzzReady ? 'CONFIGURED' : 'REQUIRES_CONFIG',
      detail: myzzReady
        ? config.readiness.myzzstore.baseUrl
        : `Kurang: ${config.readiness.myzzstore.missingFields.join(', ')}`,
    },
    {
      name: 'Supplier Digiflazz',
      ok: services.digiflazz.configured,
      stateText: services.digiflazz.configured ? 'CONFIGURED' : 'REQUIRES_CONFIG',
      detail: services.digiflazz.configured
        ? config.digiflazz.baseUrl
        : `Kurang: ${config.readiness.digiflazz.missingFields.join(', ')}`,
    },
    {
      name: 'Central Scheduler',
      ok: services.scheduler.running,
      stateText: services.scheduler.running ? 'RUNNING' : 'STOPPED',
      detail: `Poll bayar ${config.scheduler.paymentPollIntervalSeconds}d · supplier ${config.scheduler.supplierPollIntervalSeconds}d`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Ringkasan Operasional</h2>
          <p className="text-sm text-slate-400">
            Pembaruan terakhir: <span className="font-mono tabular-nums">{updatedAt || '-'}</span>
          </p>
        </div>

        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#60a5fa] bg-[#142b59] border border-[#254e9c] rounded-lg hover:bg-[#19356e] disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Segarkan Data
        </button>
      </div>

      {maintenanceMode && (
        <div className="p-4 rounded-lg bg-amber-950/50 border border-amber-800/60 flex items-center gap-3 text-amber-200 text-sm">
          <ShieldAlert className="w-5 h-5 shrink-0 text-amber-400" />
          <div>
            <span className="font-semibold">Maintenance Mode Aktif</span> — Pesanan baru pelanggan sementara diblokir; pembayaran & rekonsiliasi yang sedang berjalan tetap diproses.
          </div>
        </div>
      )}

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((item) => (
          <div key={item.label} className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5">
            <p className="text-xs font-medium text-slate-400">{item.label}</p>
            <p className={`mt-2 text-2xl font-bold tabular-nums font-mono ${item.tone || 'text-slate-100'}`}>
              {item.value}
            </p>
            <p className="mt-1 text-xs text-slate-400">{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Service Health & Sync Timestamps */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1f2b42] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">Status Layanan & Integrasi</h3>
            <span className="text-xs text-slate-400 tabular-nums">
              Antrean notifikasi: {services.notifications.pending ?? 0} pending
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1f2b42] text-xs font-semibold text-slate-400 bg-[#0f1727]">
                  <th className="py-2.5 px-5">Komponen</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-5">Keterangan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e293d] text-sm">
                {statusRows.map((row) => (
                  <tr key={row.name} className="hover:bg-[#19243b]">
                    <td className="py-3 px-5 font-medium text-slate-100">{row.name}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-mono font-semibold ${
                          row.ok ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {row.ok ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5" />
                        )}
                        {row.stateText}
                      </span>
                    </td>
                    <td className="py-3 px-5 text-xs text-slate-400">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5 space-y-5">
          <h3 className="text-sm font-semibold text-slate-100">Jadwal Sinkronisasi & Backup</h3>

          <div className="space-y-1.5 pb-4 border-b border-[#1e293d]">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>Sinkronisasi Harga Digiflazz Terakhir</span>
            </div>
            <p className="text-sm font-mono tabular-nums text-slate-100">
              {metrics.lastPriceSync ? formatTime(metrics.lastPriceSync.completed_at || metrics.lastPriceSync.started_at) : 'Belum pernah dijalankan'}
            </p>
            {metrics.lastPriceSync && (
              <p className="text-xs text-slate-400 tabular-nums">
                Status: {metrics.lastPriceSync.status} · Diperbarui: {metrics.lastPriceSync.success_count} · Gagal: {metrics.lastPriceSync.failure_count}
              </p>
            )}
          </div>

          <div className="space-y-1.5 pb-4 border-b border-[#1e293d]">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>Backup SQLite Terakhir</span>
            </div>
            <p className="text-sm font-mono tabular-nums text-slate-100">
              {metrics.lastBackup ? formatTime(metrics.lastBackup.completed_at || metrics.lastBackup.created_at) : 'Belum pernah dijalankan'}
            </p>
            {metrics.lastBackup && (
              <p className="text-xs text-slate-400 tabular-nums">
                File: {metrics.lastBackup.file_name} ({(metrics.lastBackup.file_size_bytes / 1024).toFixed(1)} KB)
              </p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-400">Pekerjaan Supplier Tertunda</p>
            <p className="text-lg font-mono font-bold tabular-nums text-[#60a5fa]">
              {metrics.pendingSupplierJobs}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
