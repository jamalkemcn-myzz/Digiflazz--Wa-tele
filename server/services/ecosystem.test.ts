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
import { upsertProduct, listCategories, listProducts, getGlobalMarginRule, deleteProductSafely } from './product.service';
import { setGlobalMargin, setCategoryMargin, listMarginHistory } from './margin.service';
import { createCoupon } from './coupon.service';
import {
  createOrder,
  handleVerifiedPaymentPaid,
  processSingleSupplierJob,
  transitionTransactionStatus,
  cancelCustomerTransaction,
} from './transaction.service';
import { processGatewayCallback, finalizeExpiredInvoice } from './payment.service';
import { reconcileUnknownAndMissedCallbacks } from './payment.reconciliation.service';
import { processAutomaticRefund, applyManualRefundOrAdjustment } from './refund.service';
import {
  requestAccountLinkCode,
  verifyAndLinkAccount,
  resolveOrCreateCustomer,
  getCustomerRefundCreditTotal,
  listCustomersDetailed,
} from './customer.service';
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
import { MyZZStoreGateway, type PaymentGatewayPort, type GatewayPaymentState } from '../integrations/myzzstore.gateway';
import { fetchQrisImageBuffer } from '../integrations/qris-image';
import { runDigiflazzPriceSync } from '../integrations/digiflazz.price-sync';
import { DigiflazzService } from '../integrations/digiflazz.service';
import { DigiflazzClient, type DigiflazzPort, type DigiflazzTxResponse } from '../integrations/digiflazz.client';

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

  // WhatsApp menu with friendly copy & clickable quick-reply buttons (requires ! or . prefix)
  const waMenu = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!menu',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(waMenu.replies.length, 1);
  assert.match(waMenu.replies[0].text, /Selamat datang di/i);
  assert.ok(waMenu.replies[0].buttons && waMenu.replies[0].buttons.length === 3);

  // Input without prefix must be silently ignored on WhatsApp
  const waNoPrefix = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: 'halo apakabar',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(waNoPrefix.replies.length, 0);

  // Unknown prefixed command returns warm message + clickable menu buttons
  const waUnknown = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!tidakada',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.ok(waUnknown.replies[0].buttons && waUnknown.replies[0].buttons.length >= 2);

  // Guided WhatsApp product selection -> destination entry with prefix
  const waSelectProd = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!pilih TSEL10',
    senderId: '628111222333',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(waSelectProd.replies[0].text, /nomor tujuan/i);

  const waConfirmPrompt = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!081234567890',
    senderId: '628111222333',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(waConfirmPrompt.replies.length, 1);
  assert.match(waConfirmPrompt.replies[0].text, /Konfirmasi Pesanan/i);
  const waConfirmBtns = (waConfirmPrompt.replies[0].buttons || []).flat().map((b) => b.replyText);
  assert.ok(waConfirmBtns.includes('!ya'));
  assert.ok(waConfirmBtns.includes('!batal'));

  // Confirming with "!ya" proceeds to generate the QRIS invoice
  const waOrder = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!ya',
    senderId: '628111222333',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.equal(waOrder.replies.length, 1);
  assert.ok(waOrder.replies[0].imageDataUrl?.startsWith('data:image/png;base64,'));
  assert.match(waOrder.replies[0].text, /INVOICE PEMBAYARAN QRIS/);
  assert.ok(waOrder.replies[0].buttons && waOrder.replies[0].buttons.length >= 1);

  // Cancelling during WhatsApp confirmation aborts before QRIS creation
  await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!order TSEL10 081234567899',
    senderId: '628111222444',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  const waCancelConfirm = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!batal',
    senderId: '628111222444',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(waCancelConfirm.replies[0].text, /dibatalkan sebelum QRIS dibuat/i);

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

  const tgConfirmPrompt = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '081234567890',
    senderId: '555666',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(tgConfirmPrompt.replies[0].text, /Konfirmasi Pesanan/i);
  const tgConfirmBtns = (tgConfirmPrompt.replies[0].buttons || []).flat().map((b) => b.callbackData);
  assert.ok(tgConfirmBtns.includes('CONFIRM_ORDER'));
  assert.ok(tgConfirmBtns.includes('CANCEL_CONFIRM_ORDER'));

  const tgDest = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: 'CONFIRM_ORDER',
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
    assert.match(demoBody.data.replies[0].text, /Layanan Pelanggan/);

    // Health endpoint exposes safe status without secrets
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthText = await health.text();
    assert.equal(healthText.includes('test-strong-password-999'), false);
    assert.equal(healthText.includes('test-cb-secret'), false);

    // Users list endpoint returns detailed customers & stats
    const usersRes = await fetch(`${base}/api/admin/users?page=1&limit=20`, {
      headers: { Authorization: `Basic ${goodCreds}` },
    });
    assert.equal(usersRes.status, 200);
    const usersBody = (await usersRes.json()) as {
      ok: boolean;
      data: { items: Array<{ customer_code: string; identities: unknown[] }>; pagination: { total: number } };
    };
    assert.equal(usersBody.ok, true);
    assert.ok(usersBody.data.items.length >= 1);
    assert.ok(usersBody.data.pagination.total >= 1);

    // Delete unused product via HTTP endpoint
    const tempProd = upsertProduct(
      {
        sku: 'TEMP-DEL-HTTP',
        name: 'Produk Sementara Hapus',
        categoryId: listCategories(true)[0].id,
        supplierPrice: 5000,
      },
      { id: 'testowner', role: 'OWNER' }
    );
    const delRes = await fetch(`${base}/api/admin/products/${tempProd.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${goodCreds}` },
    });
    assert.equal(delRes.status, 200);
    const delBody = (await delRes.json()) as { ok: boolean; data: { sku: string } };
    assert.equal(delBody.ok, true);
    assert.equal(delBody.data.sku, 'TEMP-DEL-HTTP');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Product sync deletes unavailable items and preserves ordered SKU safety; deleteProductSafely enforces FK guard', async () => {
  const actor = { id: 'testowner', role: 'OWNER' as const };
  const catId = listCategories(true)[0].id;

  const unusedProd = upsertProduct(
    { sku: 'SYNC-OBSOLETE-1', name: 'Produk Hilang Saat Sync', categoryId: catId, supplierPrice: 4000 },
    actor
  );
  const unavailableProd = upsertProduct(
    { sku: 'SYNC-OFF-2', name: 'Produk Nonaktif Supplier', categoryId: catId, supplierPrice: 5000 },
    actor
  );

  // deleteProductSafely rejects product referenced by historical transactions (TSEL10)
  const usedProd = listProducts({ search: 'TSEL10', onlyActive: false }).items.find((p) => p.sku === 'TSEL10')!;
  assert.throws(() => deleteProductSafely(usedProd.id, actor), /transaksi terkait/i);

  // Custom mock Digiflazz returning PLN20 + PULSA5 as available, SYNC-OFF-2 unavailable, SYNC-OBSOLETE-1 absent
  const syncMock: DigiflazzPort = {
    isConfigured: () => true,
    async fetchPriceList() {
      return {
        ok: true,
        items: [
          {
            buyer_sku_code: 'PLN20',
            product_name: 'Token PLN 20.000',
            category: 'PLN',
            brand: 'PLN',
            type: 'Umum',
            price: 20100,
            buyer_product_status: true,
            seller_product_status: true,
          },
          {
            buyer_sku_code: 'SYNC-OFF-2',
            product_name: 'Produk Nonaktif Supplier',
            category: 'Pulsa',
            brand: 'TELKOMSEL',
            type: 'Umum',
            price: 5000,
            buyer_product_status: true,
            seller_product_status: false,
          },
        ],
      };
    },
    async createTransaction(p) {
      return { ok: true, mappedStatus: 'SUCCESS', refId: p.refId };
    },
    async inquireTransaction(p) {
      return { ok: true, mappedStatus: 'SUCCESS', refId: p.refId };
    },
    async checkBalance() {
      return { ok: true, balance: 100000 };
    },
  };

  const syncRes = await runDigiflazzPriceSync(syncMock, 'MANUAL');
  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.successCount, 1);
  assert.ok(syncRes.deletedCount >= 2);

  const afterList = listProducts({ onlyActive: false, limit: 100 }).items;
  assert.equal(afterList.some((p) => p.id === unusedProd.id), false);
  assert.equal(afterList.some((p) => p.id === unavailableProd.id), false);
  // Historically ordered TSEL10 kept intact as INACTIVE for FK safety
  const tselAfter = afterList.find((p) => p.id === usedProd.id)!;
  assert.equal(tselAfter.status, 'INACTIVE');
  assert.equal(tselAfter.is_available, 0);

  // Re-activate TSEL10 for subsequent tests
  upsertProduct(
    {
      sku: 'TSEL10',
      name: 'Pulsa Telkomsel 10.000',
      categoryId: catId,
      supplierPrice: 10200,
      marginType: 'FIXED',
      marginValue: 1000,
    },
    actor
  );
});

test('Customer cancel enforces 30s delay rule after creation and succeeds once elapsed', async () => {
  const gw = new TestPaymentGateway();
  const order = await createOrder(
    {
      platform: 'TELEGRAM',
      platformUserId: '77665544',
      productSkuOrId: 'TSEL10',
      destination: '081299988877',
    },
    gw
  );
  assert.equal(order.ok, true);
  const txId = order.transaction!.transaction_id;

  // Immediate cancel (< 30s) must be rejected with TOO_EARLY
  const tooEarly = await cancelCustomerTransaction(
    { platform: 'TELEGRAM', platformUserId: '77665544', transactionId: txId },
    gw
  );
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.code, 'TOO_EARLY');
  assert.ok((tooEarly.remainingWaitSeconds ?? 0) >= 1);

  // Backdate created_at by 35 seconds
  const db = getDb();
  const backdated = new Date(Date.now() - 35_000).toISOString();
  db.prepare('UPDATE transactions SET created_at = ? WHERE transaction_id = ?').run(backdated, txId);

  const cancelled = await cancelCustomerTransaction(
    { platform: 'TELEGRAM', platformUserId: '77665544', transactionId: txId },
    gw
  );
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.transaction?.transaction_status, 'CANCELLED');
  assert.equal(gw.cancelCalls, 1);
});

