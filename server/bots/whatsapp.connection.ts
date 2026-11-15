import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import { normalizeWhatsappNumber } from '../domain/masking';
import { loadWhatsappAuthState, hasSavedWhatsappSession } from './whatsapp.session';
import { emitServiceLogToGroups } from '../services/notification.service';

export type WhatsappConnectionState =
  | 'DISABLED'
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'AWAITING_PAIRING'
  | 'CONNECTED'
  | 'LOGGED_OUT'
  | 'ERROR';

export interface WhatsappStatusSnapshot {
  enabled: boolean;
  state: WhatsappConnectionState;
  hasSavedSession: boolean;
  reconnectAttempts: number;
  lastError: string | null;
  connectedAt: string | null;
}

type MessageListener = (sock: WASocket, upsert: unknown) => Promise<void>;

export class WhatsappConnectionManager {
  private socket: WASocket | null = null;
  private state: WhatsappConnectionState = config.whatsapp.enabled ? 'DISCONNECTED' : 'DISABLED';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isStopping = false;
  private lastError: string | null = null;
  private connectedAt: string | null = null;
  private onMessageCallback: MessageListener | null = null;

  setMessageHandler(handler: MessageListener) {
    this.onMessageCallback = handler;
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  getStatus(): WhatsappStatusSnapshot {
    return {
      enabled: config.whatsapp.enabled,
      state: this.state,
      hasSavedSession: hasSavedWhatsappSession(),
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    };
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeCurrentSocket() {
    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.end(undefined);
      } catch {
        // Best-effort socket cleanup
      }
      this.socket = null;
    }
  }

  async connect(force = false): Promise<void> {
    if (!config.whatsapp.enabled) {
      this.state = 'DISABLED';
      return;
    }
    if (this.isStopping && !force) return;
    if (this.isConnecting) return;

    this.isStopping = false;
    this.isConnecting = true;
    this.clearReconnectTimer();
    this.closeCurrentSocket();
    this.state = 'CONNECTING';

    try {
      const { state: authState, saveCreds } = await loadWhatsappAuthState();
      const { version } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307] as [number, number, number],
      }));

      // Silent pino logger so Baileys never leaks session secrets or noise
      const silentLogger = pino({ level: 'silent' });

      const sock = makeWASocket({
        version,
        auth: authState,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: ['PPOB Bot Ecosystem', 'Chrome', '1.0.0'],
        syncFullHistory: false,
      });

      this.socket = sock;
      this.state = authState.creds.registered ? 'CONNECTING' : 'AWAITING_PAIRING';

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          logger.error('Failed to persist WhatsApp creds', {
            service: 'whatsapp',
            details: { error: err instanceof Error ? err.message : 'unknown' },
          });
        }
      });

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          this.state = 'CONNECTED';
          this.reconnectAttempts = 0;
          this.lastError = null;
          this.connectedAt = new Date().toISOString();
          logger.info('WhatsApp bot connected', { service: 'whatsapp' });
          emitServiceLogToGroups(
            `wa-open-${Date.now()}`,
            'WhatsApp Connected',
            'Bot WhatsApp berhasil terhubung dan siap melayani pelanggan.'
          );
        } else if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            this.state = 'LOGGED_OUT';
            this.lastError = 'Sesi WhatsApp telah logout. Diperlukan Pairing Code baru oleh Owner/Admin.';
            this.closeCurrentSocket();
            logger.warn('WhatsApp session logged out', { service: 'whatsapp' });
            emitServiceLogToGroups(
              `wa-logout-${Date.now()}`,
              'WhatsApp Logged Out',
              'Sesi WhatsApp terputus karena logout. Harap lakukan pairing ulang dari dashboard.'
            );
            return;
          }

          this.state = 'DISCONNECTED';
          this.lastError = statusCode ? `Koneksi terputus (kode ${statusCode})` : 'Koneksi WhatsApp terputus';
          logger.warn('WhatsApp connection closed', {
            service: 'whatsapp',
            details: { statusCode },
          });

          if (!this.isStopping) {
            this.scheduleReconnect();
          }
        }
      });

      sock.ev.on('messages.upsert', async (upsert) => {
        if (this.onMessageCallback) {
          try {
            await this.onMessageCallback(sock, upsert);
          } catch (err) {
            logger.error('WhatsApp message handler error', {
              service: 'whatsapp',
              details: { error: err instanceof Error ? err.message : 'unknown' },
            });
          }
        }
      });
    } catch (err) {
      this.state = 'ERROR';
      this.lastError = err instanceof Error ? err.message : 'Gagal inisialisasi socket WhatsApp';
      logger.error('WhatsApp connect error', {
        service: 'whatsapp',
        details: { error: this.lastError },
      });
      if (!this.isStopping) {
        this.scheduleReconnect();
      }
    } finally {
      this.isConnecting = false;
    }
  }

  private scheduleReconnect() {
    if (this.isStopping || !config.whatsapp.enabled) return;
    this.clearReconnectTimer();

    const maxRetries = 12;
    if (this.reconnectAttempts >= maxRetries) {
      this.state = 'ERROR';
      this.lastError = 'Batas percobaan reconnect otomatis tercapai. Gunakan tombol Reconnect di dashboard.';
      logger.error('WhatsApp reconnect max retries reached', { service: 'whatsapp' });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      config.whatsapp.reconnectMaxDelayMs,
      config.whatsapp.reconnectMinDelayMs * Math.pow(2, this.reconnectAttempts - 1)
    );

    logger.info('Scheduling WhatsApp reconnect', {
      service: 'whatsapp',
      details: { attempt: this.reconnectAttempts, delayMs: delay },
    });

    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  /**
   * Generates a Pairing Code ONLY for authorized Owner/Admin callers (enforced in API/RBAC layer).
   * Never logs or exposes Pairing Code in logs or group messages.
   */
  async requestPairingCode(rawPhoneNumber: string): Promise<string> {
    if (!config.whatsapp.enabled) {
      throw new Error('WhatsApp bot tidak diaktifkan di konfigurasi (.env WHATSAPP_ENABLED=true)');
    }

    const normalized = normalizeWhatsappNumber(rawPhoneNumber);
    if (normalized.length < 10 || normalized.length > 15) {
      throw new Error('Nomor WhatsApp tidak valid untuk Pairing Code');
    }

    if (!this.socket || this.state === 'DISCONNECTED' || this.state === 'LOGGED_OUT' || this.state === 'ERROR') {
      await this.connect(true);
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!this.socket) {
      throw new Error('Socket WhatsApp belum siap untuk membuat Pairing Code');
    }

    if (this.socket.authState.creds.registered) {
      throw new Error('Sesi WhatsApp sudah terdaftar. Putuskan atau reset sesi terlebih dahulu jika ingin pairing ulang.');
    }

    const code = await this.socket.requestPairingCode(normalized);
    this.state = 'AWAITING_PAIRING';
    return code;
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.clearReconnectTimer();
    this.closeCurrentSocket();
    if (config.whatsapp.enabled) {
      this.state = 'DISCONNECTED';
    }
    logger.info('WhatsApp connection stopped cleanly', { service: 'whatsapp' });
  }
}
