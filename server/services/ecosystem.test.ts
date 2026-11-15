import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

// Configure isolated temp SQLite & test env before importing app modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppob-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.BACKUP_DIR = path.join(tempDir, 'backups');
process.env.DASHBOARD_AUTH_USER = 'testowner';
process.env.DASHBOARD_AUTH_PASSWORD = 'test-strong-password-999';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';
process.env.PAYMENT_GATEWAY_CALLBACK_SECRET = 'test-cb-secret';
process.env.PAYMENT_GATEWAY_MERCHANT_ID = 'MERCHANT01';
process.env.TRANSACTION_COOLDOWN_SECONDS = '30';

import { refreshConfig } from '../config/env';
refreshConfig(process.env);
import { getDb, closeDb } from '../database/connection';
import { runMigrations, verifyDatabaseIntegrity } from '../database/migrate';
import { upsertProduct, listCategories, listProducts, getGlobalMarginRule } from './product.service';
import { setGlobalMargin, setCategoryMargin, listMarginHistory } from './margin.service';
import { createCoupon } from './coupon.service';
import { createOrder, processSingleSupplierJob, transitionTransactionStatus } from './transaction.service';
import { processGatewayCallback, finalizeExpiredInvoice } from './payment.service';
import { reconcileUnknownAndMissedCallbacks } from './payment.reconciliation.service';
import { processAutomaticRefund, applyManualRefundOrAdjustment } from './refund.service';
import { requestAccountLinkCode, verifyAndLinkAccount, resolveOrCreateCustomer, getCustomerRefundCreditTotal } from './customer.service';
import { setMaintenanceMode } from './settings.service';
import { runDatabaseBackup } from './backup.service';
import {
  listAdmins,
  createAdmin,
  updateAdminRole,
  addAdminIdentity,
  removeAdminIdentity,
  resetAdminsAndSyncOwner,
} from './admin.service';
import { runBotDemoInteraction } from './bot-demo.service';
import { createExpressApp } from '../http/app';
import type { PaymentGatewayPort, GatewayPaymentState } from '../integrations/myzzstore.gateway';
import { DigiflazzService } from '../integrations/digiflazz.service';
import type { DigiflazzPort, DigiflazzTxResponse } from '../integrations/digiflazz.client';

class TestPaymentGateway implements PaymentGatewayPort {
  public createCalls = 0;
  public cancelCalls = 0;
  public nextCreateBehavior: 'OK' | 'TIMEOUT' | 'FAIL' = 'OK';
  public statusByRef = new Map<string, GatewayPaymentState>();

  isConfigured() {
    return true;
  }
  getMissingConfiguration() {
    return [];
  }
  async createPayment(input: { transactionId: string; amount: number }) {
    this.createCalls++;
    if (this.nextCreateBehavior === 'TIMEOUT') {
      return {
        ok: false,
        mappedStatus: 'UNKNOWN' as const,
        errorCode: 'GATEWAY_TIMEOUT' as const,
        errorMessage: 'Timeout',
      };
    }
    if (this.nextCreateBehavior === 'FAIL') {
      return {
        ok: false,
        mappedStatus: 'FAILED' as const,
        errorCode: 'GATEWAY_HTTP_ERROR' as const,
        errorMessage: 'HTTP 400',
      };
    }
    const ref = `GW-${input.transactionId}`;
    this.statusByRef.set(ref, 'PENDING');
    return {
      ok: true,
      gatewayReference: ref,
      qrString: `00020101021226TEST${input.transactionId}`,
      mappedStatus: 'PENDING' as const,
    };
  }
  async checkPaymentStatus(gatewayReference: string, _txId: string) {
    const st = this.statusByRef.get(gatewayReference) ?? 'UNKNOWN';
    return {
      ok: st !== 'UNKNOWN',
      gatewayReference,
      mappedStatus: st,
      paidAt: st === 'PAID' ? new Date().toISOString() : undefined,
    };
  }
  verifyCallback(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    parsedBody: unknown
  ) {
    const sig = String(headers['x-callback-signature'] || '');
    const expected = crypto
      .createHmac('sha256', process.env.PAYMENT_GATEWAY_CALLBACK_SECRET!)
      .update(rawBody)
      .digest('hex');
    if (sig !== expected) {
      return { valid: false, reason: 'Invalid signature', mappedStatus: 'UNKNOWN' as const, safePayload: {} };
    }
    const d = parsedBody as Record<string, unknown>;
    return {
      valid: true,
      eventId: String(d.event_id),
      gatewayReference: String(d.reference),
      transactionId: String(d.order_id),
      amount: Number(d.amount),
      mappedStatus: String(d.status) as GatewayPaymentState,
      paidAt: new Date().toISOString(),
      safePayload: d,
    };
  }
  async cancelPayment(_ref: string) {
    this.cancelCalls++;
    return { ok: true, supported: true, mappedStatus: 'CANCELLED' as const };
  }
}