test('Product buttons display friendly product names instead of raw Digiflazz SKUs', async () => {
  const actor = { id: 'testowner', role: 'OWNER' as const };
  const catId = listCategories(true)[0].id;
  upsertProduct(
    {
      sku: 'pre35866129',
      name: 'Paket Data Freedom 10GB',
      categoryId: catId,
      supplierPrice: 25000,
    },
    actor
  );

  // Telegram category listing should display "Paket Data Freedom 10GB" on button, NOT raw "pre35866129"
  const tgCat = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: `CAT_${catId}`,
    actor,
  });
  const tgBtnTexts = (tgCat.replies[0].buttons || []).flat().map((b) => b.text);
  assert.ok(tgBtnTexts.some((t) => t.includes('Paket Data Freedom 10GB')));
  assert.equal(tgBtnTexts.some((t) => t.toLowerCase().includes('pre35866129')), false);

  // WhatsApp product listing should also avoid raw SKU on interactive buttons
  const waList = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!produk',
    actor,
  });
  const waBtnTexts = (waList.replies[0].buttons || []).flat().map((b) => b.text);
  assert.ok(waBtnTexts.some((t) => t.includes('Paket Data Freedom 10GB')));
  assert.equal(waBtnTexts.some((t) => t.toLowerCase().includes('pre35866129')), false);

  // Verify detailed user list includes customers with identities
  const users = listCustomersDetailed({ page: 1, limit: 20 });
  assert.ok(users.items.length >= 1);
  assert.ok(Array.isArray(users.items[0].identities));
});

test('MyZZStoreGateway uses GET /create-qris and /check-payment, extracts data.trx_id & data.qris_url, and fetches QRIS buffer', async () => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const capturedRequests: Array<{ method?: string; path?: string; query: URLSearchParams }> = [];

  const mockGatewayServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    capturedRequests.push({
      method: req.method,
      path: parsedUrl.pathname,
      query: parsedUrl.searchParams,
    });

    if (parsedUrl.pathname === '/create-qris') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'success',
          data: {
            trx_id: 'MZ-TRX-889900',
            qris_url: `http://127.0.0.1:${(mockGatewayServer.address() as { port: number }).port}/qris-image.png`,
            amount: 11245,
            status: 'PENDING',
          },
        })
      );
      return;
    }

    if (parsedUrl.pathname === '/check-payment') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'success',
          data: {
            trx_id: parsedUrl.searchParams.get('trx_id'),
            status: 'LUNAS',
            amount: 11245,
            paid_at: '2026-11-15T10:00:00.000Z',
          },
        })
      );
      return;
    }

    if (parsedUrl.pathname === '/qris-image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(pngBytes);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockGatewayServer.listen(0, '127.0.0.1', resolve));
  const port = (mockGatewayServer.address() as { port: number }).port;

  process.env.PAYMENT_GATEWAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.PAYMENT_GATEWAY_API_KEY = 'test-api-key';
  process.env.PAYMENT_GATEWAY_SECRET = 'test-secret';
  process.env.PAYMENT_GATEWAY_MERCHANT_ID = 'MERCHANT01';
  process.env.PAYMENT_GATEWAY_CREATE_PATH = '/create-qris';
  process.env.PAYMENT_GATEWAY_STATUS_PATH = '/check-payment';
  refreshConfig(process.env);

  try {
    const gateway = new MyZZStoreGateway();
    const created = await gateway.createPayment({
      transactionId: 'TRX-TEST-GW-1',
      amount: 11245,
      productName: 'Pulsa 10.000',
      customerCode: 'CUS-1234',
      expiredAt: '2026-11-15T10:05:00.000Z',
      callbackUrl: 'https://example.com/callback',
    });

    assert.equal(created.ok, true);
    assert.equal(created.gatewayReference, 'MZ-TRX-889900');
    assert.equal(created.qrUrl, `http://127.0.0.1:${port}/qris-image.png`);
    assert.equal(capturedRequests[0].method, 'GET');
    assert.equal(capturedRequests[0].path, '/create-qris');
    assert.equal(capturedRequests[0].query.get('amount'), '11245');

    // Verify QRIS image downloads cleanly into Buffer
    const imgBuf = await fetchQrisImageBuffer(created.qrUrl!);
    assert.equal(Buffer.isBuffer(imgBuf), true);
    assert.equal(imgBuf.equals(pngBytes), true);

    // Verify checkPaymentStatus sends GET /check-payment?trx_id=MZ-TRX-889900 and recognizes LUNAS
    const statusRes = await gateway.checkPaymentStatus(created.gatewayReference!, 'TRX-TEST-GW-1');
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.mappedStatus, 'PAID');
    assert.equal(statusRes.gatewayReference, 'MZ-TRX-889900');
    assert.equal(capturedRequests[2].method, 'GET');
    assert.equal(capturedRequests[2].path, '/check-payment');
    assert.equal(capturedRequests[2].query.get('trx_id'), 'MZ-TRX-889900');
  } finally {
    await new Promise<void>((resolve) => mockGatewayServer.close(() => resolve()));
  }
});

test('sendTelegramQrisInvoice recovers from Telegraf sendPhoto socket hang up via direct IPv4 Content-Length upload', async () => {
  const { sendTelegramQrisInvoice } = await import('../bots/telegram.notification.service');
  let receivedContentLength: string | undefined;
  let receivedRawBody = '';

  const mockTgServer = http.createServer((req, res) => {
    receivedContentLength = req.headers['content-length'];
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      receivedRawBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 4242 } }));
    });
  });

  await new Promise<void>((resolve) => mockTgServer.listen(0, '127.0.0.1', resolve));
  const port = (mockTgServer.address() as { port: number }).port;

  let textFallbackCalled = false;
  const fakeBot = {
    telegram: {
      token: '999999:testtoken',
      options: { apiRoot: `http://127.0.0.1:${port}` },
      async sendPhoto() {
        throw new Error('request to https://api.telegram.org/bot999999:[REDACTED]/sendPhoto failed, reason: socket hang up');
      },
      async sendMessage() {
        textFallbackCalled = true;
        return { message_id: 1 };
      },
    },
  } as unknown as import('telegraf').Telegraf;

  try {
    const msgId = await sendTelegramQrisInvoice(
      fakeBot,
      '123456789',
      'Invoice QRIS #1',
      { qrString: '00020101021226TEST' }
    );
    assert.equal(msgId, 4242);
    assert.equal(textFallbackCalled, false);
    assert.ok(Number(receivedContentLength) > 0);
    assert.match(receivedRawBody, /name="photo"; filename="qris\.png"/);
    assert.match(receivedRawBody, /Invoice QRIS #1/);
  } finally {
    await new Promise<void>((resolve) => mockTgServer.close(() => resolve()));
  }
});

