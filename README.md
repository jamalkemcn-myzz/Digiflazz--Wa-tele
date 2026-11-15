# PPOB Bot Ecosystem

Ekosistem PPOB terintegrasi dalam satu codebase menggunakan **Node.js + Express**, **WhatsApp Bot (`@whiskeysockets/baileys` Pairing Code)**, **Telegram Bot (`telegraf`)**, **React Admin Dashboard**, **SQLite persisten (WAL mode)**, **Custom Payment Gateway MyZZStore**, dan **Supplier Digiflazz**.

Seluruh kanal (WhatsApp, Telegram, dan Admin Dashboard) terhubung ke satu *Shared Service Layer* dan satu database SQLite sebagai *Single Source of Truth*.

---

## Arsitektur & Struktur Proyek

```text
├── .npmrc                        # Wajib: allow-git=all untuk kompatibilitas Pterodactyl
├── .env.example                  # Template variabel environment (tanpa secret)
├── server.ts                     # Entry point utama (Recovery -> Scheduler -> Express -> Bots)
├── server/
│   ├── config/env.ts             # Loader & validator .env terpusat
│   ├── logging/logger.ts         # Structured logger dengan redaksi secret otomatis
│   ├── database/
│   │   ├── connection.ts         # Koneksi SQLite persisten + WAL + busy_timeout + withTransaction
│   │   └── migrate.ts            # Sistem migrasi & trigger immutability ledger/audit
│   ├── domain/                   # Pure business rules (pricing, coupon, state machine, masking, RBAC)
│   ├── integrations/
│   │   ├── myzzstore.gateway.ts  # Adapter MyZZStore (create, checkStatus, verifyCallback, cancel)
│   │   └── digiflazz.*.ts        # Adapter Digiflazz v1 (price-list, transaction, inquiry, balance)
│   ├── services/                 # Shared Service Layer (customer, product, margin, coupon, payment, transaction, refund, notification, reconciliation, backup, admin, audit, settings)
│   ├── bots/
│   │   ├── whatsapp.*.ts         # Baileys Pairing Code, persistent session, exponential reconnect
│   │   └── telegram.*.ts         # Telegraf command, inline callback, RBAC admin, notification
│   ├── workers/scheduler.ts      # Central scheduler (polling, expiry, reconciliation, cron sync & backup)
│   ├── http/                     # Express middleware (Basic Auth, RBAC, rate-limit), callback & admin routes
│   └── scripts/                  # CLI scripts (migrate.ts, backup.ts)
└── src/                          # React + Vite Admin Dashboard (dilindungi Basic Auth)
```

---

## Catatan Penting Integrasi MyZZStore & Digiflazz

1. **MyZZStore (`https://gateway.myzzstore.my.id`)**:
   - Adapter `server/integrations/myzzstore.gateway.ts` **tidak mengarang endpoint atau format signature**.
   - Sebelum mengaktifkan pembayaran produksi, lengkapi variabel `.env` berikut sesuai dokumentasi resmi MyZZStore:
     - `PAYMENT_GATEWAY_API_KEY`
     - `PAYMENT_GATEWAY_SECRET`
     - `PAYMENT_GATEWAY_MERCHANT_ID`
     - `PAYMENT_GATEWAY_CALLBACK_SECRET`
     - `PAYMENT_GATEWAY_CREATE_PATH` (path endpoint pembuatan QRIS sesuai dokumen MyZZStore)
     - `PAYMENT_GATEWAY_STATUS_PATH` (path endpoint cek status invoice sesuai dokumen MyZZStore)
     - `PAYMENT_GATEWAY_CANCEL_PATH` (opsional jika didukung gateway)
2. **Digiflazz (`https://api.digiflazz.com/v1`)**:
   - Menggunakan kontrak resmi Digiflazz v1 (`/price-list`, `/transaction`, `/cek-saldo`) dengan signature MD5.
   - Isi `DIGIFLAZZ_USERNAME` dan `DIGIFLAZZ_API_KEY` di `.env`.

---

## Panduan Instalasi & Deployment di Pterodactyl

1. **Buat Server Node.js di Pterodactyl** menggunakan Node.js Egg (direkomendasikan **Node.js 20 LTS atau 22 LTS**).
2. **Upload atau clone source code** ke direktori root container Pterodactyl (`/home/container`).
3. **Pastikan file `.npmrc`** berada di root proyek dengan isi `allow-git=all`.
4. **Instal dependency**:
   ```bash
   npm install
   ```
5. **Build Admin Dashboard**:
   ```bash
   npm run build
   ```
6. **Buat file `.env`** dari template:
   ```bash
   cp .env.example .env
   ```