class TestDigiflazzPort implements DigiflazzPort {
  public purchaseCount = 0;
  public inquiryCount = 0;
  public nextStatus: 'SUCCESS' | 'PENDING' | 'FAILED' | 'UNKNOWN' = 'SUCCESS';

  isConfigured() {
    return true;
  }
  async fetchPriceList() {
    return { ok: true, items: [] };
  }
  async createTransaction(params: { refId: string }): Promise<DigiflazzTxResponse> {
    this.purchaseCount++;
    return {
      ok: this.nextStatus !== 'UNKNOWN',
      mappedStatus: this.nextStatus,
      refId: params.refId,
      sn: this.nextStatus === 'SUCCESS' ? 'SN-123456' : undefined,
      message: this.nextStatus === 'FAILED' ? 'Nomor tujuan salah (definitif)' : this.nextStatus,
    };
  }
  async inquireTransaction(params: { refId: string }): Promise<DigiflazzTxResponse> {
    this.inquiryCount++;
    return {
      ok: this.nextStatus !== 'UNKNOWN',
      mappedStatus: this.nextStatus,
      refId: params.refId,
      sn: this.nextStatus === 'SUCCESS' ? 'SN-INQ-999' : undefined,
      message: this.nextStatus === 'FAILED' ? 'Gagal definitif' : this.nextStatus,
    };
  }
  async checkBalance() {
    return { ok: true, balance: 500000 };
  }
}

test('Setup DB and run migrations', () => {
  const db = getDb();
  runMigrations(db);
  assert.equal(verifyDatabaseIntegrity(db), true);
});

