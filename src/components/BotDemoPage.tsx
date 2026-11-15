import React, { useEffect, useRef, useState } from 'react';
import { Send, Trash2, Smartphone, MessageSquare } from 'lucide-react';
import { api } from '../api/client';
import type { AdminSession } from '../types/admin';

type Platform = 'WHATSAPP' | 'TELEGRAM';
type SenderRole = 'CUSTOMER' | 'ADMIN';

interface ChatButton {
  text: string;
  callbackData?: string;
  replyText?: string;
}

interface ChatMessage {
  id: string;
  from: 'USER' | 'BOT';
  platform: Platform;
  senderLabel: string;
  text: string;
  imageDataUrl?: string;
  buttons?: ChatButton[][];
  timestamp: string;
}

function renderFormattedLines(text: string) {
  return text.split('\n').map((line, idx) => {
    // Convert WhatsApp-style *bold* segments to strong elements safely
    const segments = line.split(/(\*[^*]+\*)/g);
    return (
      <div key={idx} className={line === '' ? 'h-2' : undefined}>
        {segments.map((seg, sIdx) => {
          if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) {
            return (
              <strong key={sIdx} className="font-semibold">
                {seg.slice(1, -1)}
              </strong>
            );
          }
          return <React.Fragment key={sIdx}>{seg}</React.Fragment>;
        })}
      </div>
    );
  });
}