test('Gateway trx_id polling, ?format=raw QRIS download, original payment link in invoice, /batal & batal, and Vite allowedHosts', async () => {
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const pollQueries: URLSearchParams[] = [];
  let qrisRequestFormatParam: string | null = null;
  let gatewayShouldReturnPaid = false;

  let qrisSeq = 0;
  let lastCreatedTrxId = 'MZ-POLL-998877-1';
  const mockServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (parsedUrl.pathname === '/create-qris') {
      qrisSeq++;
      lastCreatedTrxId = `MZ-POLL-998877-${qrisSeq}`;
      const port = (mockServer.address() as { port: number }).port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'success',
          data: {
            trx_id: lastCreatedTrxId,
            qris_url: `http://127.0.0.1:${port}/pay/${lastCreatedTrxId}`,
            amount: Number(parsedUrl.searchParams.get('amount') || 11200),
            status: 'PENDING',
          },
        })
      );
      return;
    }

    if (parsedUrl.pathname.startsWith('/pay/')) {
      qrisRequestFormatParam = parsedUrl.searchParams.get('format');
      if (qrisRequestFormatParam === 'raw') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(pngBytes);
      } else {
        // Without ?format=raw, MyZZStore serves an HTML checkout page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Pay QRIS Here</body></html>');
      }
      return;
    }

    if (parsedUrl.pathname === '/check-payment') {
      pollQueries.push(parsedUrl.searchParams);
      const hasValidParams =
        Boolean(parsedUrl.searchParams.get('trx_id')) &&
        Boolean(parsedUrl.searchParams.get('amount')) &&
        parsedUrl.searchParams.get('api_key') === 'test-api-key';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          gatewayShouldReturnPaid && hasValidParams
            ? { success: true, paid: true }
            : {
                status: 'success',
                data: {
                  trx_id: parsedUrl.searchParams.get('trx_id'),
                  status: 'PENDING',
                },
              }
        )
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = (mockServer.address() as { port: number }).port;

  process.env.PAYMENT_GATEWAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.PAYMENT_GATEWAY_API_KEY = 'test-api-key';
  process.env.PAYMENT_GATEWAY_SECRET = 'test-secret';
  process.env.PAYMENT_GATEWAY_MERCHANT_ID = 'MERCHANT01';
  process.env.PAYMENT_GATEWAY_CREATE_PATH = '/create-qris';
  process.env.PAYMENT_GATEWAY_STATUS_PATH = '/check-payment';
  refreshConfig(process.env);

  try {
    const gateway = new MyZZStoreGateway();

    // 1. Verify appendRawFormatToQrisUrl and fetchQrisImageBuffer recover PNG even when base URL returns text/html
    const { appendRawFormatToQrisUrl } = await import('../integrations/qris-image');
    const samplePayUrl = `http://127.0.0.1:${port}/pay/MZ-POLL-SAMPLE`;
    assert.equal(appendRawFormatToQrisUrl(samplePayUrl), `${samplePayUrl}?format=raw`);
    const downloadedPng = await fetchQrisImageBuffer(samplePayUrl);
    assert.equal(qrisRequestFormatParam, 'raw');
    assert.equal(downloadedPng.equals(pngBytes), true);

    // 2. Verify createOrder stores gateway trx_id & qris_url, and pollPendingPayments sends Gateway ID (NEVER internal TRX-...)
    const orderRes = await createOrder(
      {
        platform: 'TELEGRAM',
        platformUserId: '88776655',
        productSkuOrId: 'TSEL10',
        destination: '081233445566',
      },
      gateway
    );
    assert.equal(orderRes.ok, true);
    assert.equal(orderRes.transaction?.gateway_reference, 'MZ-POLL-998877-1');
    assert.equal(orderRes.qris?.qrUrl, `http://127.0.0.1:${port}/pay/MZ-POLL-998877-1`);

    const { pollPendingPayments } = await import('./payment.reconciliation.service');
    await pollPendingPayments(gateway);
    assert.ok(pollQueries.length >= 1);
    const lastQuery = pollQueries[pollQueries.length - 1];
    assert.equal(lastQuery.get('trx_id'), 'MZ-POLL-998877-1');
    assert.equal(lastQuery.get('amount'), String(orderRes.transaction!.payment_amount));
    assert.equal(lastQuery.get('api_key'), 'test-api-key');
    assert.notEqual(lastQuery.get('trx_id'), orderRes.transaction!.transaction_id);

    // Clear cooldown/cancel the order via /batal on Telegram after 30s backdate
    const db = getDb();
    db.prepare('UPDATE transactions SET created_at = ? WHERE transaction_id = ?').run(
      new Date(Date.now() - 40_000).toISOString(),
      orderRes.transaction!.transaction_id
    );

    const { dispatchTelegramCommand } = await import('../bots/telegram.command-handler');
    const tgReplies: string[] = [];
    await dispatchTelegramCommand(
      {
        async reply(text) {
          tgReplies.push(text);
        },
      },
      { userId: '88776655', username: 'Canceller', text: '/batal' }
    );
    assert.match(tgReplies[0], /DIBATALKAN/);

    // Verify WhatsApp batal on customer with NO pending order returns explicit feedback (not silent main menu)
    const { handleWhatsappCommand, clearWhatsappCooldown } = await import('../bots/whatsapp.command-handler');
    clearWhatsappCooldown();
    const waReplies: Array<{ text?: string }> = [];
    await handleWhatsappCommand(
      {
        async sendMessage(_jid, content) {
          waReplies.push({ text: 'text' in content ? content.text : content.caption });
          return undefined;
        },
      },
      '628999000111',
      '!batal',
      'NoPending'
    );
    assert.match(waReplies[0].text || '', /belum ada pesanan aktif yang dapat dibatalkan|tidak ada pesanan/i);

    // 3. Verify invoice caption contains original payment link WITHOUT ?format=raw on WhatsApp & Telegram
    const origDefaultCreate = MyZZStoreGateway.prototype.createPayment;
    assert.ok(typeof origDefaultCreate === 'function');
    // Test via executeWhatsappOrder confirmation flow on live-like order using default gateway pointed at mockServer
    const waOrderReplies: Array<{ text?: string; image?: unknown }> = [];
    await handleWhatsappCommand(
      {
        async sendMessage(_jid, content) {
          waOrderReplies.push({
            text: 'text' in content ? content.text : content.caption,
            image: 'image' in content ? content.image : undefined,
          });
          return undefined;
        },
      },
      '628999000222',
      '!order TSEL10 081288889999',
      'BuyerWA',
      { now: 1_000_000 }
    );
    assert.match(waOrderReplies[0].text || '', /Konfirmasi Pesanan/);
    await handleWhatsappCommand(
      {
        async sendMessage(_jid, content) {
          waOrderReplies.push({
            text: 'text' in content ? content.text : content.caption,
            image: 'image' in content ? content.image : undefined,
          });
          return undefined;
        },
      },
      '628999000222',
      '!ya',
      'BuyerWA',
      { now: 1_004_000 }
    );
    const invoiceReply = waOrderReplies[1];
    assert.ok(Buffer.isBuffer(invoiceReply.image));
    assert.ok((invoiceReply.text || '').includes(`Link Pembayaran: http://127.0.0.1:${port}/pay/${lastCreatedTrxId}`));
    assert.equal((invoiceReply.text || '').includes('?format=raw'), false);

    // Verify polling marks it PAID when gateway returns PAID
    gatewayShouldReturnPaid = true;
    const paidPoll = await pollPendingPayments(gateway);
    assert.ok(paidPoll.paid >= 1);

    // 4. Verify vite.config.ts includes required allowedHosts for HTTPS reverse proxy
    const viteConfigRaw = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    assert.ok(viteConfigRaw.includes("'dashboard.myzzstore.my.id'"));
    assert.ok(viteConfigRaw.includes("'localhost'"));
    assert.ok(viteConfigRaw.includes("'127.0.0.1'"));
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

test('Digiflazz HTTP 400 JSON body parsing: preserves real RC/message and resolves Gagal/rejection RCs vs RC 99 UNKNOWN', async () => {
  let mode: 'SALDO_GAGAL' | 'IP_NO_STATUS' | 'ROUTER_99' = 'SALDO_GAGAL';
  const mockDigiServer = http.createServer((req, res) => {
    if (req.url === '/transaction' && req.method === 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      if (mode === 'SALDO_GAGAL') {
        res.end(
          JSON.stringify({
            data: {
              ref_id: 'TRX-DF-400-1',
              status: 'Gagal',
              rc: '44',
              message: 'Saldo Anda tidak cukup',
            },
          })
        );
        return;
      }
      if (mode === 'IP_NO_STATUS') {
        res.end(
          JSON.stringify({
            data: {
              ref_id: 'TRX-DF-400-2',
              rc: '45',
              message: 'IP Anda tidak kami kenali: 1.2.3.4',
            },
          })
        );
        return;
      }
      res.end(
        JSON.stringify({
          data: {
            ref_id: 'TRX-DF-400-3',
            status: 'Gagal',
            rc: '99',
            message: 'DF Router Issue',
          },
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockDigiServer.listen(0, '127.0.0.1', resolve));
  const port = (mockDigiServer.address() as { port: number }).port;
  process.env.DIGIFLAZZ_USERNAME = 'testuser';
  process.env.DIGIFLAZZ_API_KEY = 'test-digi-key';
  process.env.DIGIFLAZZ_BASE_URL = `http://127.0.0.1:${port}`;
  refreshConfig(process.env);

  try {
    const client = new DigiflazzClient();

    mode = 'SALDO_GAGAL';
    const res1 = await client.createTransaction({ sku: 'TSEL10', destination: '081234567890', refId: 'TRX-DF-400-1' });
    assert.equal(res1.mappedStatus, 'FAILED');
    assert.equal(res1.rc, '44');
    assert.equal(res1.message, '[RC 44] Saldo Anda tidak cukup');

    mode = 'IP_NO_STATUS';
    const res2 = await client.createTransaction({ sku: 'TSEL10', destination: '081234567890', refId: 'TRX-DF-400-2' });
    assert.equal(res2.mappedStatus, 'FAILED');
    assert.equal(res2.rc, '45');
    assert.equal(res2.message, '[RC 45] IP Anda tidak kami kenali: 1.2.3.4');

    mode = 'ROUTER_99';
    const res3 = await client.createTransaction({ sku: 'TSEL10', destination: '081234567890', refId: 'TRX-DF-400-3' });
    assert.equal(res3.mappedStatus, 'UNKNOWN');
    assert.equal(res3.rc, '99');
    assert.equal(res3.errorMessage, '[RC 99] DF Router Issue');
  } finally {
    await new Promise<void>((resolve) => mockDigiServer.close(() => resolve()));
  }
});

test('Timezone Jakarta normalization, api_key-only MyZZStore gateway (no merchantId/secret/callbackSecret), and Telegram webhook endpoint', async () => {
  const { validateAndLoadConfig, getIntegrationReadiness } = await import('../config/env');
  const normalizedCfg = validateAndLoadConfig({
    ...process.env,
    APP_TIMEZONE: 'Jakarta',
    PAYMENT_GATEWAY_API_KEY: 'only-api-key',
    PAYMENT_GATEWAY_SECRET: '',
    PAYMENT_GATEWAY_MERCHANT_ID: '',
    PAYMENT_GATEWAY_CALLBACK_SECRET: '',
  });
  assert.equal(normalizedCfg.timezone, 'Asia/Jakarta');
  const readiness = getIntegrationReadiness(normalizedCfg);
  assert.equal(readiness.myzzstore.configured, true);
  assert.deepEqual(readiness.myzzstore.missingFields, []);

  // Verify MyZZStoreGateway works cleanly without secret, merchantId, or callbackSecret
  process.env.PAYMENT_GATEWAY_SECRET = '';
  process.env.PAYMENT_GATEWAY_MERCHANT_ID = '';
  process.env.PAYMENT_GATEWAY_CALLBACK_SECRET = '';
  process.env.PAYMENT_GATEWAY_API_KEY = 'only-api-key';
  refreshConfig(process.env);
  const gw = new MyZZStoreGateway();
  assert.equal(gw.isConfigured(), true);
  assert.deepEqual(gw.getMissingConfiguration(), []);

  const app = createExpressApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = (server.address() as { port: number }).port;
    const webhookRes = await fetch(`http://127.0.0.1:${port}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 123456 }),
    });
    // Returns 503 cleanly when Telegram bot is disabled in test env (route is active and mounted)
    assert.equal(webhookRes.status, 503);

    // Verify LogsPage audit summary endpoint (limit=5) works cleanly
    const authHeader = `Basic ${Buffer.from('testowner:test-strong-password-999').toString('base64')}`;
    const auditRes = await fetch(`http://127.0.0.1:${port}/api/admin/logs?type=audit&page=1&limit=5`, {
      headers: { Authorization: authHeader },
    });
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as { ok: boolean; data: { items: unknown[] } };
    assert.equal(auditJson.ok, true);
    assert.ok(Array.isArray(auditJson.data.items));
    assert.ok(auditJson.data.items.length <= 5);

    // Verify WhatsApp connection config uses fetchLatestWaWebVersion and Ubuntu Chrome browser fingerprint
    const waConnRaw = fs.readFileSync(path.resolve(process.cwd(), 'server/bots/whatsapp.connection.ts'), 'utf8');
    assert.ok(waConnRaw.includes('fetchLatestWaWebVersion'));
    assert.equal(waConnRaw.includes('fetchLatestBaileysVersion'), false);
    assert.ok(waConnRaw.includes("browser: ['Ubuntu', 'Chrome', '120.0.0.0']"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('PulsaSync Bot Revision: SHOP_NAME env, /start greeting & buttons, /profil stats, WA mandatory prefix & 3s cooldown', async () => {
  process.env.SHOP_NAME = 'Toko PulsaSync Jaya';
  const refreshedCfg = refreshConfig(process.env);
  assert.equal(refreshedCfg.shopName, 'Toko PulsaSync Jaya');

  const envExampleRaw = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  assert.ok(envExampleRaw.includes('SHOP_NAME='));

  const { dispatchTelegramCommand, TG_MAIN_MENU_BUTTONS } = await import('../bots/telegram.command-handler');
  const { handleWhatsappCommand, clearWhatsappCooldown } = await import('../bots/whatsapp.command-handler');
  clearWhatsappCooldown();

  // Verify 6 main menu buttons & absence of Deposit button on Telegram
  const tgButtonLabels = TG_MAIN_MENU_BUTTONS.flat().map((b) => b.text);
  assert.deepEqual(tgButtonLabels, [
    '📂 Kategori Produk',
    '🛒 Daftar Produk',
    '👤 Profil & Saldo',
    '🎟️ Redeem Voucher',
    '📜 Riwayat Transaksi',
    '👨‍💼 Hubungi Admin',
  ]);
  assert.equal(tgButtonLabels.some((t) => /deposit/i.test(t)), false);

  // Telegram /start renders exact greeting, SHOP_NAME, user summary & buttons (without Total Pengguna Bot)
  const tgStartReplies: Array<{ text: string; buttons?: unknown }> = [];
  await dispatchTelegramCommand(
    {
      async reply(text, buttons) {
        tgStartReplies.push({ text, buttons });
      },
    },
    { userId: '910001', username: '@nadia_tg', displayName: 'Nadia Putri', text: '/start' }
  );
  const startMsg = tgStartReplies[0].text;
  assert.ok(startMsg.includes('Halo Kak Nadia Putri!'));
  assert.ok(startMsg.includes('Selamat datang di Toko PulsaSync Jaya — Layanan Pelanggan.'));
  assert.ok(
    startMsg.includes('Silakan pilih menu lewat tombol praktis di bawah tanpa perlu mengetik perintah manual:')
  );
  assert.match(startMsg, /ID User:/);
  assert.match(startMsg, /Status:\s*Member/);
  assert.equal(/Total Pengguna Bot/i.test(startMsg), false);

  // Telegram /profil renders Akun & Keuangan sections cleanly
  const tgProfileReplies: string[] = [];
  await dispatchTelegramCommand(
    {
      async reply(text) {
        tgProfileReplies.push(text);
      },
    },
    { userId: '910001', username: '@nadia_tg', displayName: 'Nadia Putri', text: '/profil' }
  );
  const profMsg = tgProfileReplies[0];
  assert.match(profMsg, /Profil Pengguna/);
  assert.match(profMsg, /Akun/);
  assert.match(profMsg, /ID:\s*CUS-/);
  assert.match(profMsg, /Username:\s*@nadia_tg/);
  assert.match(profMsg, /Bergabung:/);
  assert.match(profMsg, /Keuangan/);
  assert.match(profMsg, /Saldo:\s*Rp\s*[\d.]+/);
  assert.match(profMsg, /Poin Loyalitas:\s*\d+/);
  assert.match(profMsg, /Tier:\s*(Bronze|Silver|Gold|Platinum)/);
  assert.match(profMsg, /Total Belanja:\s*Rp\s*[\d.]+/);

  // WhatsApp ignores messages without ! or . prefix completely
  const waSent: Array<{ text: string; buttons?: Array<Array<{ text: string; replyText: string }>> }> = [];
  const waTransport = {
    async sendMessage(_jid: string, content: { text?: string; caption?: string; quickReplies?: Array<Array<{ text: string; replyText: string }>> }) {
      waSent.push({
        text: content.text || content.caption || '',
        buttons: content.quickReplies,
      });
      return undefined;
    },
  };

  await handleWhatsappCommand(waTransport, '628777000111', 'start', 'Andi WA', { now: 10_000 });
  await handleWhatsappCommand(waTransport, '628777000111', 'profil', 'Andi WA', { now: 15_000 });
  await handleWhatsappCommand(waTransport, '628777000111', 'halo kak', 'Andi WA', { now: 20_000 });
  assert.equal(waSent.length, 0);

  // WhatsApp responds to .start and renders exact greeting, SHOP_NAME, 6 buttons (no Deposit), and prefixed .profil
  await handleWhatsappCommand(waTransport, '628777000111', '.start', 'Andi WA', { now: 25_000 });
  assert.equal(waSent.length, 1);
  assert.ok(waSent[0].text.includes('Halo Kak Andi WA!'));
  assert.ok(waSent[0].text.includes('Selamat datang di Toko PulsaSync Jaya — Layanan Pelanggan.'));
  assert.equal(/Total Pengguna Bot/i.test(waSent[0].text), false);
  const waBtns = (waSent[0].buttons || []).flat().map((b) => b.text);
  assert.deepEqual(waBtns, [
    '📂 Kategori Produk',
    '🛒 Daftar Produk',
    '👤 Profil & Saldo',
    '🎟️ Redeem Voucher',
    '📜 Riwayat Transaksi',
    '👨‍💼 Hubungi Admin',
  ]);
  assert.equal(waBtns.some((t) => /deposit/i.test(t)), false);

  // Within 3s cooldown (25_000 -> 27_000 = 2s), second prefixed command MUST be ignored silently
  await handleWhatsappCommand(waTransport, '628777000111', '!profil', 'Andi WA', { now: 27_000 });
  assert.equal(waSent.length, 1);

  // Different user at 27_000 is NOT blocked by first user's cooldown
  await handleWhatsappCommand(waTransport, '628777000222', '!kontak', 'Budi WA', { now: 27_000 });
  assert.equal(waSent.length, 2);
  assert.match(waSent[1].text, /Hubungi Admin — Toko PulsaSync Jaya/);

  // After 3s elapsed (25_000 -> 28_000 = 3s), first user responds to !profil again
  await handleWhatsappCommand(waTransport, '628777000111', '!profil', 'Andi WA', { now: 28_000 });
  assert.equal(waSent.length, 3);
  assert.match(waSent[2].text, /Profil Pengguna/);
  assert.match(waSent[2].text, /Tier:\s*(Bronze|Silver|Gold|Platinum)/);
});

test('Production config boots cleanly without SESSION_SECRET and derives strong deterministic/ephemeral secret', async () => {
  const { validateAndLoadConfig } = await import('../config/env');

  // With DASHBOARD_AUTH_USER + DASHBOARD_AUTH_PASSWORD set but SESSION_SECRET omitted in Cloud Run production
  const prodCfg1 = validateAndLoadConfig({
    NODE_ENV: 'production',
    PORT: '8080',
    K_SERVICE: 'pulsasync-cloud-run',
    DASHBOARD_AUTH_USER: 'owner',
    DASHBOARD_AUTH_PASSWORD: 'super-secret-dashboard-pw',
    SESSION_SECRET: '',
  });
  const prodCfg1Repeat = validateAndLoadConfig({
    NODE_ENV: 'production',
    PORT: '8080',
    K_SERVICE: 'pulsasync-cloud-run',
    DASHBOARD_AUTH_USER: 'owner',
    DASHBOARD_AUTH_PASSWORD: 'super-secret-dashboard-pw',
    SESSION_SECRET: '',
  });
  const prodCfgShort = validateAndLoadConfig({
    NODE_ENV: 'production',
    PORT: '8080',
    K_SERVICE: 'pulsasync-cloud-run',
    DASHBOARD_AUTH_USER: 'owner',
    DASHBOARD_AUTH_PASSWORD: 'super-secret-dashboard-pw',
    SESSION_SECRET: 'short',
  });
  assert.equal(prodCfg1.nodeEnv, 'production');
  assert.equal(prodCfg1.port, 8080);
  assert.equal(prodCfg1.security.trustProxy, true);
  assert.ok(prodCfg1.auth.sessionSecret.length >= 32);
  assert.equal(prodCfg1.auth.sessionSecret, prodCfg1Repeat.auth.sessionSecret);
  assert.ok(prodCfgShort.auth.sessionSecret.length >= 32);

  // Even if DASHBOARD_AUTH_* and SESSION_SECRET are both unset, config loads safely (dashboard returns 503)
  const prodNoAuthCfg = validateAndLoadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: '',
  });
  assert.ok(prodNoAuthCfg.auth.sessionSecret.length >= 32);
});

test('Automatic RAM & cache cleanup prunes expired bot sessions/cooldowns/vouchers and shrinks SQLite memory', async () => {
  const {
    setBotSession,
    setPendingVoucher,
    recordTelegramBotMessageId,
    getBotSessionMemoryStats,
  } = await import('../bots/bot-session');
  const { handleWhatsappCommand, clearWhatsappCooldown } = await import('../bots/whatsapp.command-handler');
  const { runAutomaticMemoryCleanup, getMemoryCleanupStatus } = await import('./memory-cleanup.service');

  clearWhatsappCooldown();
  const staleAt = Date.now() - 40 * 60 * 1000; // 40 minutes ago (past 10m & 30m TTLs)

  setBotSession('TELEGRAM', 'stale-tg-user-1', { mode: 'MAIN_MENU', updatedAt: staleAt });
  setPendingVoucher('WHATSAPP', '628111999000', 'PROMO10');
  recordTelegramBotMessageId('stale-chat-1', 777);

  // Trigger a WhatsApp command with timestamp > 3s in the past so cooldown entry expires immediately
  const dummyWaTransport = { async sendMessage() { return undefined; } };
  await handleWhatsappCommand(dummyWaTransport, '628111888777', '!kontak', 'Mem Tester', {
    now: staleAt,
    enforceCooldown: true,
  });

  // Run cleanup with "future" timestamp beyond 40 mins from staleAt & > 10 mins from now
  const cleanupResult = runAutomaticMemoryCleanup('AUTO', Date.now() + 35 * 60 * 1000);
  assert.ok(cleanupResult.evicted.botSessions >= 1);
  assert.ok(cleanupResult.evicted.pendingVouchers >= 1);
  assert.ok(cleanupResult.evicted.telegramMessageRefs >= 1);
  assert.ok(cleanupResult.evicted.whatsappCooldowns >= 1);
  assert.ok(cleanupResult.evicted.total >= 4);
  assert.equal(cleanupResult.sqlite.ran, true);
  assert.equal(cleanupResult.sqlite.memoryShrunk, true);
  assert.ok(cleanupResult.after.rssMb > 0);

  const statsAfter = getBotSessionMemoryStats();
  assert.equal(statsAfter.sessions, 0);
  assert.equal(statsAfter.pendingVouchers, 0);
  assert.equal(statsAfter.telegramMessageRefs, 0);

  const status = getMemoryCleanupStatus();
  assert.ok(status.totalRuns >= 1);
  assert.ok(status.totalEvictedEntries >= 4);
  assert.ok(status.lastRunAt !== null);
});

test('Product Auto-Refresh supports interval, daily time, cron, and disabled modes via settings, scheduler & API', async () => {
  const { validateAndLoadConfig } = await import('../config/env');
  const { resolveProductRefreshCron } = await import('./settings.service');
  const { centralScheduler } = await import('../workers/scheduler');

  const envIntervalCfg = validateAndLoadConfig({
    ...process.env,
    DIGIFLAZZ_PRICE_SYNC_INTERVAL_MINUTES: '45',
  });
  assert.equal(envIntervalCfg.digiflazz.priceSyncIntervalMinutes, 45);

  const app = createExpressApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = (server.address() as { port: number }).port;
    const authHeader = `Basic ${Buffer.from('testowner:test-strong-password-999').toString('base64')}`;

    // 1. Save INTERVAL mode (every 30 minutes)
    const resInterval = await fetch(`http://127.0.0.1:${port}/api/admin/products/auto-refresh`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'INTERVAL', intervalMinutes: 30 }),
    });
    assert.equal(resInterval.status, 200);
    const jsonInterval = (await resInterval.json()) as { ok: boolean; data: any };
    assert.equal(jsonInterval.ok, true);
    assert.equal(jsonInterval.data.config.mode, 'INTERVAL');
    assert.equal(jsonInterval.data.config.intervalMinutes, 30);
    assert.match(jsonInterval.data.summary, /Setiap 30 menit/);
    assert.match(centralScheduler.getStatus().productAutoRefreshSummary, /Setiap 30 menit/);

    // 2. Save DAILY_TIME mode (04:30)
    const resDaily = await fetch(`http://127.0.0.1:${port}/api/admin/products/auto-refresh`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'DAILY_TIME', dailyTime: '04:30' }),
    });
    assert.equal(resDaily.status, 200);
    const jsonDaily = (await resDaily.json()) as { ok: boolean; data: any };
    assert.equal(jsonDaily.data.config.mode, 'DAILY_TIME');
    assert.equal(jsonDaily.data.config.dailyTime, '04:30');
    assert.equal(resolveProductRefreshCron(jsonDaily.data.config), '30 4 * * *');

    // 3. Reject invalid interval (< 5 mins)
    const resBad = await fetch(`http://127.0.0.1:${port}/api/admin/products/auto-refresh`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'INTERVAL', intervalMinutes: 2 }),
    });
    assert.equal(resBad.status, 400);

    // 4. GET reflects persisted config
    const resGet = await fetch(`http://127.0.0.1:${port}/api/admin/products/auto-refresh`, {
      headers: { Authorization: authHeader },
    });
    assert.equal(resGet.status, 200);
    const jsonGet = (await resGet.json()) as { ok: boolean; data: any };
    assert.equal(jsonGet.data.config.mode, 'DAILY_TIME');
    assert.equal(jsonGet.data.config.dailyTime, '04:30');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Telegram & WhatsApp Category -> Brand/Operator -> Product + Phone Prefix Auto-Detect (Opsi 1 & Opsi 2)', async () => {
  const actor = { id: 'testowner', role: 'OWNER' as const };
  const { createCategory, listActiveBrandsInCategory } = await import('./product.service');
  const { detectOperatorFromPhone, matchBrandForDetectedOperator } = await import('../domain/operator-prefix');

  const pulsaCat = createCategory({ name: 'Pulsa Otomatis' }, actor);
  upsertProduct(
    { sku: 'XL25', name: 'Pulsa XL 25.000', categoryId: pulsaCat.id, brand: 'XL', supplierPrice: 25100 },
    actor
  );
  upsertProduct(
    { sku: 'XL5', name: 'Pulsa XL 5.000', categoryId: pulsaCat.id, brand: 'XL', supplierPrice: 5400 },
    actor
  );
  upsertProduct(
    { sku: 'TSEL10_B', name: 'Pulsa Telkomsel 10.000', categoryId: pulsaCat.id, brand: 'TELKOMSEL', supplierPrice: 10200 },
    actor
  );
  upsertProduct(
    { sku: 'ISAT10', name: 'Pulsa Indosat 10.000', categoryId: pulsaCat.id, brand: 'INDOSAT', supplierPrice: 10300 },
    actor
  );

  // Prefix detection helper sanity checks
  const xlDetected = detectOperatorFromPhone('+62 818-1234-5678')!;
  assert.equal(xlDetected.normalizedPhone, '081812345678');
  assert.equal(xlDetected.operatorKey, 'XL');
  assert.equal(
    matchBrandForDetectedOperator(
      listActiveBrandsInCategory(pulsaCat.id).map((b) => b.brand),
      xlDetected
    ),
    'XL'
  );

  // 1. Telegram Opsi 1: Selecting Pulsa Otomatis shows brand buttons + phone auto-detect prompt
  const tgCatStep = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: `CAT_${pulsaCat.id}_1`,
    senderId: '777888',
    actor,
  });
  assert.match(tgCatStep.replies[0].text, /deteksi operator otomatis/i);
  const tgBrandBtnTexts = (tgCatStep.replies[0].buttons || []).flat().map((b) => b.text);
  assert.ok(tgBrandBtnTexts.some((t) => t.includes('XL')));
  assert.ok(tgBrandBtnTexts.some((t) => t.includes('TELKOMSEL')));

  // 2. Telegram Opsi 2: Sending XL phone number auto-detects XL and lists XL products cheapest first
  const tgAutoDetect = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '081812345678',
    senderId: '777888',
    actor,
  });
  assert.match(tgAutoDetect.replies[0].text, /081812345678.*terdeteksi operator \*XL\*/i);
  const tgProductBtns = (tgAutoDetect.replies[0].buttons || []).flat();
  const xlProductLabels = tgProductBtns.filter((b) => b.callbackData?.startsWith('BUY_SKU_XL')).map((b) => b.text);
  assert.equal(xlProductLabels.length, 2);
  assert.ok(xlProductLabels[0].includes('Pulsa XL 5.000'));
  assert.ok(xlProductLabels[1].includes('Pulsa XL 25.000'));

  // Tapping BUY_SKU_XL5 after auto-detection skips phone prompt and goes straight to Order Confirmation!
  const tgQuickConfirm = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: 'BUY_SKU_XL5',
    senderId: '777888',
    actor,
  });
  assert.match(tgQuickConfirm.replies[0].text, /Konfirmasi Pesanan Anda/i);
  assert.ok(tgQuickConfirm.replies[0].text.includes('081812345678'));
  assert.ok(tgQuickConfirm.replies[0].text.includes('Pulsa XL 5.000'));

  // 3. WhatsApp Opsi 1 + Opsi 2 flow
  const waCatStep = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: `!produk_kat ${pulsaCat.id} 1`,
    senderId: '6281999000111',
    actor,
  });
  assert.match(waCatStep.replies[0].text, /deteksi operator otomatis/i);

  const waAutoDetect = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!081812345678',
    senderId: '6281999000111',
    actor,
  });
  assert.match(waAutoDetect.replies[0].text, /081812345678 Terdeteksi: XL/i);

  // Choosing !1 picks cheapest XL product (XL5) and goes straight to Confirmation with 081812345678
  const waQuickConfirm = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!1',
    senderId: '6281999000111',
    actor,
  });
  assert.match(waQuickConfirm.replies[0].text, /Konfirmasi Pesanan Anda/i);
  assert.ok(waQuickConfirm.replies[0].text.includes('081812345678'));
});