7. **Konfigurasikan variabel wajib pada `.env`**:
   - `NODE_ENV=production`
   - `PORT=3000` (atau sesuaikan dengan alokasi port Pterodactyl)
   - `APP_URL=https://domain-anda.com`
   - `DASHBOARD_AUTH_USER` & `DASHBOARD_AUTH_PASSWORD`
   - `SESSION_SECRET` (string acak minimal 32 karakter)
   - Kredensial **MyZZStore** (`PAYMENT_GATEWAY_*`)
   - Kredensial **Digiflazz** (`DIGIFLAZZ_USERNAME`, `DIGIFLAZZ_API_KEY`)
   - Token **Telegram** (`TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`) jika digunakan
   - ID Grup/Channel logging (`WHATSAPP_SERVICE_LOG_GROUP`, `WHATSAPP_TRANSACTION_LOG_GROUP`, `TELEGRAM_SERVICE_LOG_CHAT_ID`, `TELEGRAM_TRANSACTION_LOG_CHAT_ID`)
   - `OWNER_WHATSAPP_JID` dan `OWNER_TELEGRAM_ID` untuk akses command admin bot.
8. **Pastikan direktori persisten tersedia & memiliki izin tulis**:
   ```bash
   mkdir -p data data/whatsapp-session backups logs
   chmod -R 755 data backups logs
   ```
9. **Jalankan migrasi database SQLite**:
   ```bash
   npm run migrate
   ```
10. **Jalankan aplikasi**:
    - Di Pterodactyl Startup Command, gunakan: `npm start`
11. **Buka Dashboard Admin** melalui browser ke `APP_URL` dan login menggunakan kredensial Basic Auth dari `.env`.
12. **Hubungkan WhatsApp menggunakan Pairing Code**:
    - Pastikan `WHATSAPP_ENABLED=true` di `.env` dan server sudah restart.
    - Buka menu **Bot Management** di dashboard (login sebagai Owner/Admin).
    - Masukkan nomor WhatsApp bot (`628...`) dan klik **Generate Pairing Code**.
    - Masukkan Pairing Code di aplikasi WhatsApp → *Linked Devices* → *Link with phone number*.
    - Sesi tersimpan persisten di `data/whatsapp-session/` agar tidak perlu pairing ulang saat restart.
13. **Uji Telegram Bot**: Kirim `/start` atau `/menu` ke bot Telegram Anda, lalu uji `/admin` menggunakan akun yang terdaftar di `OWNER_TELEGRAM_ID`.
14. **Uji End-to-End Produksi**:
    - Jalankan sinkronisasi harga Digiflazz melalui **Products → Sinkronisasi Harga Digiflazz**.
    - Uji pembuatan invoice QRIS, verifikasi webhook callback (`POST /api/webhooks/myzzstore`), pemrosesan supplier Digiflazz, serta cek backup manual di **Settings**.

---

## Panduan Operasional

- **Mengatur Margin**: Buka **Margin Settings** (atau atur per kategori/produk). Prioritas: *Margin Produk → Margin Kategori → Margin Global*. Perubahan margin hanya berlaku untuk transaksi baru.
- **Membuat Kupon**: Buka **Coupons**, tentukan kode unik, nominal/persentase, minimal pembelian, maksimal potongan, batas klaim, dan masa berlaku.
- **Menangani Transaksi Pending / UNKNOWN**:
  - Sistem scheduler otomatis memantau invoice `PENDING_PAYMENT` dan melakukan *inquiry* ke Digiflazz untuk status `SUPPLIER_PENDING`/`UNKNOWN`.
  - **Jangan pernah** merefund transaksi yang masih `PENDING` atau `UNKNOWN`. Gunakan tombol **Inquiry & Rekonsiliasi Manual** di detail transaksi bila perlu pengecekan langsung.
- **Refund Internal**:
  - Sistem **tidak memiliki fitur deposit atau top-up**.
  - Kredit refund hanya dicatat otomatis ke `refund_ledger` (bersifat *immutable/append-only*) apabila pembayaran terverifikasi `PAID` dan supplier menyatakan kegagalan definitif (`FAILED`).
  - Penyesuaian manual hanya dapat dilakukan oleh **OWNER** dengan alasan wajib dan tercatat di `audit_logs`.
- **Backup & Restore SQLite**:
  - Backup otomatis berjalan sesuai `BACKUP_CRON` menggunakan SQLite Online Backup API ke folder `backups/`.
  - Backup manual via CLI: `npm run backup` atau via Dashboard **Settings → Buat Backup Sekarang**.
  - **Prosedur Restore**:
    1. Hentikan server Pterodactyl terlebih dahulu.
    2. Salin file backup lama sebagai cadangan: `cp data/database.sqlite data/database.sqlite.before-restore`
    3. Hapus file WAL sementara jika ada: `rm -f data/database.sqlite-wal data/database.sqlite-shm`
    4. Salin file backup target: `cp backups/database-YYYY-MM-DD_HH-MM-SS.sqlite data/database.sqlite`
    5. Jalankan `npm run migrate` lalu nyalakan kembali server.
- **Update Aplikasi Tanpa Kehilangan Data**:
  - Jangan pernah menghapus direktori `data/`, `backups/`, `logs/`, atau file `.env`.
  - Setelah menarik source code baru, jalankan `npm install && npm run build && npm run migrate`, lalu restart server.

---

## Pengujian Otomatis

Jalankan seluruh pengujian unit, integrasi, dan end-to-end dengan:

```bash
npm test
```