test('Scenario A & F: Full order -> coupon -> unique code -> anti-double-order -> verified callback -> idempotent duplicate -> Digiflazz success', async () => {
  const cats = listCategories(true);
  const prod = upsertProduct(
    {
      sku: 'TSEL10',
      name: 'Pulsa Telkomsel 10.000',
      categoryId: cats[0].id,
      supplierPrice: 10200,
      marginType: 'FIXED',
      marginValue: 1000,
    },
    { id: 'test', role: 'OWNER' }
  );
  assert.equal(prod.selling_price, 11200);

  createCoupon(
    {
      code: 'HEMAT500',
      name: 'Diskon 500',
      discountType: 'FIXED',
      discountValue: 500,
      minPurchase: 10000,
      claimLimit: 2,
      startsAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2028-01-01T00:00:00.000Z',
    },
    { id: 'test', role: 'OWNER' }
  );

  const gw = new TestPaymentGateway();
  const order1 = await createOrder(
    {
      platform: 'WHATSAPP',
      platformUserId: '081234567890',
      productSkuOrId: 'TSEL10',
      destination: '081234567890',
      couponCode: 'HEMAT500',
      idempotencyKey: 'idem-order-1',
    },
    gw
  );
  assert.equal(order1.ok, true);
  assert.ok(order1.transaction);
  assert.ok(order1.transaction.unique_code >= 1 && order1.transaction.unique_code <= 99);
  assert.equal(order1.transaction.discount_snapshot, 500);
  assert.equal(
    order1.transaction.payment_amount,
    11200 - 500 + order1.transaction.unique_code
  );

  // Anti-Double-Order: second order for same customer rejected while first is active
  const order2 = await createOrder(
    {
      platform: 'WHATSAPP',
      platformUserId: '6281234567890',
      productSkuOrId: 'TSEL10',
      destination: '081234567890',
    },
    gw
  );
  assert.equal(order2.ok, false);
  assert.equal(order2.code, 'ACTIVE_INVOICE_EXISTS');

  // Invalid callback signature rejected
  const payloadObj = {
    event_id: 'evt-100',
    reference: order1.transaction.gateway_reference,
    order_id: order1.transaction.transaction_id,
    amount: order1.transaction.payment_amount,
    status: 'PAID',
  };
  const rawBody = JSON.stringify(payloadObj);
  const badCb = await processGatewayCallback(
    { 'x-callback-signature': 'wrong-sig' },
    rawBody,
    payloadObj,
    gw
  );
  assert.equal(badCb.statusCode, 401);

  // Valid callback processed once
  const sig = crypto
    .createHmac('sha256', process.env.PAYMENT_GATEWAY_CALLBACK_SECRET!)
    .update(rawBody)
    .digest('hex');
  const goodCb = await processGatewayCallback(
    { 'x-callback-signature': sig },
    rawBody,
    payloadObj,
    gw
  );
  assert.equal(goodCb.statusCode, 200);
  assert.equal(goodCb.body.duplicate, undefined);

  // Duplicate callback detected & ignored idempotently
  const dupCb = await processGatewayCallback(
    { 'x-callback-signature': sig },
    rawBody,
    payloadObj,
    gw
  );
  assert.equal(dupCb.statusCode, 200);
  assert.equal(dupCb.body.duplicate, true);

  // Supplier processing succeeds once
  const digi = new TestDigiflazzPort();
  digi.nextStatus = 'SUCCESS';
  const supSvc = new DigiflazzService(digi);
  const jobRes = await processSingleSupplierJob(order1.transaction.transaction_id, 'test-worker', supSvc);
  assert.equal(jobRes.handled, true);
  assert.equal(jobRes.status, 'SUCCESS');
  assert.equal(digi.purchaseCount, 1);
});

test('Scenario C & D: Supplier PENDING never refunds or double-buys; definitive FAILED triggers single immutable refund', async () => {
  const gw = new TestPaymentGateway();
  const order = await createOrder(
    {
      platform: 'TELEGRAM',
      platformUserId: '99887766',
      productSkuOrId: 'TSEL10',
      destination: '081111222333',
    },
    gw
  );
  assert.equal(order.ok, true);
  const txId = order.transaction!.transaction_id;

  const payload = {
    event_id: `evt-${txId}`,
    reference: order.transaction!.gateway_reference,
    order_id: txId,
    amount: order.transaction!.payment_amount,
    status: 'PAID',
  };
  const raw = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha256', process.env.PAYMENT_GATEWAY_CALLBACK_SECRET!)
    .update(raw)
    .digest('hex');
  await processGatewayCallback({ 'x-callback-signature': sig }, raw, payload, gw);

  const digi = new TestDigiflazzPort();
  digi.nextStatus = 'PENDING';
  const supSvc = new DigiflazzService(digi);

  const res1 = await processSingleSupplierJob(txId, 'worker-1', supSvc);
  assert.equal(res1.status, 'PENDING');
  assert.equal(digi.purchaseCount, 1);

  // Attempting refund while PENDING must be rejected
  const pendingRefund = processAutomaticRefund(txId, 'test');
  assert.equal(pendingRefund.ok, false);

  // Force next_attempt_at due and transition to UNKNOWN -> still NO refund and uses inquiry (purchaseCount stays 1!)
  const db = getDb();
  db.prepare('UPDATE supplier_jobs SET next_attempt_at = ? WHERE transaction_id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    txId
  );
  digi.nextStatus = 'UNKNOWN';
  const res2 = await processSingleSupplierJob(txId, 'worker-1', supSvc);
  assert.equal(res2.status, 'UNKNOWN');
  assert.equal(digi.purchaseCount, 1);
  assert.equal(digi.inquiryCount, 1);
  assert.equal(processAutomaticRefund(txId, 'test').ok, false);

  // Now supplier reports definitive FAILED -> automatic internal refund processed once!
  db.prepare('UPDATE supplier_jobs SET next_attempt_at = ? WHERE transaction_id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    txId
  );
  digi.nextStatus = 'FAILED';
  const res3 = await processSingleSupplierJob(txId, 'worker-1', supSvc);
  assert.equal(res3.status, 'FAILED');
  assert.equal(digi.purchaseCount, 1);
  assert.equal(digi.inquiryCount, 2);

  // Verify idempotency: second refund call must not double-credit
  const dupRefund = processAutomaticRefund(txId, 'test-again');
  assert.equal(dupRefund.ok, false);
  assert.equal(dupRefund.alreadyRefunded, true);

  const cusBalance = getCustomerRefundCreditTotal(order.transaction!.customer_id);
  assert.equal(cusBalance, order.transaction!.payment_amount);

  // Verify refund_ledger is immutable at SQLite trigger level
  assert.throws(() => {
    db.prepare('UPDATE refund_ledger SET amount = 1 WHERE transaction_id = ?').run(txId);
  });
  assert.throws(() => {
    db.prepare('DELETE FROM refund_ledger WHERE transaction_id = ?').run(txId);
  });

  // Verify manual adjustment requires valid reason
  assert.throws(() => {
    applyManualRefundOrAdjustment(
      {
        customerId: order.transaction!.customer_id,
        entryType: 'MANUAL_ADJUSTMENT_CREDIT',
        amount: 100,
        reason: 'no',
      },
      { id: 'testowner', role: 'OWNER' }
    );
  });
});