test('Telegram Hubungi Admin URL Button & Cek Status Callback Query Alert (show_alert: true)', async () => {
  const prevUsername = process.env.OWNER_TELEGRAM_USERNAME;
  const prevId = process.env.OWNER_TELEGRAM_ID;

  try {
    // 1. With OWNER_TELEGRAM_USERNAME configured -> https://t.me/<username>
    process.env.OWNER_TELEGRAM_USERNAME = '@admin_pulsasync';
    process.env.OWNER_TELEGRAM_ID = '987654321';
    refreshConfig(process.env);

    const { getTelegramMainMenuButtons } = await import('../bots/telegram.command-handler');
    const { dispatchTelegramCallback } = await import('../bots/telegram.callback-handler');

    const menuWithUsername = getTelegramMainMenuButtons().flat();
    const adminBtnUser = menuWithUsername.find((b) => b.text === '👨‍💼 Hubungi Admin');
    assert.equal(adminBtnUser?.url, 'https://t.me/admin_pulsasync');
    assert.equal(adminBtnUser?.callbackData, undefined);

    // 2. Without username, with numeric OWNER_TELEGRAM_ID -> tg://user?id=<id>
    process.env.OWNER_TELEGRAM_USERNAME = '';
    process.env.OWNER_TELEGRAM_ID = '987654321';
    refreshConfig(process.env);
    const adminBtnId = getTelegramMainMenuButtons()
      .flat()
      .find((b) => b.text === '👨‍💼 Hubungi Admin');
    assert.equal(adminBtnId?.url, 'tg://user?id=987654321');

    // 3. Without both -> fallback to CONTACT_ADMIN callback
    process.env.OWNER_TELEGRAM_USERNAME = '';
    process.env.OWNER_TELEGRAM_ID = '';
    refreshConfig(process.env);
    const adminBtnFallback = getTelegramMainMenuButtons()
      .flat()
      .find((b) => b.text === '👨‍💼 Hubungi Admin');
    assert.equal(adminBtnFallback?.url, undefined);
    assert.equal(adminBtnFallback?.callbackData, 'CONTACT_ADMIN');

    // 4. STATUS_ callback invokes answerCbQuery(text, true) without deleting source QRIS message
    let alertCalls: Array<{ text?: string; showAlert?: boolean }> = [];
    let deleteCalls = 0;
    let replyCalls = 0;

    await dispatchTelegramCallback(
      {
        async reply() {
          replyCalls++;
        },
        async answerCbQuery(text, showAlert) {
          alertCalls.push({ text, showAlert });
        },
        async deleteSourceMessage() {
          deleteCalls++;
        },
      },
      { data: 'STATUS_TRX-DEMO-999', userId: '555666', username: 'Tester' },
      { dryRun: true }
    );

    assert.equal(deleteCalls, 0);
    assert.equal(replyCalls, 0);
    assert.equal(alertCalls.length, 1);
    assert.equal(alertCalls[0].showAlert, true);
    assert.ok(alertCalls[0].text && alertCalls[0].text.length <= 200);
    assert.match(alertCalls[0].text!, /PENDING_PAYMENT/);

    // Same check via BotDemoService (demo mode)
    const demoStatus = await runBotDemoInteraction({
      platform: 'TELEGRAM',
      senderRole: 'CUSTOMER',
      inputType: 'CALLBACK',
      callbackData: 'STATUS_TRX-DEMO-999',
      senderId: '555666',
      actor: { id: 'testowner', role: 'OWNER' },
    });
    assert.equal(demoStatus.replies.length, 0);
    assert.equal(demoStatus.alert?.showAlert, true);
    assert.match(demoStatus.alert?.text || '', /PENDING_PAYMENT/);
  } finally {
    if (prevUsername === undefined) delete process.env.OWNER_TELEGRAM_USERNAME;
    else process.env.OWNER_TELEGRAM_USERNAME = prevUsername;
    if (prevId === undefined) delete process.env.OWNER_TELEGRAM_ID;
    else process.env.OWNER_TELEGRAM_ID = prevId;
    refreshConfig(process.env);
  }
});

