import React, { useEffect, useState } from 'react';
import { RefreshCw, Smartphone, Send } from 'lucide-react';
import { api } from '../api/client';

export function BotsPage({ permissions }: { permissions: string[] }) {
  const [status, setStatus] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await api.getBotsStatus();
      setStatus(res.data);
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal memuat status bot' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleGeneratePairing(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim()) {
      setMessage({ type: 'err', text: 'Masukkan nomor WhatsApp target (format 628... atau 08...).' });
      return;
    }
    setBusy(true);
    setMessage(null);
    setPairingCode(null);
    try {
      const res = await api.generateWaPairingCode(phone.trim());
      setPairingCode(res.data.pairingCode);
      setMessage({ type: 'ok', text: 'Pairing Code berhasil dibuat. Masukkan kode di perangkat WhatsApp Anda.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal membuat Pairing Code' });
    } finally {
      setBusy(false);
    }
  }

  async function handleReconnectWa(resetSession = false) {
    setBusy(true);
    setMessage(null);
    try {
      await api.reconnectWhatsapp(resetSession);
      setMessage({
        type: 'ok',
        text: resetSession ? 'Sesi WhatsApp direset dan socket disambungkan ulang.' : 'Reconnect WhatsApp dipicu.',
      });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal reconnect WhatsApp' });
    } finally {
      setBusy(false);
    }
  }

  async function handleReconnectTg() {
    setBusy(true);
    setMessage(null);
    try {
      await api.reconnectTelegram();
      setMessage({ type: 'ok', text: 'Bot Telegram disambungkan ulang.' });
      await load();
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : 'Gagal reconnect Telegram' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Manajemen Bot WhatsApp & Telegram</h2>
          <p className="text-sm text-slate-400">
            Pairing Code hanya ditampilkan kepada Owner/Admin berizin dan tidak pernah dicatat di log atau dikirim ke pelanggan.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#60a5fa] bg-[#142b59] border border-[#254e9c] rounded-lg hover:bg-[#19356e] cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Segarkan Status
        </button>
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

      {status && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* WhatsApp Card */}
          <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#1668ff] text-white flex items-center justify-center">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">WhatsApp Bot (Baileys)</h3>
                  <p className="text-xs font-mono text-slate-400">
                    State: {status.whatsapp.state} · Sesi tersimpan: {status.whatsapp.hasSavedSession ? 'Ya' : 'Tidak'}
                  </p>
                </div>
              </div>
            </div>

            {status.whatsapp.lastError && (
              <div className="p-3 rounded-lg bg-amber-950/50 border border-amber-800/60 text-xs text-amber-200">
                {status.whatsapp.lastError}
              </div>
            )}

            {permissions.includes('bots:pairing') && (
              <form onSubmit={handleGeneratePairing} className="space-y-3 pt-2 border-t border-[#1e293d]">
                <label htmlFor="wa-phone" className="block text-xs font-semibold text-slate-300">
                  Buat Pairing Code WhatsApp
                </label>
                <div className="flex gap-2">
                  <input
                    id="wa-phone"
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Contoh: 6281234567890"
                    className="flex-1 px-3 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
                  />
                  <button
                    type="submit"
                    disabled={busy || !status.whatsapp.enabled}
                    className="px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    Generate Pairing Code
                  </button>
                </div>
                {!status.whatsapp.enabled && (
                  <p className="text-xs text-slate-400">
                    Aktifkan <code className="font-mono text-[#60a5fa]">WHATSAPP_ENABLED=true</code> di <code className="font-mono text-[#60a5fa]">.env</code> untuk menghubungkan WhatsApp.
                  </p>
                )}
              </form>
            )}

            {pairingCode && (
              <div className="p-4 rounded-lg bg-[#0d1422] border border-[#28354e] text-white text-center space-y-1">
                <p className="text-xs text-slate-400">Pairing Code WhatsApp Anda (Rahasia)</p>
                <p className="text-2xl font-mono font-bold tracking-widest tabular-nums text-[#60a5fa]">{pairingCode}</p>
              </div>
            )}

            {permissions.includes('bots:manage') && (
              <div className="flex flex-wrap gap-2 pt-2 border-t border-[#1e293d]">
                <button
                  disabled={busy}
                  onClick={() => void handleReconnectWa(false)}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] cursor-pointer"
                >
                  Reconnect Socket
                </button>
                <button
                  disabled={busy}
                  onClick={() => void handleReconnectWa(true)}
                  className="px-3.5 py-2 text-xs font-semibold text-red-400 border border-red-900/60 rounded-lg hover:bg-red-950/50 cursor-pointer"
                >
                  Reset Sesi & Reconnect
                </button>
              </div>
            )}
          </div>

          {/* Telegram Card */}
          <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#1668ff] text-white flex items-center justify-center">
                <Send className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">Telegram Bot (Telegraf)</h3>
                <p className="text-xs font-mono text-slate-400">
                  State: {status.telegram.state} · Username: {status.telegram.botUsername ? `@${status.telegram.botUsername}` : '-'}
                </p>
              </div>
            </div>

            {status.telegram.lastError && (
              <div className="p-3 rounded-lg bg-amber-950/50 border border-amber-800/60 text-xs text-amber-200">
                {status.telegram.lastError}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[#1e293d] text-center">
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-xs text-slate-400">Notif Pending</p>
                <p className="text-lg font-mono font-bold tabular-nums text-slate-100">{status.notifications.pending ?? 0}</p>
              </div>
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-xs text-slate-400">Notif Terkirim</p>
                <p className="text-lg font-mono font-bold tabular-nums text-emerald-400">{status.notifications.sent ?? 0}</p>
              </div>
              <div className="p-3 bg-[#0f1727] border border-[#1f2b42] rounded-lg">
                <p className="text-xs text-slate-400">Notif Gagal</p>
                <p className="text-lg font-mono font-bold tabular-nums text-red-400">{status.notifications.failed ?? 0}</p>
              </div>
            </div>

            {permissions.includes('bots:manage') && (
              <div className="pt-2 border-t border-[#1e293d]">
                <button
                  disabled={busy || !status.telegram.enabled}
                  onClick={() => void handleReconnectTg()}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] disabled:opacity-50 cursor-pointer"
                >
                  Restart Polling Telegram
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