test('Scenario B: Invoice 5-min expiry verifies gateway first and triggers 30s cooldown', async () => {
  const gw = new TestPaymentGateway();
  const order = await createOrder(
    {
      platform: 'WHATSAPP',
      platformUserId: '085555666777',
      productSkuOrId: 'TSEL10',
      destination: '085555666777',
    },
    gw
  );
  assert.equal(order.ok, true);

  const outcome = await finalizeExpiredInvoice(order.transaction!, 'EXPIRY_WORKER', gw);
  assert.equal(outcome, 'EXPIRED');
  assert.equal(gw.cancelCalls, 1);

  // Cooldown 30s must block immediate second order
  const blocked = await createOrder(
    {
      platform: 'WHATSAPP',
      platformUserId: '085555666777',
      productSkuOrId: 'TSEL10',
      destination: '085555666777',
    },
    gw
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'COOLDOWN_ACTIVE');
});

test('Account linking WA <-> TG links single customer_id and prevents duplicate use', () => {
  const linkReq = requestAccountLinkCode({
    platform: 'WHATSAPP',
    platformUserId: '087777888999',
  });
  assert.equal(linkReq.ok, true);
  assert.ok(linkReq.code);

  // Same platform verification must fail
  const samePlatform = verifyAndLinkAccount({
    targetPlatform: 'WHATSAPP',
    targetPlatformUserId: '087777888999',
    rawCode: linkReq.code!,
  });
  assert.equal(samePlatform.ok, false);

  // Cross-platform verification succeeds
  const linked = verifyAndLinkAccount({
    targetPlatform: 'TELEGRAM',
    targetPlatformUserId: '44556677',
    rawCode: linkReq.code!,
  });
  assert.equal(linked.ok, true);

  const waCus = resolveOrCreateCustomer({ platform: 'WHATSAPP', platformUserId: '087777888999' });
  const tgCus = resolveOrCreateCustomer({ platform: 'TELEGRAM', platformUserId: '44556677' });
  assert.equal(waCus.customer.id, tgCus.customer.id);

  // Code cannot be reused
  const reuse = verifyAndLinkAccount({
    targetPlatform: 'TELEGRAM',
    targetPlatformUserId: '11223344',
    rawCode: linkReq.code!,
  });
  assert.equal(reuse.ok, false);
});