test('4 Group Log Routing: Service, All Tx Admin, Unmasked Success Admin, and Censored Testimony (Success Only)', async () => {
  const prevEnv = {
    WA_ENABLED: process.env.WHATSAPP_ENABLED,
    TG_ENABLED: process.env.TELEGRAM_ENABLED,
    TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TG_BOT_USER: process.env.TELEGRAM_BOT_USERNAME,
    WA_SVC: process.env.WHATSAPP_SERVICE_LOG_GROUP,
    WA_TX: process.env.WHATSAPP_TRANSACTION_LOG_GROUP,
    WA_OK: process.env.WHATSAPP_SUCCESS_LOG_GROUP,
    WA_TESTI: process.env.WHATSAPP_TESTIMONY_GROUP,
    TG_SVC: process.env.TELEGRAM_SERVICE_LOG_CHAT_ID,
    TG_TX: process.env.TELEGRAM_TRANSACTION_LOG_CHAT_ID,
    TG_OK: process.env.TELEGRAM_SUCCESS_LOG_CHAT_ID,
    TG_TESTI: process.env.TELEGRAM_TESTIMONY_CHAT_ID,
  };

  try {
    process.env.WHATSAPP_ENABLED = 'true';
    process.env.TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:TEST_TOKEN_FOR_SUITE';
    process.env.TELEGRAM_BOT_USERNAME = 'lynzz_ppob_bot';
    process.env.WHATSAPP_SERVICE_LOG_GROUP = '1203630001@g.us';
    process.env.WHATSAPP_TRANSACTION_LOG_GROUP = '1203630002@g.us';
    process.env.WHATSAPP_SUCCESS_LOG_GROUP = '1203630003@g.us';
    process.env.WHATSAPP_TESTIMONY_GROUP = '1203630004@g.us';
    process.env.TELEGRAM_SERVICE_LOG_CHAT_ID = '-1001001';
    process.env.TELEGRAM_TRANSACTION_LOG_CHAT_ID = '-1001002';
    process.env.TELEGRAM_SUCCESS_LOG_CHAT_ID = '-1001003';
    process.env.TELEGRAM_TESTIMONY_CHAT_ID = '@lynzz_testimoni';
    refreshConfig(process.env);

    const db = getDb();
    const { emitServiceLogToGroups } = await import('../services/notification.service');
    emitServiceLogToGroups('test-4ch-svc', 'Test Layanan', 'Cek log layanan 4 channel');

    // 1. Order that goes SUCCESS -> triggers TRANSACTION_LOG + SUCCESS_ADMIN_LOG + TESTIMONY_LOG
    const gw = new TestPaymentGateway();
    const orderOk = await createOrder(
      {
        platform: 'TELEGRAM',
        platformUserId: '8686345389',
        platformUsername: 'lynzz_buyer',
        productSkuOrId: 'TSEL10',
        destination: '081234569988',
      },
      gw
    );
    assert.equal(orderOk.ok, true);
    const txIdOk = orderOk.transaction!.transaction_id;

    handleVerifiedPaymentPaid(txIdOk, 'TEST_4CH_PAY');
    const okPort = new TestDigiflazzPort();
    okPort.nextStatus = 'SUCCESS';
    const supplierMock = new DigiflazzService(okPort);
    const supRes = await processSingleSupplierJob(txIdOk, 'worker-4ch', supplierMock);
    assert.equal(supRes.status, 'SUCCESS');

    const jobsOk = db
      .prepare('SELECT platform, recipient_id, message_type, payload_json FROM notification_jobs WHERE transaction_id = ?')
      .all(txIdOk) as Array<{ platform: string; recipient_id: string; message_type: string; payload_json: string }>;

    const adminSuccessJobs = jobsOk.filter((j) => j.message_type === 'SUCCESS_ADMIN_LOG');
    assert.equal(adminSuccessJobs.length, 2);
    for (const job of adminSuccessJobs) {
      const text = (JSON.parse(job.payload_json) as { text: string }).text;
      // Full unmasked data in admin success group
      assert.ok(text.includes(txIdOk));
      assert.ok(text.includes('081234569988'));
      assert.ok(text.includes('8686345389'));
      assert.ok(text.includes('@lynzz_buyer'));
      assert.ok(text.includes('SN-123456'));
    }

    const testimonyJobs = jobsOk.filter((j) => j.message_type === 'TESTIMONY_LOG');
    assert.equal(testimonyJobs.length, 2);
    const tgTestimony = testimonyJobs.find((j) => j.platform === 'TELEGRAM' && j.recipient_id === '@lynzz_testimoni');
    assert.ok(tgTestimony);
    const testiText = (JSON.parse(tgTestimony!.payload_json) as { text: string }).text;
    assert.match(testiText, /✨ ORDER BERHASIL/);
    assert.match(testiText, /DETAIL TRANSAKSI/);
    assert.match(testiText, /0812\*\*\*\*9988/);
    assert.match(testiText, /SN-1\*\*\*\*3456/);
    assert.match(testiText, /@ly\*\*\*r/);
    assert.match(testiText, /TRX-\*\*\*\*-/);
    assert.match(testiText, /🤖 Bot: @lynzz_ppob_bot/);
    // Sensitive full values must NEVER appear in testimony
    assert.equal(testiText.includes('081234569988'), false);
    assert.equal(testiText.includes('SN-123456'), false);
    assert.equal(testiText.includes('8686345389'), false);
    assert.equal(testiText.includes(txIdOk), false);

    // 2. Order that FAILS -> triggers TRANSACTION_LOG (and refund), but NEVER SUCCESS_ADMIN_LOG or TESTIMONY_LOG
    const orderFail = await createOrder(
      {
        platform: 'WHATSAPP',
        platformUserId: '6281234567000',
        productSkuOrId: 'TSEL10',
        destination: '081234560000',
      },
      gw
    );
    assert.equal(orderFail.ok, true);
    const txIdFail = orderFail.transaction!.transaction_id;
    handleVerifiedPaymentPaid(txIdFail, 'TEST_4CH_FAIL_PAY');
    const failPort = new TestDigiflazzPort();
    failPort.nextStatus = 'FAILED';
    const failSup = new DigiflazzService(failPort);
    await processSingleSupplierJob(txIdFail, 'worker-4ch-fail', failSup);

    const jobsFail = db
      .prepare('SELECT message_type FROM notification_jobs WHERE transaction_id = ?')
      .all(txIdFail) as Array<{ message_type: string }>;
    assert.ok(jobsFail.some((j) => j.message_type === 'TRANSACTION_LOG'));
    assert.equal(jobsFail.some((j) => j.message_type === 'SUCCESS_ADMIN_LOG'), false);
    assert.equal(jobsFail.some((j) => j.message_type === 'TESTIMONY_LOG'), false);

    // Verify service log job created
    const svcJobs = db
      .prepare("SELECT message_type FROM notification_jobs WHERE dedupe_key LIKE 'svc-%test-4ch-svc'")
      .all() as Array<{ message_type: string }>;
    assert.equal(svcJobs.length, 2);
  } finally {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('WHATSAPP_ENABLED', prevEnv.WA_ENABLED);
    restore('TELEGRAM_ENABLED', prevEnv.TG_ENABLED);
    restore('TELEGRAM_BOT_TOKEN', prevEnv.TG_TOKEN);
    restore('TELEGRAM_BOT_USERNAME', prevEnv.TG_BOT_USER);
    restore('WHATSAPP_SERVICE_LOG_GROUP', prevEnv.WA_SVC);
    restore('WHATSAPP_TRANSACTION_LOG_GROUP', prevEnv.WA_TX);
    restore('WHATSAPP_SUCCESS_LOG_GROUP', prevEnv.WA_OK);
    restore('WHATSAPP_TESTIMONY_GROUP', prevEnv.WA_TESTI);
    restore('TELEGRAM_SERVICE_LOG_CHAT_ID', prevEnv.TG_SVC);
    restore('TELEGRAM_TRANSACTION_LOG_CHAT_ID', prevEnv.TG_TX);
    restore('TELEGRAM_SUCCESS_LOG_CHAT_ID', prevEnv.TG_OK);
    restore('TELEGRAM_TESTIMONY_CHAT_ID', prevEnv.TG_TESTI);
    refreshConfig(process.env);
  }
});

