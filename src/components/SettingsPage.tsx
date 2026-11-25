import React, { useEffect, useState } from 'react';
import { HardDriveDownload, ShieldAlert, UserPlus, RefreshCw, RotateCcw, Plus, X, Activity } from 'lucide-react';
import { api } from '../api/client';

export function SettingsPage({ permissions }: { permissions: string[] }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Admin management & reset state
  const [newAdmin, setNewAdmin] = useState({
    name: '',
    role: 'OPERATOR' as 'OWNER' | 'ADMIN' | 'OPERATOR',
    platform: 'TELEGRAM' as 'TELEGRAM' | 'WHATSAPP' | 'DASHBOARD',
    platformUserId: '',
  });
  const [identityDrafts, setIdentityDrafts] = useState<
    Record<number, { platform: 'TELEGRAM' | 'WHATSAPP' | 'DASHBOARD'; platformUserId: string }>
  >({});
  const [confirmFullReset, setConfirmFullReset] = useState(false);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagProbe, setDiagProbe] = useState<{
    checkedAt: string;
    outboundIp: string | null;
    balanceCheck: { ok: boolean; balance?: number; errorMessage?: string };
  } | null>(null);
  const [confDesc, setConfDesc] = useState('');
  const [confDescBusy, setConfDescBusy] = useState(false);

  const canManageAdmins = permissions.includes('admins:manage');
  const canWriteSettings = permissions.includes('settings:write');

  async function load() {
    setLoading(true);
    try {
      const res = await api.getSettings();
      setData(res.data);
      setConfDesc(res.data.confirmationDescription ?? '');
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memuat pengaturan' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleToggleMaintenance() {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = !data.maintenanceMode;
      await api.setMaintenanceMode(next, reason.trim() || undefined);
      setReason('');
      setMessage({
        type: 'ok',
        text: `Maintenance mode berhasil diubah menjadi ${next ? 'AKTIF' : 'NONAKTIF'}.`,
      });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal mengubah maintenance mode' });
    } finally {
      setBusy(false);
    }
  }

  async function handleManualBackup() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.runBackup();
      setMessage({
        type: 'ok',
        text: `Backup SQLite berhasil: ${res.data.fileName} (${(res.data.sizeBytes / 1024).toFixed(1)} KB)`,
      });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Backup gagal' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRunDigiflazzDiagnostic() {
    setDiagBusy(true);
    setMessage(null);
    try {
      const res = await api.runDigiflazzDiagnostic();
      setDiagProbe({
        checkedAt: res.data.checkedAt,
        outboundIp: res.data.outboundIp,
        balanceCheck: res.data.balanceCheck,
      });
      setData((prev: any) => (prev ? { ...prev, digiflazzDiagnostic: res.data.env } : prev));
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menjalankan diagnostik Digiflazz' });
    } finally {
      setDiagBusy(false);
    }
  }

  async function handleSaveConfirmationDescription(nextValue: string | null) {
    setConfDescBusy(true);
    setMessage(null);
    try {
      const res = await api.setConfirmationDescription(nextValue);
      const saved = res.data.confirmationDescription ?? '';
      setConfDesc(saved);
      setData((prev: any) => (prev ? { ...prev, confirmationDescription: res.data.confirmationDescription } : prev));
      setMessage({
        type: 'ok',
        text: saved ? 'Keterangan konfirmasi pembayaran berhasil disimpan.' : 'Keterangan konfirmasi pembayaran dikosongkan.',
      });
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menyimpan keterangan konfirmasi' });
    } finally {
      setConfDescBusy(false);
    }
  }

  async function handleCreateAdmin(e: React.FormEvent) {
    e.preventDefault();
    if (!newAdmin.name.trim()) {
      setMessage({ type: 'err', text: 'Nama admin wajib diisi.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.createAdmin({
        name: newAdmin.name.trim(),
        role: newAdmin.role,
        platform: newAdmin.platformUserId.trim() ? newAdmin.platform : undefined,
        platformUserId: newAdmin.platformUserId.trim() || undefined,
      });
      setNewAdmin({ name: '', role: 'OPERATOR', platform: 'TELEGRAM', platformUserId: '' });
      setMessage({ type: 'ok', text: 'Admin baru berhasil ditambahkan.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menambahkan admin' });
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateAdmin(adminId: number, role: string, status: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api.updateAdminRole(adminId, role, status);
      setMessage({ type: 'ok', text: 'Role & status admin berhasil diperbarui.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memperbarui admin' });
    } finally {
      setBusy(false);
    }
  }

  async function handleAddIdentity(e: React.FormEvent, adminId: number) {
    e.preventDefault();
    const draft = identityDrafts[adminId] || { platform: 'TELEGRAM', platformUserId: '' };
    if (!draft.platformUserId.trim()) {
      setMessage({ type: 'err', text: 'ID platform admin wajib diisi.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.addAdminIdentity(adminId, draft.platform, draft.platformUserId.trim());
      setIdentityDrafts((prev) => ({
        ...prev,
        [adminId]: { platform: draft.platform, platformUserId: '' },
      }));
      setMessage({ type: 'ok', text: 'Identitas platform admin ditambahkan.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menambah identitas' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveIdentity(adminId: number, identityId: number) {
    setBusy(true);
    setMessage(null);
    try {
      await api.removeAdminIdentity(adminId, identityId);
      setMessage({ type: 'ok', text: 'Identitas admin dihapus.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal menghapus identitas' });
    } finally {
      setBusy(false);
    }
  }

  async function handleResetAdmins(mode: 'SYNC_OWNER_FROM_ENV' | 'RESET_TO_PRIMARY_OWNER') {
    setBusy(true);
    setMessage(null);
    try {
      await api.resetAdmins(mode);
      setConfirmFullReset(false);
      setMessage({
        type: 'ok',
        text:
          mode === 'RESET_TO_PRIMARY_OWNER'
            ? 'Daftar admin berhasil diatur ulang ke Primary Owner berdasarkan .env.'
            : 'Identitas Primary Owner berhasil disinkronkan dari .env.',
      });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal mengatur ulang admin' });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return <div className="p-6 bg-[#131c2e] border border-[#1f2b42] rounded-lg text-sm text-slate-400">Memuat pengaturan...</div>;
  }

  if (!data) return null;

  const cfg = data.config;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Pengaturan Sistem, Maintenance & Backup</h2>
        <p className="text-sm text-slate-400">
          Seluruh kredensial dan secret hanya disimpan pada environment server dan tidak pernah dikirim ke browser.
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

      {/* Maintenance Mode */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-base font-bold text-slate-100">
                Maintenance Mode: {data.maintenanceMode ? 'AKTIF' : 'NONAKTIF'}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Saat aktif, pesanan baru dari WhatsApp & Telegram ditolak dengan pesan informatif. Transaksi pending, callback gateway, supplier, dan refund yang sah tetap diproses.
              </p>
            </div>
          </div>
          {permissions.includes('maintenance:toggle') && (
            <button
              disabled={busy}
              onClick={() => void handleToggleMaintenance()}
              className={`px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
                data.maintenanceMode
                  ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                  : 'bg-amber-600 text-white hover:bg-amber-500'
              }`}
            >
              {data.maintenanceMode ? 'Nonaktifkan Maintenance' : 'Aktifkan Maintenance'}
            </button>
          )}
        </div>
        {permissions.includes('maintenance:toggle') && (
          <div>
            <label htmlFor="maint-reason" className="block text-xs font-medium text-slate-400 mb-1">
              Catatan Audit (Opsional)
            </label>
            <input
              id="maint-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Contoh: Pembaruan jadwal sinkronisasi supplier"
              className="w-full max-w-md px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
            />
          </div>
        )}
      </div>

      {/* Keterangan Konfirmasi Pembayaran (Opsional) */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-6 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Keterangan Konfirmasi Pembayaran (Opsional)</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Catatan global ini ditampilkan pada menu Konfirmasi Pesanan Anda (WhatsApp & Telegram) apabila diisi. Jika kosong, baris catatan dilewati secara otomatis. Anda juga dapat menambahkan keterangan per produk pada menu Katalog.
          </p>
        </div>
        <textarea
          id="confirmation-description"
          rows={3}
          maxLength={500}
          disabled={!canWriteSettings || confDescBusy}
          value={confDesc}
          onChange={(e) => setConfDesc(e.target.value)}
          placeholder="Contoh: Pastikan nomor tujuan aktif dan tidak dalam masa tenggang sebelum membayar."
          className="w-full px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-mono text-slate-500 tabular-nums">{confDesc.length}/500 karakter</span>
          {canWriteSettings && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={confDescBusy}
                onClick={() => void handleSaveConfirmationDescription(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                Kosongkan
              </button>
              <button
                type="button"
                disabled={confDescBusy}
                onClick={() => void handleSaveConfirmationDescription(confDesc.trim() || null)}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                {confDescBusy ? 'Menyimpan...' : 'Simpan Keterangan'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Safe Config Summary */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#1f2b42]">
          <h3 className="text-sm font-semibold text-slate-100">Konfigurasi Runtime Aman (Tanpa Secret)</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#1f2b42] text-xs">
          <div className="p-5 space-y-2.5 min-w-0">
            <p className="font-semibold text-slate-100">Parameter Transaksi & Scheduler</p>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Masa Berlaku Invoice QRIS</span><span className="font-mono text-slate-200 text-right shrink-0">{cfg.transaction.invoiceExpiryMinutes} menit</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Cooldown Gagal/Expired</span><span className="font-mono text-slate-200 text-right shrink-0">{cfg.transaction.cooldownSeconds} detik</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Rentang Kode Unik</span><span className="font-mono text-slate-200 text-right shrink-0">{cfg.transaction.uniqueCodeMin}–{cfg.transaction.uniqueCodeMax}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Polling Pembayaran</span><span className="font-mono text-slate-200 text-right shrink-0">setiap {cfg.scheduler.paymentPollIntervalSeconds} detik</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Polling Supplier</span><span className="font-mono text-slate-200 text-right shrink-0">setiap {cfg.scheduler.supplierPollIntervalSeconds} detik</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Auto Refresh Produk</span><span className="font-mono text-slate-200 text-right shrink-0">{data.productAutoRefresh?.summary || cfg.digiflazz.priceSyncCron}</span></div>
          </div>
          <div className="p-5 space-y-2.5 min-w-0">
            <p className="font-semibold text-slate-100">Kesiapan Integrasi Eksternal</p>
            <div>
              <span className="text-slate-400">MyZZStore Gateway ({cfg.readiness.myzzstore.baseUrl}):</span>
              <p className="font-mono mt-0.5 text-slate-200 break-words">
                {cfg.readiness.myzzstore.configured && cfg.readiness.myzzstore.apiSpecConfigured
                  ? 'SIAP PRODUKSI'
                  : `Menunggu .env / spesifikasi endpoint: ${cfg.readiness.myzzstore.missingFields.join(', ')}`}
              </p>
            </div>
            <div>
              <span className="text-slate-400">Digiflazz ({cfg.readiness.digiflazz.baseUrl}):</span>
              <p className="font-mono mt-0.5 text-slate-200 break-words">
                {cfg.readiness.digiflazz.configured
                  ? 'SIAP PRODUKSI'
                  : `Menunggu .env: ${cfg.readiness.digiflazz.missingFields.join(', ')}`}
              </p>
            </div>
            <div>
              <span className="text-slate-400">Webhook Digiflazz (Real-Time Update):</span>
              <p className="font-mono mt-0.5 text-[#60a5fa] break-all">
                {cfg.digiflazz?.webhookUrl || `${window.location.origin}/api/webhooks/digiflazz`}
              </p>
              <p className={`text-[11px] font-mono mt-0.5 ${cfg.digiflazz?.webhookConfigured ? 'text-emerald-400' : 'text-amber-400'}`}>
                {cfg.digiflazz?.webhookConfigured
                  ? 'DIGIFLAZZ_WEBHOOK_SECRET: TERPASANG (X-Hub-Signature aktif)'
                  : 'DIGIFLAZZ_WEBHOOK_SECRET belum diisi di .env (wajib disamakan dengan Secret Key di Digiflazz)'}
              </p>
            </div>
            <div className="flex justify-between gap-2"><span className="text-slate-400">Auto Backup Cron</span><span className="font-mono text-slate-200 text-right">{cfg.backup.cron} ({cfg.backup.retentionDays} hari)</span></div>
          </div>
        </div>
      </div>

      {/* Digiflazz Safe Diagnostic */}
      {data.digiflazzDiagnostic && (
        <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1f2b42] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Diagnostik Aman Digiflazz (Tanpa Secret)</h3>
              <p className="text-xs text-slate-400">
                Memeriksa nilai yang benar-benar terbaca oleh server dari <code className="font-mono text-[#60a5fa]">.env</code> / environment container serta IP keluar server.
              </p>
            </div>
            <button
              type="button"
              disabled={diagBusy}
              onClick={() => void handleRunDigiflazzDiagnostic()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <Activity className="w-3.5 h-3.5" />
              {diagBusy ? 'Menguji...' : 'Uji Koneksi & Cek IP Keluar'}
            </button>
          </div>

          <div className="p-5 space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-slate-400">Username API Terbaca</p>
                <p className="font-mono font-semibold text-slate-100 mt-1">
                  {data.digiflazzDiagnostic.usernameMasked}{' '}
                  <span className="text-slate-400 font-normal">({data.digiflazzDiagnostic.usernameLength} char)</span>
                </p>
              </div>
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-slate-400">Mode & Panjang API Key</p>
                <p
                  className={`font-mono font-semibold mt-1 ${
                    data.digiflazzDiagnostic.apiKeyMode === 'PRODUCTION'
                      ? 'text-emerald-400'
                      : data.digiflazzDiagnostic.apiKeyMode === 'DEVELOPMENT'
                        ? 'text-amber-400'
                        : 'text-red-400'
                  }`}
                >
                  {data.digiflazzDiagnostic.apiKeyMode}{' '}
                  <span className="text-slate-400 font-normal">({data.digiflazzDiagnostic.apiKeyLength} char)</span>
                </p>
              </div>
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-slate-400">Sumber Konfigurasi</p>
                <p className="font-mono font-semibold text-slate-100 mt-1">
                  {data.digiflazzDiagnostic.envFileExists ? '.env ditemukan' : '.env tidak ada'}
                  {data.digiflazzDiagnostic.overriddenByContainerEnv ? ' (Tertimpa Env Panel!)' : ''}
                </p>
              </div>
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-slate-400">IP Publik Keluar Server</p>
                <p className="font-mono font-semibold text-[#60a5fa] mt-1">
                  {diagProbe ? diagProbe.outboundIp || 'Gagal deteksi IP' : 'Klik Uji Koneksi'}
                </p>
              </div>
            </div>

            {data.digiflazzDiagnostic.warnings.length > 0 && (
              <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-lg space-y-1.5">
                <p className="font-semibold text-amber-300">Peringatan Terdeteksi:</p>
                <ul className="list-disc pl-5 space-y-1 text-amber-200">
                  {data.digiflazzDiagnostic.warnings.map((w: string, idx: number) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {diagProbe && (
              <div
                className={`p-3.5 rounded-lg border ${
                  diagProbe.balanceCheck.ok
                    ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-200'
                    : 'bg-red-950/40 border-red-800/60 text-red-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    Hasil Uji Endpoint /cek-saldo:{' '}
                    {diagProbe.balanceCheck.ok
                      ? `BERHASIL (Saldo: Rp ${Number(diagProbe.balanceCheck.balance || 0).toLocaleString('id-ID')})`
                      : `GAGAL — ${diagProbe.balanceCheck.errorMessage || 'Tidak diketahui'}`}
                  </span>
                  <span className="font-mono text-[11px] opacity-80">
                    {new Date(diagProbe.checkedAt).toLocaleString('id-ID')}
                  </span>
                </div>
                {!diagProbe.balanceCheck.ok && diagProbe.balanceCheck.errorMessage?.includes('RC 41') && (
                  <p className="mt-2 text-xs text-red-200/90">
                    Tip RC 41: Cocokkan apakah IP keluar <code className="font-mono">{diagProbe.outboundIp || 'server'}</code> terdaftar di kolom <strong>IP Production</strong> atau <strong>IP Development</strong> pada Digiflazz. Jika terdaftar di IP Production, API Key wajib menggunakan <strong>Production Key</strong> (bukan <code className="font-mono">dev-...</code>), dan pastikan tidak terpotong karakter <code className="font-mono">#</code> tanpa kutip di <code className="font-mono">.env</code>.
                  </p>
                )}
                {!diagProbe.balanceCheck.ok && diagProbe.balanceCheck.errorMessage?.includes('RC 45') && (
                  <p className="mt-2 text-xs text-red-200/90">
                    Tip RC 45: Daftarkan IP keluar <code className="font-mono">{diagProbe.outboundIp || 'server'}</code> pada whitelist IP di dashboard Digiflazz (Atur Koneksi → API).
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Backup Management */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#1f2b42] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Backup Database SQLite</h3>
            <p className="text-xs text-slate-400">Menggunakan SQLite Online Backup API (konsisten saat ada penulisan aktif).</p>
          </div>
          {permissions.includes('backups:manage') && (
            <button
              disabled={busy}
              onClick={() => void handleManualBackup()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <HardDriveDownload className="w-3.5 h-3.5" />
              Buat Backup Sekarang
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1f2b42] bg-[#0f1727] text-xs font-semibold text-slate-400">
                <th className="py-2.5 px-4">Nama File</th>
                <th className="py-2.5 px-4 text-right">Ukuran</th>
                <th className="py-2.5 px-4">Waktu Dibuat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e293d] text-xs">
              {(data.backupFiles || []).length === 0 ? (
                <tr><td colSpan={3} className="py-6 text-center text-slate-400">Belum ada file backup tersimpan.</td></tr>
              ) : (
                data.backupFiles.map((b: any) => (
                  <tr key={b.fileName} className="hover:bg-[#19243b]">
                    <td className="py-2.5 px-4 font-mono text-[#4b8bff]">{b.fileName}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-300">{(b.sizeBytes / 1024).toFixed(1)} KB</td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400">{new Date(b.createdAt).toLocaleString('id-ID')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Admins Management & Reset */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#1f2b42] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Manajemen & Atur Ulang Admin</h3>
            <p className="text-xs text-slate-400">
              Kelola role RBAC, tautkan ID WhatsApp/Telegram untuk perintah bot admin, atau sinkronkan ulang Owner dari <code className="font-mono text-[#60a5fa]">.env</code>.
            </p>
          </div>
          {canManageAdmins && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleResetAdmins('SYNC_OWNER_FROM_ENV')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#60a5fa] bg-[#142b59] border border-[#254e9c] rounded-lg hover:bg-[#19356e] disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Sinkronkan Owner dari .env
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmFullReset((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-400 border border-red-900/60 rounded-lg hover:bg-red-950/50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Atur Ulang Admin
              </button>
            </div>
          )}
        </div>

        {confirmFullReset && canManageAdmins && (
          <div className="px-5 py-4 bg-red-950/50 border-b border-red-800/60 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-red-200">
              <strong>Konfirmasi Atur Ulang Penuh:</strong> Tindakan ini menghapus semua admin tambahan & identitas lama lalu membangun ulang <strong>Primary Owner</strong> sesuai <code className="font-mono">DASHBOARD_AUTH_USER</code>, <code className="font-mono">OWNER_WHATSAPP_JID</code>, dan <code className="font-mono">OWNER_TELEGRAM_ID</code> pada server.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleResetAdmins('RESET_TO_PRIMARY_OWNER')}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-500 cursor-pointer whitespace-nowrap"
              >
                Ya, Reset ke Primary Owner
              </button>
              <button
                type="button"
                onClick={() => setConfirmFullReset(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
              >
                Batal
              </button>
            </div>
          </div>
        )}

        {canManageAdmins && (
          <form onSubmit={handleCreateAdmin} className="p-5 border-b border-[#1f2b42] bg-[#0f1727] grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div>
              <label htmlFor="new-admin-name" className="block text-xs font-medium text-slate-400 mb-1">Nama Admin Baru</label>
              <input
                id="new-admin-name"
                type="text"
                value={newAdmin.name}
                onChange={(e) => setNewAdmin({ ...newAdmin, name: e.target.value })}
                placeholder="Operator Shift Pagi"
                className="w-full px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="new-admin-role" className="block text-xs font-medium text-slate-400 mb-1">Role</label>
              <select
                id="new-admin-role"
                value={newAdmin.role}
                onChange={(e) => setNewAdmin({ ...newAdmin, role: e.target.value as 'OWNER' | 'ADMIN' | 'OPERATOR' })}
                className="w-full px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
              >
                <option value="OPERATOR">OPERATOR</option>
                <option value="ADMIN">ADMIN</option>
                <option value="OWNER">OWNER</option>
              </select>
            </div>
            <div>
              <label htmlFor="new-admin-platform" className="block text-xs font-medium text-slate-400 mb-1">Platform Awal</label>
              <select
                id="new-admin-platform"
                value={newAdmin.platform}
                onChange={(e) => setNewAdmin({ ...newAdmin, platform: e.target.value as 'TELEGRAM' | 'WHATSAPP' | 'DASHBOARD' })}
                className="w-full px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-lg"
              >
                <option value="TELEGRAM">TELEGRAM (User ID)</option>
                <option value="WHATSAPP">WHATSAPP (628...)</option>
                <option value="DASHBOARD">DASHBOARD</option>
              </select>
            </div>
            <div>
              <label htmlFor="new-admin-pid" className="block text-xs font-medium text-slate-400 mb-1">ID Platform (Opsional)</label>
              <input
                id="new-admin-pid"
                type="text"
                value={newAdmin.platformUserId}
                onChange={(e) => setNewAdmin({ ...newAdmin, platformUserId: e.target.value })}
                placeholder={newAdmin.platform === 'TELEGRAM' ? '123456789' : '6281234567890'}
                className="w-full px-3 py-2 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Tambah Admin
            </button>
          </form>
        )}

        <div className="divide-y divide-[#1e293d]">
          {(data.admins || []).map((a: any) => {
            const draft = identityDrafts[a.id] || { platform: 'TELEGRAM', platformUserId: '' };
            return (
              <div key={a.id} className="p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-100">{a.name}</span>
                      <span className="font-mono text-[11px] font-semibold text-[#4b8bff]">#{a.id}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Role: <span className="font-mono font-semibold text-slate-200">{a.role}</span> · Status:{' '}
                      <span className={`font-mono font-semibold ${a.status === 'ACTIVE' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {a.status}
                      </span>
                    </p>
                  </div>

                  {canManageAdmins && (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`Ubah role ${a.name}`}
                        value={a.role}
                        disabled={busy}
                        onChange={(e) => void handleUpdateAdmin(a.id, e.target.value, a.status)}
                        className="px-2.5 py-1.5 text-xs font-mono bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-md"
                      >
                        <option value="OWNER">OWNER</option>
                        <option value="ADMIN">ADMIN</option>
                        <option value="OPERATOR">OPERATOR</option>
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUpdateAdmin(a.id, a.role, a.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
                        className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                      >
                        {a.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Identities */}
                <div className="flex flex-wrap items-center gap-2">
                  {(a.identities || []).length === 0 ? (
                    <span className="text-xs text-slate-500">Belum ada identitas platform tertaut.</span>
                  ) : (
                    (a.identities || []).map((i: any) => (
                      <span
                        key={i.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono bg-[#192233] text-slate-200 border border-[#2a3852] rounded-md"
                      >
                        <span>{i.platform}:{i.platform_user_id}</span>
                        {canManageAdmins && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRemoveIdentity(a.id, i.id)}
                            aria-label={`Hapus identitas ${i.platform} ${i.platform_user_id}`}
                            className="text-slate-400 hover:text-red-400 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    ))
                  )}
                </div>

                {canManageAdmins && (
                  <form onSubmit={(e) => void handleAddIdentity(e, a.id)} className="flex flex-wrap items-center gap-2 pt-1">
                    <select
                      aria-label={`Platform identitas baru untuk ${a.name}`}
                      value={draft.platform}
                      onChange={(e) =>
                        setIdentityDrafts((prev) => ({
                          ...prev,
                          [a.id]: { ...draft, platform: e.target.value as 'TELEGRAM' | 'WHATSAPP' | 'DASHBOARD' },
                        }))
                      }
                      className="px-2.5 py-1.5 text-xs bg-[#0d1422] border border-[#28354e] text-slate-100 rounded-md"
                    >
                      <option value="TELEGRAM">TELEGRAM</option>
                      <option value="WHATSAPP">WHATSAPP</option>
                      <option value="DASHBOARD">DASHBOARD</option>
                    </select>
                    <input
                      type="text"
                      aria-label={`ID platform baru untuk ${a.name}`}
                      value={draft.platformUserId}
                      onChange={(e) =>
                        setIdentityDrafts((prev) => ({
                          ...prev,
                          [a.id]: { ...draft, platformUserId: e.target.value },
                        }))
                      }
                      placeholder={draft.platform === 'TELEGRAM' ? 'User ID numerik (123456789)' : draft.platform === 'WHATSAPP' ? '6281234567890' : 'username dashboard'}
                      className="flex-1 min-w-[180px] max-w-xs px-3 py-1.5 text-xs font-mono bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-md"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#192233] border border-[#2a3852] rounded-md hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
                    >
                      <Plus className="w-3 h-3" />
                      Tautkan Identitas
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