test('Maintenance mode blocks new orders while allowing reconciliation and backup', async () => {
  const gw = new TestPaymentGateway();
  const pendingOrder = await createOrder(
    {
      platform: 'WHATSAPP',
      platformUserId: '089999000111',
      productSkuOrId: 'TSEL10',
      destination: '089999000111',
    },
    gw
  );
  assert.equal(pendingOrder.ok, true);

  setMaintenanceMode(true, { id: 'testowner', role: 'OWNER' }, 'Test maintenance');

  const blocked = await createOrder(
    {
      platform: 'WHATSAPP',
      platformUserId: '082222333444',
      productSkuOrId: 'TSEL10',
      destination: '082222333444',
    },
    gw
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'MAINTENANCE_ACTIVE');

  // Pending invoice marked UNKNOWN can still reconcile to PAID during maintenance
  transitionTransactionStatus(pendingOrder.transaction!.transaction_id, 'UNKNOWN', 'TEST', 'Simulate missed callback');
  gw.statusByRef.set(pendingOrder.transaction!.gateway_reference!, 'PAID');
  const rec = await reconcileUnknownAndMissedCallbacks(gw);
  assert.equal(rec.recoveredPaid, 1);

  setMaintenanceMode(false, { id: 'testowner', role: 'OWNER' }, 'Restore');

  const backupRes = await runDatabaseBackup('MANUAL', { id: 'testowner', role: 'OWNER' });
  assert.equal(backupRes.ok, true);
  assert.ok(backupRes.filePath && fs.existsSync(backupRes.filePath));
});

test('Admin management: create, owner lockout protection, identity binding, and reset', () => {
  const initialAdmins = listAdmins();
  assert.equal(initialAdmins.length, 1);
  const primaryOwner = initialAdmins[0];

  // Must forbid disabling or demoting the last active OWNER
  assert.throws(() => {
    updateAdminRole(primaryOwner.id, 'OPERATOR', 'ACTIVE', { id: 'testowner', role: 'OWNER' });
  });
  assert.throws(() => {
    updateAdminRole(primaryOwner.id, 'OWNER', 'DISABLED', { id: 'testowner', role: 'OWNER' });
  });

  // Create extra operator with Telegram ID
  const operator = createAdmin(
    { name: 'Shift Operator', role: 'OPERATOR', platform: 'TELEGRAM', platformUserId: '987654321' },
    { id: 'testowner', role: 'OWNER' }
  );
  assert.equal(operator.role, 'OPERATOR');
  assert.equal(operator.identities.length, 1);

  addAdminIdentity(operator.id, 'WHATSAPP', '081234567890', { id: 'testowner', role: 'OWNER' });
  const afterAdd = listAdmins().find((a) => a.id === operator.id)!;
  assert.equal(afterAdd.identities.length, 2);

  const waId = afterAdd.identities.find((i) => i.platform === 'WHATSAPP')!;
  removeAdminIdentity(operator.id, waId.id, { id: 'testowner', role: 'OWNER' });
  assert.equal(listAdmins().find((a) => a.id === operator.id)!.identities.length, 1);

  // Sync owner from env preserves operator while adding missing owner identities
  const synced = resetAdminsAndSyncOwner(
    'SYNC_OWNER_FROM_ENV',
    { id: 'testowner', role: 'OWNER' },
    { dashboardUser: 'testowner', ownerWhatsappJid: '6289988776655', ownerTelegramId: '1122334455' }
  );
  assert.equal(synced.length, 2);
  assert.equal(synced[0].identities.length, 3);

  // Full reset removes additional admins and rebuilds Primary Owner cleanly from env
  const reset = resetAdminsAndSyncOwner(
    'RESET_TO_PRIMARY_OWNER',
    { id: 'testowner', role: 'OWNER' },
    { dashboardUser: 'testowner', ownerWhatsappJid: '6289988776655', ownerTelegramId: '1122334455' }
  );
  assert.equal(reset.length, 1);
  assert.equal(reset[0].role, 'OWNER');
  assert.equal(reset[0].status, 'ACTIVE');
  assert.equal(reset[0].identities.length, 3);
});