test('getDigiflazzEnvDiagnostic detects unquoted #, container override, dev- key, and never leaks secrets', async () => {
  const { getDigiflazzEnvDiagnostic, validateAndLoadConfig } = await import('../config/env');
  const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsasync-diag-'));

  try {
    // Case 1: unquoted # in .env + dev- prefix + overridden env
    fs.writeFileSync(
      path.join(diagDir, '.env'),
      'DIGIFLAZZ_USERNAME=yuxoxuD24abc\nDIGIFLAZZ_API_KEY=dev-secret#cut\n',
      'utf8'
    );
    const mockEnv1: NodeJS.ProcessEnv = {
      DIGIFLAZZ_USERNAME: 'yuxoxuD24abc',
      DIGIFLAZZ_API_KEY: 'dev-different-override',
    };
    const cfg1 = validateAndLoadConfig(mockEnv1);
    const d1 = getDigiflazzEnvDiagnostic({ cfg: cfg1, env: mockEnv1, cwd: diagDir });

    assert.equal(d1.configured, true);
    assert.equal(d1.usernameMasked, 'yu***bc');
    assert.equal(d1.usernameLength, 12);
    assert.equal(d1.apiKeyMode, 'DEVELOPMENT');
    assert.equal(d1.apiKeyLength, 'dev-different-override'.length);
    assert.equal(d1.envFileExists, true);
    assert.equal(d1.overriddenByContainerEnv, true);
    assert.ok(d1.warnings.some((w) => w.includes('tanda "#"')));
    assert.ok(d1.warnings.some((w) => w.includes('tertimpa')));
    assert.ok(d1.warnings.some((w) => w.includes('DEVELOPMENT')));
    // Never leak actual API key or full username
    const serialized1 = JSON.stringify(d1);
    assert.equal(serialized1.includes('dev-different-override'), false);
    assert.equal(serialized1.includes('dev-secret'), false);
    assert.equal(serialized1.includes('yuxoxuD24abc'), false);

    // Case 2: clean quoted Production key matching env -> zero warnings
    const prodKey = 'prodKey#WithHash9999';
    fs.writeFileSync(
      path.join(diagDir, '.env'),
      `DIGIFLAZZ_USERNAME="yuxoxuD24abc"\nDIGIFLAZZ_API_KEY="${prodKey}"\n`,
      'utf8'
    );
    const mockEnv2: NodeJS.ProcessEnv = {
      DIGIFLAZZ_USERNAME: 'yuxoxuD24abc',
      DIGIFLAZZ_API_KEY: prodKey,
    };
    const cfg2 = validateAndLoadConfig(mockEnv2);
    const d2 = getDigiflazzEnvDiagnostic({ cfg: cfg2, env: mockEnv2, cwd: diagDir });

    assert.equal(d2.apiKeyMode, 'PRODUCTION');
    assert.equal(d2.apiKeyLength, prodKey.length);
    assert.equal(d2.overriddenByContainerEnv, false);
    assert.deepEqual(d2.warnings, []);
    assert.equal(JSON.stringify(d2).includes(prodKey), false);
  } finally {
    fs.rmSync(diagDir, { recursive: true, force: true });
  }
});