export function BotDemoPage({ admin }: { admin: AdminSession }) {
  const [platform, setPlatform] = useState<Platform>('WHATSAPP');
  const [senderRole, setSenderRole] = useState<SenderRole>('CUSTOMER');
  const [senderId, setSenderId] = useState('6281234567890');
  const [sampleSku, setSampleSku] = useState('TSEL10');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .getProducts({ page: 1, limit: 10 })
      .then((res) => {
        const active = (res.data?.items || []).find((p: any) => p.status === 'ACTIVE' && p.is_available === 1);
        if (active?.sku) setSampleSku(String(active.sku));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handlePlatformSwitch(next: Platform) {
    setPlatform(next);
    setSenderId(next === 'WHATSAPP' ? '6281234567890' : '100001');
    setError(null);
  }

  async function sendInteraction(params: {
    inputType: 'TEXT' | 'CALLBACK';
    text?: string;
    callbackData?: string;
    displayLabel: string;
    sourceMessageId?: string;
    deletePreviousOnTelegram?: boolean;
  }) {
    if (sending) return;
    const nowTime = new Date().toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const roleLabel = senderRole === 'ADMIN' ? `Admin (${admin.role})` : 'Pelanggan';
    const isTelegramClickDelete =
      platform === 'TELEGRAM' && (Boolean(params.deletePreviousOnTelegram) || params.inputType === 'CALLBACK');

    setMessages((prev) => {
      const next = isTelegramClickDelete
        ? prev.filter((m) => !(m.platform === 'TELEGRAM' && m.from === 'BOT'))
        : prev;

      if (platform === 'TELEGRAM' && params.inputType === 'CALLBACK') {
        return next;
      }

      return [
        ...next,
        {
          id: `u-${Date.now()}-${Math.random()}`,
          from: 'USER',
          platform,
          senderLabel: roleLabel,
          text: params.displayLabel,
          timestamp: nowTime,
        },
      ];
    });
    setSending(true);
    setError(null);

    try {
      const res = await api.simulateBotDemo({
        platform,
        senderRole,
        inputType: params.inputType,
        text: params.text,
        callbackData: params.callbackData,
        senderId: senderId.trim() || undefined,
      });

      const replies = res.data.replies;
      const replyTime = new Date().toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      if (replies.length === 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}-empty`,
            from: 'BOT',
            platform,
            senderLabel: platform === 'WHATSAPP' ? 'WhatsApp Bot' : 'Telegram Bot',
            text: '(Tidak ada balasan dari handler untuk input ini)',
            timestamp: replyTime,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          ...replies.map((r, i) => ({
            id: `b-${Date.now()}-${i}-${Math.random()}`,
            from: 'BOT' as const,
            platform,
            senderLabel: platform === 'WHATSAPP' ? 'WhatsApp Bot' : 'Telegram Bot',
            text: r.text,
            imageDataUrl: r.imageDataUrl,
            buttons: r.buttons,
            timestamp: replyTime,
          })),
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menjalankan simulasi bot');
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed) return;
    setInputText('');
    void sendInteraction({
      inputType: 'TEXT',
      text: trimmed,
      displayLabel: trimmed,
    });
  }

  const customerPresets =
    platform === 'WHATSAPP'
      ? [
          { label: 'Menu Utama', cmd: 'menu' },
          { label: 'Kategori Produk', cmd: 'kategori' },
          { label: 'Daftar Produk', cmd: 'produk' },
          { label: `Simulasi Order (${sampleSku})`, cmd: `order ${sampleSku} 081234567890` },
          { label: 'Cek Status Terakhir', cmd: 'status' },
          { label: 'Batalkan Pending (batal)', cmd: 'batal' },
          { label: 'Riwayat & Refund', cmd: 'riwayat' },
          { label: 'Kode Hubungkan Akun', cmd: 'hubungkan' },
        ]
      : [
          { label: '/menu (+ Tombol Inline)', cmd: '/menu' },
          { label: '/kategori', cmd: '/kategori' },
          { label: '/produk', cmd: '/produk' },
          { label: `Simulasi /order (${sampleSku})`, cmd: `/order ${sampleSku} 081234567890` },
          { label: '/status', cmd: '/status' },
          { label: '/batal (Batalkan Pending)', cmd: '/batal' },
          { label: '/riwayat', cmd: '/riwayat' },
          { label: '/hubungkan', cmd: '/hubungkan' },
        ];

  const adminPresets =
    platform === 'WHATSAPP'
      ? [
          { label: '!admin', cmd: '!admin' },
          { label: '!transaksi', cmd: '!transaksi' },
          { label: '!statusbot', cmd: '!statusbot' },
          { label: '!maintenance on (Demo)', cmd: '!maintenance on' },
        ]
      : [
          { label: '/admin', cmd: '/admin' },
          { label: '/transaksi', cmd: '/transaksi' },
          { label: '/riwayat_hari_ini', cmd: '/riwayat_hari_ini' },
          { label: '/status_bot', cmd: '/status_bot' },
          { label: '/maintenance on (Demo)', cmd: '/maintenance on' },
        ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Demo Respon Bot</h2>
          <p className="text-sm text-slate-400">
            Uji langsung respon perintah WhatsApp & Telegram menggunakan handler produksi dan katalog SQLite nyata tanpa mengirim pesan eksternal.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setError(null);
          }}
          disabled={messages.length === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] disabled:opacity-50 cursor-pointer whitespace-nowrap"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Bersihkan Chat
        </button>
      </div>

      {/* Controls toolbar */}
      <div className="bg-[#131c2e] border border-[#1f2b42] rounded-lg p-4 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <span className="block text-xs font-medium text-slate-400 mb-1.5">Platform Bot</span>
            <div className="inline-flex items-center gap-1 p-1 bg-[#0f1727] rounded-lg border border-[#1f2b42]">
              <button
                type="button"
                onClick={() => handlePlatformSwitch('WHATSAPP')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  platform === 'WHATSAPP' ? 'bg-[#1668ff] text-white shadow-xs' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                WhatsApp Bot
              </button>
              <button
                type="button"
                onClick={() => handlePlatformSwitch('TELEGRAM')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  platform === 'TELEGRAM' ? 'bg-[#1668ff] text-white shadow-xs' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Telegram Bot
              </button>
            </div>
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-400 mb-1.5">Peran Pengirim</span>
            <div className="inline-flex items-center gap-1 p-1 bg-[#0f1727] rounded-lg border border-[#1f2b42]">
              <button
                type="button"
                onClick={() => setSenderRole('CUSTOMER')}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  senderRole === 'CUSTOMER' ? 'bg-[#1668ff] text-white shadow-xs' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Pelanggan
              </button>
              <button
                type="button"
                onClick={() => setSenderRole('ADMIN')}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  senderRole === 'ADMIN' ? 'bg-[#1668ff] text-white shadow-xs' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Admin ({admin.role})
              </button>
            </div>
          </div>
        </div>

        <div className="w-full sm:w-64">
          <label htmlFor="demo-sender-id" className="block text-xs font-medium text-slate-400 mb-1.5">
            {platform === 'WHATSAPP' ? 'Nomor WhatsApp Simulasi' : 'Telegram User ID Simulasi'}
          </label>
          <input
            id="demo-sender-id"
            type="text"
            value={senderId}
            onChange={(e) => setSenderId(e.target.value)}
            placeholder={platform === 'WHATSAPP' ? '6281234567890' : '100001'}
            className="w-full px-3 py-1.5 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-lg border bg-red-950/50 border-red-800/60 text-red-200 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left: Quick Command Presets */}
        <div className="lg:col-span-4 bg-[#131c2e] border border-[#1f2b42] rounded-lg p-5 flex flex-col justify-between space-y-5">
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-bold text-slate-100">Perintah Pelanggan</h3>
              <p className="text-xs text-slate-400 mt-1">
                Klik tombol di bawah untuk langsung mengirim skenario perintah ke simulator.
              </p>
              <div className="mt-3 space-y-1.5">
                {customerPresets.map((item) => (
                  <button
                    key={item.cmd}
                    type="button"
                    disabled={sending}
                    onClick={() =>
                      void sendInteraction({
                        inputType: 'TEXT',
                        text: item.cmd,
                        displayLabel: item.cmd,
                        deletePreviousOnTelegram: true,
                      })
                    }
                    className="w-full text-left px-3 py-2 text-xs bg-[#0f1727] border border-[#1f2b42] rounded-lg hover:bg-[#19243b] hover:border-[#2a3852] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <div className="font-semibold text-slate-100">{item.label}</div>
                    <div className="font-mono text-[#4b8bff] truncate mt-0.5">{item.cmd}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t border-[#1e293d]">
              <h3 className="text-sm font-bold text-slate-100">Perintah Admin Bot</h3>
              <p className="text-xs text-slate-400 mt-1">
                Ubah Peran Pengirim ke Admin untuk menguji panel admin, atau biarkan Pelanggan untuk menguji penolakan RBAC.
              </p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1.5">
                {adminPresets.map((item) => (
                  <button
                    key={item.cmd}
                    type="button"
                    disabled={sending}
                    onClick={() =>
                      void sendInteraction({
                        inputType: 'TEXT',
                        text: item.cmd,
                        displayLabel: item.cmd,
                        deletePreviousOnTelegram: true,
                      })
                    }
                    className="w-full text-left px-3 py-2 text-xs bg-[#0f1727] border border-[#1f2b42] rounded-lg hover:bg-[#19243b] hover:border-[#2a3852] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <span className="font-mono font-semibold text-[#60a5fa]">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-[#1e293d] text-xs text-slate-400 leading-relaxed">
            Perintah baca (<code className="font-mono text-slate-200">kategori</code>, <code className="font-mono text-slate-200">produk</code>,{' '}
            <code className="font-mono text-slate-200">!transaksi</code>) membaca database nyata. Perintah{' '}
            <code className="font-mono text-slate-200">order</code>, <code className="font-mono text-slate-200">hubungkan</code>, dan{' '}
            <code className="font-mono text-slate-200">maintenance</code> berjalan dalam mode dry-run aman tanpa membuat transaksi atau mengubah status server.
          </div>
        </div>

        {/* Right: Chat Simulator */}
        <div className="lg:col-span-8 bg-[#131c2e] border border-[#1f2b42] rounded-lg flex flex-col min-h-[560px] max-h-[720px]">
          <div className="px-5 py-3.5 border-b border-[#1f2b42] flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-bold text-slate-100">
              {platform === 'WHATSAPP' ? 'Pratinjau WhatsApp Bot' : 'Pratinjau Telegram Bot'}
            </div>
            <div className="text-xs text-slate-400 flex items-center gap-2 font-mono">
              <span>{senderRole === 'ADMIN' ? `Admin · ${admin.role}` : 'Pelanggan'}</span>
              <span aria-hidden="true">·</span>
              <span>Mode Dry-Run Aman</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-[#0b111e]">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-12 px-4">
                <p className="text-sm font-semibold text-slate-100">Belum ada percakapan simulasi</p>
                <p className="text-xs text-slate-400 mt-1 max-w-md">
                  Pilih salah satu skenario di sebelah kiri atau ketik perintah seperti{' '}
                  <code className="font-mono text-[#60a5fa]">{platform === 'WHATSAPP' ? 'menu' : '/menu'}</code> di bawah untuk melihat respon asli bot.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void sendInteraction({
                      inputType: 'TEXT',
                      text: platform === 'WHATSAPP' ? 'menu' : '/menu',
                      displayLabel: platform === 'WHATSAPP' ? 'menu' : '/menu',
                      deletePreviousOnTelegram: true,
                    })
                  }
                  className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] cursor-pointer whitespace-nowrap"
                >
                  Kirim {platform === 'WHATSAPP' ? 'menu' : '/menu'} Sekarang
                </button>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.from === 'USER' ? 'items-end' : 'items-start'}`}
                >
                  <div className="text-[11px] text-slate-400 mb-1 flex items-center gap-1.5 font-mono tabular-nums">
                    <span>{msg.senderLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{msg.timestamp}</span>
                  </div>

                  <div
                    className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed break-words ${
                      msg.from === 'USER'
                        ? 'bg-[#1668ff] text-white'
                        : 'bg-[#192233] border border-[#2a3852] text-slate-100'
                    }`}
                  >
                    {msg.imageDataUrl && (
                      <div className="mb-3 bg-white p-2 rounded-md border border-[#2a3852] inline-block">
                        <img
                          src={msg.imageDataUrl}
                          alt="Pratinjau QRIS Pembayaran"
                          referrerPolicy="no-referrer"
                          className="w-48 h-48 object-contain"
                        />
                      </div>
                    )}
                    <div className="space-y-0.5">{renderFormattedLines(msg.text)}</div>

                    {msg.buttons && msg.buttons.length > 0 && (
                      <div className="mt-3 pt-2.5 border-t border-[#26334a] space-y-1.5">
                        {msg.buttons.map((row, rIdx) => (
                          <div key={rIdx} className="flex flex-wrap gap-1.5">
                            {row.map((btn, bIdx) => (
                              <button
                                key={btn.callbackData || btn.replyText || bIdx}
                                type="button"
                                disabled={sending}
                                onClick={() => {
                                  if (btn.callbackData) {
                                    void sendInteraction({
                                      inputType: 'CALLBACK',
                                      callbackData: btn.callbackData,
                                      displayLabel: `[Klik Tombol] ${btn.text}`,
                                      sourceMessageId: msg.id,
                                      deletePreviousOnTelegram: true,
                                    });
                                  } else if (btn.replyText) {
                                    void sendInteraction({
                                      inputType: 'TEXT',
                                      text: btn.replyText,
                                      displayLabel: `[Klik Menu] ${btn.text}`,
                                      sourceMessageId: msg.id,
                                    });
                                  }
                                }}
                                className="flex-1 min-w-[120px] px-3 py-1.5 text-xs font-semibold text-[#60a5fa] bg-[#142b59] hover:bg-[#19356e] border border-[#254e9c] rounded-md transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                              >
                                {btn.text}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={scrollEndRef} />
          </div>

          <form onSubmit={handleSubmit} className="p-4 border-t border-[#1f2b42] bg-[#131c2e] flex items-center gap-2.5">
            <label htmlFor="bot-demo-input" className="sr-only">
              Perintah bot
            </label>
            <input
              id="bot-demo-input"
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={sending}
              placeholder={
                platform === 'WHATSAPP'
                  ? `Ketik perintah WhatsApp (misal: menu, produk, order ${sampleSku} 081234567890)`
                  : `Ketik perintah Telegram (misal: /menu, /produk, /order ${sampleSku} 081234567890)`
              }
              className="flex-1 px-3.5 py-2 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-[#1668ff] focus:border-[#1668ff]"
            />
            <button
              type="submit"
              disabled={sending || !inputText.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Memproses...' : 'Kirim'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