test('Margin cap: Global and Category PERCENT margins respect optional maxMargin cap and recalculate product selling prices', () => {
  const cats = listCategories(true);
  const catId = cats[0].id;
  const actor = { id: 'testowner', role: 'OWNER' as const };

  // Create high-cost (20.000) and low-cost (5.000) products inheriting global/category margin
  const highProd = upsertProduct(
    {
      sku: 'PLN20',
      name: 'Token PLN 20.000',
      categoryId: catId,
      supplierPrice: 20000,
    },
    actor
  );
  const lowProd = upsertProduct(
    {
      sku: 'PULSA5',
      name: 'Pulsa 5.000',
      categoryId: catId,
      supplierPrice: 5000,
    },
    actor
  );

  // Set global margin 30% max Rp3.000
  setGlobalMargin('PERCENT', 30, actor, 3000);
  const globalRule = getGlobalMarginRule();
  assert.equal(globalRule.type, 'PERCENT');
  assert.equal(globalRule.value, 30);
  assert.equal(globalRule.maxMargin, 3000);

  const prodsAfterGlobal = listProducts({ onlyActive: false }).items;
  const highAfterGlobal = prodsAfterGlobal.find((p) => p.id === highProd.id)!;
  const lowAfterGlobal = prodsAfterGlobal.find((p) => p.id === lowProd.id)!;
  // 30% of 20.000 = 6.000 -> capped at 3.000 => 23.000
  assert.equal(highAfterGlobal.selling_price, 23000);
  // 30% of 5.000 = 1.500 (< 3.000) => 6.500
  assert.equal(lowAfterGlobal.selling_price, 6500);

  // Category override 30% max Rp2.000 -> highProd capped at 22.000, lowProd 6.500
  setCategoryMargin(catId, 'PERCENT', 30, actor, 2000);
  const prodsAfterCat = listProducts({ onlyActive: false }).items;
  assert.equal(prodsAfterCat.find((p) => p.id === highProd.id)!.selling_price, 22000);
  assert.equal(prodsAfterCat.find((p) => p.id === lowProd.id)!.selling_price, 6500);

  // Clearing category margin reverts back to global 30% max Rp3.000
  setCategoryMargin(catId, null, null, actor, null);
  const prodsAfterClear = listProducts({ onlyActive: false }).items;
  assert.equal(prodsAfterClear.find((p) => p.id === highProd.id)!.selling_price, 23000);

  const history = listMarginHistory(5) as Array<{ new_max_margin?: number | null }>;
  assert.ok(history.some((h) => h.new_max_margin === 3000));
});