test('Telegram CONFIRM_ORDER double-tap never sends expired-session message before QRIS is delivered', async () => {
  const { setBotSession, clearBotSession } = await import('../bots/bot-session');
  const { dispatchTelegramCallback } = await import('../bots/telegram.callback-handler');
  const { listProducts } = await import('./product.service');

  const activeProducts = listProducts({ onlyActive: true, limit: 1 }).items;
  assert.ok(activeProducts.length > 0);
  const sampleProduct = activeProducts[0];
  const userId = '99112233';
  const sourceMessageId = 4567;

  setBotSession(
    'TELEGRAM',
    userId,
    {
      mode: 'AWAITING_ORDER_CONFIRMATION',
      sku: sampleProduct.sku,
      productName: sampleProduct.name,
      sellingPrice: sampleProduct.selling_price,
      discountAmount: 0,
      estimatedTotal: sampleProduct.selling_price + 25,
      destination: '081234567890',
      couponCode: null,
      updatedAt: Date.now(),
    },
    true
  );

  const replies: string[] = [];
  const qrDeliveries: string[] = [];
  const cbAnswers: Array<{ text?: string; showAlert?: boolean }> = [];
  let deleteCalls = 0;

  const makeTransport = () => ({
    async reply(text: string) {
      replies.push(text);
    },
    async sendQris(caption: string) {
      await new Promise((r) => setTimeout(r, 40));
      qrDeliveries.push(caption);
      return 8881;
    },
    async answerCbQuery(text?: string, showAlert?: boolean) {
      cbAnswers.push({ text, showAlert });
    },
    async deleteSourceMessage() {
      deleteCalls++;
    },
  });

  // 1. Concurrent double-tap on CONFIRM_ORDER while QRIS is still being uploaded
  await Promise.all([
    dispatchTelegramCallback(
      makeTransport(),
      { data: 'CONFIRM_ORDER', userId, username: '@buyer1', sourceMessageId },
      { dryRun: true }
    ),
    dispatchTelegramCallback(
      makeTransport(),
      { data: 'CONFIRM_ORDER', userId, username: '@buyer1', sourceMessageId },
      { dryRun: true }
    ),
  ]);

  assert.equal(qrDeliveries.length, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(
    replies.some((r) => r.includes('Sesi konfirmasi pesanan sudah berakhir')),
    false
  );
  assert.ok(cbAnswers.some((a) => (a.text || '').includes('Sedang membuat invoice QRIS')));

  // 2. Delayed duplicate tap arriving right after execution on the same sourceMessageId
  await dispatchTelegramCallback(
    makeTransport(),
    { data: 'CONFIRM_ORDER', userId, username: '@buyer1', sourceMessageId },
    { dryRun: true }
  );
  assert.equal(qrDeliveries.length, 1);
  assert.equal(
    replies.some((r) => r.includes('Sesi konfirmasi pesanan sudah berakhir')),
    false
  );
  assert.ok(cbAnswers.some((a) => (a.text || '').includes('Invoice QRIS baru saja diproses')));

  // 3. Genuine expired session (different user without active confirmation) still informs user properly
  clearBotSession('TELEGRAM', '99112299', true);
  await dispatchTelegramCallback(
    makeTransport(),
    { data: 'CONFIRM_ORDER', userId: '99112299', username: '@buyer2', sourceMessageId: 9999 },
    { dryRun: true }
  );
  assert.ok(replies.some((r) => r.includes('Sesi konfirmasi pesanan sudah berakhir ya Kak')));
});

test('Optional Payment Confirmation Description (Global & Per-SKU) via Admin API, Telegram & WhatsApp', async () => {
  const actor = { id: 'testowner', role: 'OWNER' as const };
  const { setConfirmationDescription, getConfirmationDescription } = await import('./settings.service');
  const { updateProductDescription } = await import('./product.service');

  // Ensure both descriptions start empty
  setConfirmationDescription(null, actor);
  updateProductDescription('TSEL10', null, actor);
  assert.equal(getConfirmationDescription(), null);

  // 1. Without descriptions -> Konfirmasi Pesanan Anda must NOT show Keterangan: or Catatan:
  const tgNoDesc = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'CALLBACK',
    callbackData: 'BUY_SKU_TSEL10',
    senderId: '88221100',
    actor,
  });
  assert.match(tgNoDesc.replies[0].text, /Nomor tujuan/i);
  const tgConfirmEmpty = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '081234560101',
    senderId: '88221100',
    actor,
  });
  assert.match(tgConfirmEmpty.replies[0].text, /Konfirmasi Pesanan Anda/);
  assert.equal(/Keterangan:|Catatan:/i.test(tgConfirmEmpty.replies[0].text), false);

  const waConfirmEmpty = await runBotDemoInteraction({
    platform: 'WHATSAPP',
    senderRole: 'CUSTOMER',
    inputType: 'TEXT',
    text: '!order TSEL10 081234560101',
    senderId: '6281200010101',
    actor,
  });
  assert.match(waConfirmEmpty.replies[0].text, /Konfirmasi Pesanan Anda/);
  assert.equal(/Keterangan:|Catatan:/i.test(waConfirmEmpty.replies[0].text), false);

  // 2. Configure both via Admin HTTP API and verify GET /api/admin/settings + Bot Confirmation screens
  const app = createExpressApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = (server.address() as { port: number }).port;
    const authHeader = `Basic ${Buffer.from('testowner:test-strong-password-999').toString('base64')}`;

    const putDescRes = await fetch(`http://127.0.0.1:${port}/api/admin/settings/confirmation-description`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Pastikan nomor aktif sebelum membayar.' }),
    });
    assert.equal(putDescRes.status, 200);
    const putDescJson = (await putDescRes.json()) as { ok: boolean; data: { confirmationDescription: string | null } };
    assert.equal(putDescJson.data.confirmationDescription, 'Pastikan nomor aktif sebelum membayar.');

    const prodSaveRes = await fetch(`http://127.0.0.1:${port}/api/admin/products`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: 'TSEL10',
        name: 'Telkomsel 10.000',
        supplierPrice: 10200,
        description: 'Proses otomatis 1-3 menit.',
      }),
    });
    assert.equal(prodSaveRes.status, 201);

    const settingsRes = await fetch(`http://127.0.0.1:${port}/api/admin/settings`, {
      headers: { Authorization: authHeader },
    });
    assert.equal(settingsRes.status, 200);
    const settingsJson = (await settingsRes.json()) as { ok: boolean; data: { confirmationDescription: string | null } };
    assert.equal(settingsJson.data.confirmationDescription, 'Pastikan nomor aktif sebelum membayar.');

    // Check Telegram confirmation displays both descriptions & button emojis
    await runBotDemoInteraction({
      platform: 'TELEGRAM',
      senderRole: 'CUSTOMER',
      inputType: 'CALLBACK',
      callbackData: 'BUY_SKU_TSEL10',
      senderId: '88221102',
      actor,
    });
    const tgConfirmWithDesc = await runBotDemoInteraction({
      platform: 'TELEGRAM',
      senderRole: 'CUSTOMER',
      inputType: 'TEXT',
      text: '081234560202',
      senderId: '88221102',
      actor,
    });
    assert.ok(tgConfirmWithDesc.replies[0].text.includes('Keterangan: Proses otomatis 1-3 menit.'));
    assert.ok(tgConfirmWithDesc.replies[0].text.includes('Catatan: Pastikan nomor aktif sebelum membayar.'));
    const tgConfirmBtnTexts = (tgConfirmWithDesc.replies[0].buttons || []).flat().map((b) => b.text);
    assert.ok(tgConfirmBtnTexts.some((t) => t.includes('✅') && t.includes('Buat QRIS')));
    assert.ok(tgConfirmBtnTexts.some((t) => t.includes('❌') && t.includes('Batal')));

    // Check WhatsApp confirmation displays both descriptions
    const waConfirmWithDesc = await runBotDemoInteraction({
      platform: 'WHATSAPP',
      senderRole: 'CUSTOMER',
      inputType: 'TEXT',
      text: '!order TSEL10 081234560202',
      senderId: '6281200020202',
      actor,
    });
    assert.ok(waConfirmWithDesc.replies[0].text.includes('Keterangan: Proses otomatis 1-3 menit.'));
    assert.ok(waConfirmWithDesc.replies[0].text.includes('Catatan: Pastikan nomor aktif sebelum membayar.'));

    // 3. Clearing both removes lines cleanly again
    await fetch(`http://127.0.0.1:${port}/api/admin/settings/confirmation-description`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: null }),
    });
    updateProductDescription('TSEL10', null, actor);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Telegram-Only Admin Config Menus (Deskripsi, Refresh Harga, Margin, Kredit Saldo, Voucher, Bot WA) & RBAC', async () => {
  const { dispatchTelegramCommand, TG_NAV_BACK_BUTTONS } = await import('../bots/telegram.command-handler');
  const { dispatchTelegramCallback } = await import('../bots/telegram.callback-handler');
  const { TG_ADMIN_MENU_BUTTONS, TG_ADMIN_CONFIG_BUTTONS } = await import('../bots/telegram.admin-config');
  const { createAdmin } = await import('./admin.service');
  const { resolveOrCreateCustomer, getCustomerRefundCreditTotal } = await import('./customer.service');
  const { getConfirmationDescription } = await import('./settings.service');
  const { getGlobalMarginRule, getProductBySkuOrId } = await import('./product.service');
  const { listCoupons } = await import('./coupon.service');
  const { handleWhatsappCommand, clearWhatsappCooldown } = await import('../bots/whatsapp.command-handler');

  clearWhatsappCooldown();

  // Verify every button across TG Admin / Config / Nav menus starts with an emoji symbol
  for (const btn of [...TG_ADMIN_MENU_BUTTONS.flat(), ...TG_ADMIN_CONFIG_BUTTONS.flat(), ...TG_NAV_BACK_BUTTONS.flat()]) {
    assert.match(btn.text, /^[^\w\s]/, `Menu button "${btn.text}" should start with an emoji`);
  }

  // Register a Telegram Admin user ID and a target customer
  const adminTgId = '99007701';
  createAdmin(
    { name: 'TG Config Admin', role: 'OWNER', platform: 'TELEGRAM', platformUserId: adminTgId },
    { id: 'testowner', role: 'OWNER' }
  );
  const { customer: cust } = resolveOrCreateCustomer({
    platform: 'TELEGRAM',
    platformUserId: '55110022',
    platformUsername: '@cust_tg_bal',
  });

  // 1. Unauthorized normal customer cannot access /konfigurasi or ADMIN_CONFIG_MENU
  const unauthReplies: string[] = [];
  await dispatchTelegramCommand(
    { async reply(text) { unauthReplies.push(text); } },
    { userId: '55110022', username: '@cust_tg_bal', text: '/konfigurasi' }
  );
  assert.match(unauthReplies[0], /akses ditolak/i);

  const unauthCbReplies: string[] = [];
  await dispatchTelegramCallback(
    { async reply(text) { unauthCbReplies.push(text); }, async answerCbQuery() {} },
    { data: 'ADMIN_CONFIG_MENU', userId: '55110022', username: '@cust_tg_bal' }
  );
  assert.match(unauthCbReplies[0], /akses.*ditolak/i);

  // 2. Admin /admin & ADMIN_CONFIG_MENU exposes all 6 required config menus
  const adminPanelReplies: Array<{ text: string; buttons?: Array<Array<{ text: string; callbackData?: string }>> }> = [];
  await dispatchTelegramCommand(
    {
      async reply(text, buttons) {
        adminPanelReplies.push({ text, buttons });
      },
    },
    { userId: adminTgId, username: '@owner_tg', text: '/admin' }
  );
  const panelBtnTexts = (adminPanelReplies[0].buttons || []).flat().map((b) => b.text);
  assert.ok(panelBtnTexts.includes('⚙️ Konfigurasi Bot'));

  const cfgReplies: Array<{ text: string; buttons?: Array<Array<{ text: string; callbackData?: string }>> }> = [];
  const sendCmd = async (text: string) => {
    await dispatchTelegramCommand(
      {
        async reply(replyText, buttons) {
          cfgReplies.push({ text: replyText, buttons });
        },
      },
      { userId: adminTgId, username: '@owner_tg', text }
    );
  };
  const sendCb = async (data: string) => {
    await dispatchTelegramCallback(
      {
        async reply(replyText, buttons) {
          cfgReplies.push({ text: replyText, buttons });
        },
        async answerCbQuery() {},
      },
      { data, userId: adminTgId, username: '@owner_tg' }
    );
  };

  await sendCb('ADMIN_CONFIG_MENU');
  const cfgBtnTexts = (cfgReplies.at(-1)?.buttons || []).flat().map((b) => b.text);
  assert.deepEqual(cfgBtnTexts, [
    '📝 Set Deskripsi',
    '🔄 Refresh Harga',
    '💹 Set Margin',
    '💳 Set Saldo User',
    '🎟️ Buat Voucher',
    '🤖 Set Bot WA',
    '🔙 Kembali ke Admin',
  ]);

  // 3. Interactive Set Deskripsi Global + Per-SKU
  await sendCb('ADMIN_CFG_DESC_GLOBAL');
  await sendCmd('Catatan via Telegram Admin');
  assert.equal(getConfirmationDescription(), 'Catatan via Telegram Admin');
  await sendCb('ADMIN_CFG_DESC_CLEAR');
  assert.equal(getConfirmationDescription(), null);

  await sendCb('ADMIN_CFG_DESC_PRODUCT');
  await sendCmd('TSEL10 | Deskripsi SKU dari Telegram');
  assert.equal(getProductBySkuOrId('TSEL10')?.description, 'Deskripsi SKU dari Telegram');

  // 4. Interactive Set Margin
  await sendCb('ADMIN_CFG_MARGIN_PERCENT');
  await sendCmd('6 2500');
  const updatedMargin = getGlobalMarginRule();
  assert.equal(updatedMargin.type, 'PERCENT');
  assert.equal(updatedMargin.value, 6);
  assert.equal(updatedMargin.maxMargin, 2500);

  // 5. Interactive Set Saldo User (Kredit Refund Internal)
  await sendCb('ADMIN_CFG_BALANCE');
  const balBefore = getCustomerRefundCreditTotal(cust.id);
  await sendCmd(`${cust.customer_code} +15000 Kompensasi admin telegram`);
  assert.equal(getCustomerRefundCreditTotal(cust.id), balBefore + 15000);
  assert.match(cfgReplies.at(-1)!.text, /Saldo Kredit Refund Internal Diperbarui/);

  // 6. Interactive Buat Voucher
  await sendCb('ADMIN_CFG_VOUCHER');
  await sendCmd('TGBOT15 FIXED 2000 10 0 0 Voucher Khusus TG');
  const createdVoucher = listCoupons().find((c) => c.code === 'TGBOT15');
  assert.ok(createdVoucher);
  assert.equal(createdVoucher.discount_type, 'FIXED');
  assert.equal(createdVoucher.discount_value, 2000);

  // 7. Interactive Set Bot WA menu & Refresh Harga Demo simulation
  await sendCb('ADMIN_CFG_WABOT');
  const waMenuBtns = (cfgReplies.at(-1)?.buttons || []).flat().map((b) => b.text);
  assert.ok(waMenuBtns.includes('🔄 Reconnect WA'));
  assert.ok(waMenuBtns.includes('🧹 Reset Sesi WA'));
  assert.ok(waMenuBtns.includes('🔑 Minta Pairing Code'));

  const syncDemo = await runBotDemoInteraction({
    platform: 'TELEGRAM',
    senderRole: 'ADMIN',
    inputType: 'CALLBACK',
    callbackData: 'ADMIN_CFG_SYNC',
    actor: { id: 'testowner', role: 'OWNER' },
  });
  assert.match(syncDemo.replies[0].text, /Refresh Harga Digiflazz/);

  // 8. Verify Telegram-only config commands do NOT exist on WhatsApp bot
  const waConfigReplies: string[] = [];
  await handleWhatsappCommand(
    {
      async sendMessage(_jid, content) {
        waConfigReplies.push('text' in content ? content.text : content.caption || '');
        return undefined;
      },
    },
    '62899007701',
    '!konfigurasi',
    'Admin WA',
    { now: 99_000 }
  );
  assert.match(waConfigReplies[0], /belum memahami perintah "!konfigurasi"/i);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});