test('Bot Demo Simulator: simulates WhatsApp & Telegram replies, inline callbacks, RBAC, and dry-run order QRIS without DB mutation', async () => {
  const db = getDb();
  const txCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM transactions').get() as { cnt: number }).cnt;

  // WhatsApp menu with friendly copy & clickable quick-reply buttons
  const waMenu = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: 'menu',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(waMenu.replies.length, 1);
  assert.match(waMenu.replies[0].text, /Menu Utama/);
  assert.ok(waMenu.replies[0].buttons && waMenu.replies[0].buttons.length >= 2);

  // Unknown input returns warm message + clickable menu buttons
  const waUnknown = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: 'halo apakabar',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.ok(waUnknown.replies[0].buttons && waUnknown.replies[0].buttons.length >= 2);

  // Guided WhatsApp product selection -> destination entry without typing "order"
  const waSelectProd = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: 'pilih TSEL10',
    senderId: '628111222333',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(waSelectProd.replies[0].text, /nomor tujuan/i);

  const waOrder = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '081234567890',
    senderId: '628111222333',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(waOrder.replies.length, 1);
  assert.ok(waOrder.replies[0].imageDataUrl?.startsWith('data:image/png;base64,'));
  assert.match(waOrder.replies[0].text, /INVOICE PEMBAYARAN QRIS/);
  assert.ok(waOrder.replies[0].buttons && waOrder.replies[0].buttons.length >= 1);

  // Customer role must be denied !admin
  const waAdminDenied = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!admin',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(waAdminDenied.replies[0].text, /ditolak/i);

  // Admin role allowed !admin
  const waAdminOk = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'ADMIN',
    inputType: 'TEXT',
    text: '!admin',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(waAdminOk.replies[0].text, /Panel Admin WhatsApp/);

  // Telegram /menu with inline buttons & callback click -> BUY_SKU_TSEL10 -> send number directly
  const tgMenu = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '/menu',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(tgMenu.replies.length, 1);
  assert.ok(tgMenu.replies[0].buttons && tgMenu.replies[0].buttons.length >= 2);

  const tgCb = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: 'CAT_LIST',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(tgCb.replies.length, 1);
  assert.match(tgCb.replies[0].text, /Pilih kategori produk/i);
  assert.ok(tgCb.replies[0].buttons && tgCb.replies[0].buttons.length >= 1);

  const tgPickSku = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: 'BUY_SKU_TSEL10',
    senderId: '555666',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(tgPickSku.replies[0].text, /kirimkan nomor tujuan/i);

  const tgDest = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '081234567890',
    senderId: '555666',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.ok(tgDest.replies.some((r) => r.imageDataUrl?.startsWith('data:image/png;base64,')));

  // Confirm dry-run order did not insert any row into transactions table
  const txCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM transactions').get() as { cnt: number }).cnt;
  assert.equal(txCountAfter, txCountBefore);

  // Confirm Telegram callback invokes deleteSourceMessage so previous message is deleted
  const { dispatchTelegramCallback } = await import('../bots/telegram.callback-handler');
  let deletedPrevCount = 0;
  let repliedText = '';
  await dispatchTelegramCallback(
    {
      async reply(text) {
        repliedText = text;
      },
      async answerCbQuery() {},
      async deleteSourceMessage() {
        deletedPrevCount++;
      },
    },
    { data: 'CAT_LIST', userId: '555666', username: 'Tester' },
    { dryRun: true }
  );
  assert.equal(deletedPrevCount, 1);
  assert.match(repliedText, /Pilih kategori produk/i);
});

test('HTTP Basic Auth, RBAC, Health, and absence of deposit routes', async () => {
  const app = createExpressApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // Unauthenticated admin request rejected
    const unauth = await fetch(`${base}/api/admin/overview`);
    assert.equal(unauth.status, 401);

    // Invalid Basic Auth rejected
    const badCreds = Buffer.from('testowner:wrong-pass').toString('base64');
    const badAuth = await fetch(`${base}/api/admin/overview`, {
      headers: { Authorization: `Basic ${badCreds}` },
    });
    assert.equal(badAuth.status, 401);

    // Valid Basic Auth succeeds even when X-Forwarded-For and Forwarded headers are present
    const goodCreds = Buffer.from('testowner:test-strong-password-999').toString('base64');
    const okRes = await fetch(`${base}/api/admin/overview`, {
      headers: {
        Authorization: `Basic ${goodCreds}`,
        'X-Forwarded-For': '203.0.113.10, 10.0.0.1',
        Forwarded: 'for="203.0.113.10";proto=https',
      },
    });
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as { ok: boolean; data: { metrics: unknown } };
    assert.equal(body.ok, true);

    // authRateLimiter handles Forwarded + X-Forwarded-For without ValidationError
    const loginAttempt = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${goodCreds}`,
        'X-Forwarded-For': '203.0.113.11',
        Forwarded: 'for="[2001:db8::1]:443";proto=https',
      },
    });
    assert.equal(loginAttempt.status, 200);

    // Bot Demo HTTP endpoint returns simulated bot reply
    const demoRes = await fetch(`${base}/api/admin/bots/demo`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${goodCreds}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platform: 'TELEGRAM',
        senderRole: 'CUSTOMER',
        inputType: 'TEXT',
        text: '/menu',
      }),
    });
    assert.equal(demoRes.status, 200);
    const demoBody = (await demoRes.json()) as { ok: boolean; data: { replies: Array<{ text: string }> } };
    assert.equal(demoBody.ok, true);
    assert.match(demoBody.data.replies[0].text, /PPOB Bot Ecosystem/);

    // Health endpoint exposes safe status without secrets
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthText = await health.text();
    assert.equal(healthText.includes('test-strong-password-999'), false);
    assert.equal(healthText.includes('test-cb-secret'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
