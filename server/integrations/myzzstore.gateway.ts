import crypto from 'node:crypto';
import { config } from '../config/env';
import { logger } from '../logging/logger';

export type GatewayPaymentState = 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'FAILED' | 'UNKNOWN';

export interface CreatePaymentInput {
  transactionId: string;
  amount: number;
  productName: string;
  customerCode: string;
  expiredAt: string;
  callbackUrl: string;
}

export interface CreatePaymentResult {
  ok: boolean;
  gatewayReference?: string;
  qrString?: string;
  qrUrl?: string;
  rawStatus?: string;
  mappedStatus: GatewayPaymentState;
  expiresAt?: string;
  safeMetadata?: Record<string, unknown>;
  errorCode?: 'INTEGRATION_NOT_CONFIGURED' | 'GATEWAY_TIMEOUT' | 'GATEWAY_HTTP_ERROR' | 'INVALID_RESPONSE';
  errorMessage?: string;
}

export interface CheckPaymentStatusResult {
  ok: boolean;
  gatewayReference?: string;
  mappedStatus: GatewayPaymentState;
  paidAmount?: number;
  paidAt?: string;
  rawStatus?: string;
  safeMetadata?: Record<string, unknown>;
  errorMessage?: string;
}

export interface VerifiedCallbackEvent {
  valid: boolean;
  reason?: string;
  eventId?: string;
  gatewayReference?: string;
  transactionId?: string;
  amount?: number;
  mappedStatus: GatewayPaymentState;
  rawStatus?: string;
  paidAt?: string;
  safePayload: Record<string, unknown>;
}

export interface CancelPaymentResult {
  ok: boolean;
  supported: boolean;
  mappedStatus: GatewayPaymentState;
  errorMessage?: string;
}

export interface PaymentGatewayPort {
  isConfigured(): boolean;
  getMissingConfiguration(): string[];
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  checkPaymentStatus(gatewayReference: string, transactionId: string, amount?: number): Promise<CheckPaymentStatusResult>;
  verifyCallback(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    parsedBody: unknown
  ): VerifiedCallbackEvent;
  cancelPayment(gatewayReference: string, transactionId: string): Promise<CancelPaymentResult>;
}

export class MyZZStoreGateway implements PaymentGatewayPort {
  isConfigured(): boolean {
    return this.getMissingConfiguration().length === 0;
  }

  getMissingConfiguration(): string[] {
    const missing: string[] = [];
    if (!config.paymentGateway.apiKey) missing.push('PAYMENT_GATEWAY_API_KEY');
    if (!config.paymentGateway.createPath) missing.push('PAYMENT_GATEWAY_CREATE_PATH');
    if (!config.paymentGateway.statusPath) missing.push('PAYMENT_GATEWAY_STATUS_PATH');
    return missing;
  }

  parseGatewayResponse(raw: unknown): {
    status: GatewayPaymentState;
    gatewayReference?: string;
    qrString?: string;
    qrUrl?: string;
    paidAmount?: number;
    paidAt?: string;
    rawStatus?: string;
    expiresAt?: string;
  } {
    if (!raw || typeof raw !== 'object') {
      return { status: 'UNKNOWN' };
    }
    const obj = raw as Record<string, unknown>;
    const data = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;

    const rawStatusStr = String(
      data.status ?? data.payment_status ?? data.transaction_status ?? (typeof obj.status === 'string' ? obj.status : '')
    ).trim();
    const upper = rawStatusStr.toUpperCase();

    const isTrueFlag = (val: unknown): boolean =>
      val === true ||
      val === 1 ||
      (typeof val === 'string' && ['true', '1', 'yes', 'paid', 'lunas'].includes(val.trim().toLowerCase()));
    const isFalseFlag = (val: unknown): boolean =>
      val === false ||
      val === 0 ||
      (typeof val === 'string' && ['false', '0', 'no', 'unpaid', 'pending'].includes(val.trim().toLowerCase()));

    let status: GatewayPaymentState = 'UNKNOWN';
    if (
      isTrueFlag(data.paid) ||
      isTrueFlag(obj.paid) ||
      isTrueFlag(data.is_paid) ||
      isTrueFlag(obj.is_paid) ||
      isTrueFlag(data.lunas) ||
      isTrueFlag(obj.lunas) ||
      ['PAID', 'SUCCESS', 'SETTLED', 'COMPLETED', 'BERHASIL', 'LUNAS'].includes(upper)
    ) {
      status = 'PAID';
    } else if (
      ['PENDING', 'UNPAID', 'WAITING', 'OPEN', 'CREATED'].includes(upper) ||
      isFalseFlag(data.paid) ||
      isFalseFlag(obj.paid) ||
      isFalseFlag(data.is_paid) ||
      isFalseFlag(obj.is_paid)
    ) {
      status = 'PENDING';
    } else if (['EXPIRED', 'TIMEOUT'].includes(upper)) {
      status = 'EXPIRED';
    } else if (['CANCELLED', 'CANCELED', 'VOID'].includes(upper)) {
      status = 'CANCELLED';
    } else if (['FAILED', 'ERROR', 'REJECTED'].includes(upper)) {
      status = 'FAILED';
    }

    const pickStringOrNumberId = (val: unknown): string | undefined => {
      if (typeof val === 'string' && val.trim() !== '') return val.trim();
      if (typeof val === 'number' && Number.isFinite(val)) return String(val);
      return undefined;
    };

    const gatewayReference =
      pickStringOrNumberId(data.trx_id) ??
      pickStringOrNumberId(data.trxId) ??
      pickStringOrNumberId(data.id_transaksi) ??
      pickStringOrNumberId(data.reference) ??
      pickStringOrNumberId(data.ref_id) ??
      pickStringOrNumberId(data.invoice_id) ??
      pickStringOrNumberId(data.transaction_id) ??
      pickStringOrNumberId(data.id) ??
      pickStringOrNumberId(data.order_id) ??
      pickStringOrNumberId(obj.trx_id) ??
      pickStringOrNumberId(obj.trxId) ??
      pickStringOrNumberId(obj.id_transaksi) ??
      pickStringOrNumberId(obj.reference) ??
      pickStringOrNumberId(obj.order_id) ??
      pickStringOrNumberId(obj.id);

    const pickStr = (...vals: unknown[]): string | undefined => {
      for (const v of vals) {
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return undefined;
    };

    const qrString = pickStr(
      data.qr_string,
      data.qris_content,
      data.qr_code,
      data.qris_string,
      obj.qr_string,
      obj.qris_content,
      obj.qr_code,
      obj.qris_string
    );

    const qrUrl = pickStr(
      data.qris_url,
      data.qr_url,
      data.qrisUrl,
      data.qr_image,
      obj.qris_url,
      obj.qr_url,
      obj.qrisUrl,
      obj.qr_image
    );

    const paidAmountRaw = data.amount ?? data.total_amount ?? data.nominal;
    const paidAmount =
      typeof paidAmountRaw === 'number' && Number.isFinite(paidAmountRaw)
        ? paidAmountRaw
        : typeof paidAmountRaw === 'string' && paidAmountRaw.trim() !== '' && Number.isFinite(Number(paidAmountRaw))
        ? Number(paidAmountRaw)
        : undefined;

    const paidAt = typeof data.paid_at === 'string' ? data.paid_at : undefined;
    const expiresAt = typeof data.expired_at === 'string' ? data.expired_at : undefined;

    return {
      status,
      gatewayReference,
      qrString,
      qrUrl,
      paidAmount,
      paidAt,
      rawStatus: rawStatusStr || undefined,
      expiresAt,
    };
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const missing = this.getMissingConfiguration();
    if (missing.length > 0) {
      return {
        ok: false,
        mappedStatus: 'FAILED',
        errorCode: 'INTEGRATION_NOT_CONFIGURED',
        errorMessage: `MyZZStore gateway belum terkonfigurasi atau dokumentasi endpoint belum lengkap: ${missing.join(', ')}`,
      };
    }

    const createPath = config.paymentGateway.createPath || '/create-qris';
    const urlObj = new URL(
      `${config.paymentGateway.baseUrl}${createPath.startsWith('/') ? '' : '/'}${createPath}`
    );
    if (config.paymentGateway.merchantId) {
      urlObj.searchParams.set('merchant_id', config.paymentGateway.merchantId);
    }
    urlObj.searchParams.set('order_id', input.transactionId);
    urlObj.searchParams.set('amount', String(input.amount));
    if (config.paymentGateway.apiKey) {
      urlObj.searchParams.set('api_key', config.paymentGateway.apiKey);
    }
    urlObj.searchParams.set('payment_method', 'QRIS');
    urlObj.searchParams.set('description', input.productName);
    urlObj.searchParams.set('customer_code', input.customerCode);
    urlObj.searchParams.set('expired_at', input.expiredAt);
    if (input.callbackUrl) {
      urlObj.searchParams.set('callback_url', input.callbackUrl);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Api-Key': config.paymentGateway.apiKey,
    };
    if (config.paymentGateway.merchantId) {
      headers['X-Merchant-Id'] = config.paymentGateway.merchantId;
    }
    if (config.paymentGateway.secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = crypto
        .createHmac('sha256', config.paymentGateway.secret)
        .update(`${config.paymentGateway.merchantId || ''}:${input.transactionId}:${input.amount}:${timestamp}`)
        .digest('hex');
      headers['X-Timestamp'] = timestamp;
      headers['X-Signature'] = signature;
    }

    try {
      const response = await fetch(urlObj.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(config.paymentGateway.timeoutMs),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok || !body) {
        logger.warn('MyZZStore createPayment non-OK HTTP response', {
          service: 'myzzstore',
          transactionId: input.transactionId,
          details: { status: response.status },
        });
        return {
          ok: false,
          mappedStatus: response.status >= 500 ? 'UNKNOWN' : 'FAILED',
          errorCode: 'GATEWAY_HTTP_ERROR',
          errorMessage: `Gateway HTTP ${response.status}`,
        };
      }

      const parsed = this.parseGatewayResponse(body);
      console.log(
        `[MyZZStore] createPayment extracted trx_id=${parsed.gatewayReference ?? 'NONE'} internal_tx=${input.transactionId} amount=${input.amount}`
      );
      if (!parsed.gatewayReference || (!parsed.qrString && !parsed.qrUrl)) {
        return {
          ok: false,
          mappedStatus: 'UNKNOWN',
          errorCode: 'INVALID_RESPONSE',
          errorMessage: 'Respons gateway tidak menyertakan trx_id atau qris_url resmi',
        };
      }

      return {
        ok: true,
        gatewayReference: parsed.gatewayReference,
        qrString: parsed.qrString,
        qrUrl: parsed.qrUrl,
        rawStatus: parsed.rawStatus,
        mappedStatus: parsed.status === 'UNKNOWN' ? 'PENDING' : parsed.status,
        expiresAt: parsed.expiresAt || input.expiredAt,
        safeMetadata: {
          gatewayReference: parsed.gatewayReference,
          rawStatus: parsed.rawStatus,
        },
      };
    } catch (err) {
      const errObj = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      const causeCode = typeof errObj?.cause?.code === 'string' ? errObj.cause.code : '';
      const isTimeout =
        errObj?.name === 'TimeoutError' ||
        errObj?.name === 'AbortError' ||
        causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
        causeCode === 'ETIMEDOUT';
      const safeDetail = causeCode || (isTimeout ? 'timeout' : errObj?.message || 'network_error');
      logger.error('MyZZStore createPayment failed', {
        service: 'myzzstore',
        transactionId: input.transactionId,
        details: { isTimeout, causeCode: causeCode || undefined, message: errObj?.message || 'unknown' },
      });
      return {
        ok: false,
        mappedStatus: 'UNKNOWN',
        errorCode: isTimeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_HTTP_ERROR',
        errorMessage: isTimeout
          ? `Request ke MyZZStore timeout (${safeDetail})`
          : `Gagal menghubungi MyZZStore (${safeDetail})`,
      };
    }
  }

  async checkPaymentStatus(
    gatewayReference: string,
    transactionId: string,
    amount?: number
  ): Promise<CheckPaymentStatusResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        gatewayReference,
        mappedStatus: 'UNKNOWN',
        errorMessage: 'MyZZStore gateway belum terkonfigurasi',
      };
    }

    const effectiveGatewayId = (gatewayReference || '').trim();
    if (!effectiveGatewayId) {
      console.log(
        `[MyZZStore] checkPaymentStatus ABORTED: trx_id Gateway kosong untuk transaksi internal=${transactionId}`
      );
      return {
        ok: false,
        gatewayReference: '',
        mappedStatus: 'UNKNOWN',
        errorMessage: `trx_id (order_id) Gateway tidak ditemukan untuk transaksi ${transactionId}`,
      };
    }

    const statusPath = config.paymentGateway.statusPath || '/check-payment';
    const hasPathPlaceholder =
      statusPath.includes(':trx_id') ||
      statusPath.includes(':reference') ||
      statusPath.includes(':order_id');
    const rawPath = statusPath
      .replace(':trx_id', encodeURIComponent(effectiveGatewayId))
      .replace(':reference', encodeURIComponent(effectiveGatewayId))
      .replace(':order_id', encodeURIComponent(effectiveGatewayId));
    const urlObj = new URL(`${config.paymentGateway.baseUrl}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`);
    if (!hasPathPlaceholder) {
      urlObj.searchParams.set('trx_id', effectiveGatewayId);
    }
    if (amount !== undefined && Number.isFinite(amount)) {
      urlObj.searchParams.set('amount', String(amount));
    }
    if (config.paymentGateway.apiKey) {
      urlObj.searchParams.set('api_key', config.paymentGateway.apiKey);
    }

    const maskedUrl = new URL(urlObj.toString());
    if (maskedUrl.searchParams.has('api_key')) {
      maskedUrl.searchParams.set('api_key', '[REDACTED]');
    }
    console.log(
      `[MyZZStore] checkPaymentStatus sending trx_id=${effectiveGatewayId} (internal_tx=${transactionId}, amount=${amount ?? '-'}) -> ${maskedUrl.toString()}`
    );

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Api-Key': config.paymentGateway.apiKey,
      };
      if (config.paymentGateway.merchantId) {
        headers['X-Merchant-Id'] = config.paymentGateway.merchantId;
      }
      const response = await fetch(urlObj.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(config.paymentGateway.timeoutMs),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok || !body) {
        console.log(
          `[MyZZStore] checkPaymentStatus non-OK response trx_id=${effectiveGatewayId} httpStatus=${response.status}`
        );
        return {
          ok: false,
          gatewayReference: effectiveGatewayId,
          mappedStatus: 'UNKNOWN',
          errorMessage: `Gateway status HTTP ${response.status}`,
        };
      }

      const parsed = this.parseGatewayResponse(body);
      const rootObj = body as Record<string, unknown>;
      const dataObj =
        rootObj.data && typeof rootObj.data === 'object' ? (rootObj.data as Record<string, unknown>) : rootObj;
      console.log(
        `[MyZZStore] checkPaymentStatus response trx_id=${effectiveGatewayId} mappedStatus=${parsed.status} paid=${String(
          dataObj?.paid ?? rootObj?.paid ?? '-'
        )} rawStatus=${parsed.rawStatus ?? '-'}`
      );
      return {
        ok: true,
        gatewayReference: parsed.gatewayReference || effectiveGatewayId,
        mappedStatus: parsed.status,
        paidAmount: parsed.paidAmount,
        paidAt: parsed.paidAt,
        rawStatus: parsed.rawStatus,
        safeMetadata: { rawStatus: parsed.rawStatus },
      };
    } catch (err) {
      console.log(
        `[MyZZStore] checkPaymentStatus error trx_id=${effectiveGatewayId} err=${err instanceof Error ? err.message : 'unknown'}`
      );
      return {
        ok: false,
        gatewayReference: effectiveGatewayId,
        mappedStatus: 'UNKNOWN',
        errorMessage: err instanceof Error ? err.message : 'Gateway status check error',
      };
    }
  }

  verifyCallback(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    parsedBody: unknown
  ): VerifiedCallbackEvent {
    const callbackSecret = config.paymentGateway.callbackSecret;
    const safePayload =
      parsedBody && typeof parsedBody === 'object' ? (parsedBody as Record<string, unknown>) : {};

    if (!callbackSecret) {
      return {
        valid: false,
        reason: 'PAYMENT_GATEWAY_CALLBACK_SECRET not configured',
        mappedStatus: 'UNKNOWN',
        safePayload,
      };
    }

    const headerSigRaw =
      headers['x-callback-signature'] ||
      headers['x-signature'] ||
      headers['x-myzzstore-signature'];
    const receivedSig = Array.isArray(headerSigRaw) ? headerSigRaw[0] : headerSigRaw;

    if (!receivedSig || typeof receivedSig !== 'string') {
      return {
        valid: false,
        reason: 'Missing callback signature header',
        mappedStatus: 'UNKNOWN',
        safePayload,
      };
    }

    const expectedSig = crypto
      .createHmac('sha256', callbackSecret)
      .update(rawBody)
      .digest('hex');

    const a = Buffer.from(receivedSig.trim().toLowerCase(), 'utf8');
    const b = Buffer.from(expectedSig.toLowerCase(), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return {
        valid: false,
        reason: 'Invalid callback HMAC signature',
        mappedStatus: 'UNKNOWN',
        safePayload,
      };
    }

    const parsed = this.parseGatewayResponse(parsedBody);
    const data = (safePayload.data && typeof safePayload.data === 'object'
      ? safePayload.data
      : safePayload) as Record<string, unknown>;

    const transactionId =
      typeof data.order_id === 'string'
        ? data.order_id
        : typeof data.transaction_id === 'string'
        ? data.transaction_id
        : undefined;

    const eventId =
      typeof data.event_id === 'string'
        ? data.event_id
        : crypto.createHash('sha256').update(rawBody).digest('hex');

    const merchantId = typeof data.merchant_id === 'string' ? data.merchant_id : undefined;
    if (config.paymentGateway.merchantId && merchantId && merchantId !== config.paymentGateway.merchantId) {
      return {
        valid: false,
        reason: 'Merchant ID mismatch',
        mappedStatus: 'UNKNOWN',
        safePayload,
      };
    }

    return {
      valid: true,
      eventId,
      gatewayReference: parsed.gatewayReference,
      transactionId,
      amount: parsed.paidAmount,
      mappedStatus: parsed.status,
      rawStatus: parsed.rawStatus,
      paidAt: parsed.paidAt,
      safePayload,
    };
  }

  async cancelPayment(gatewayReference: string, transactionId: string): Promise<CancelPaymentResult> {
    if (!config.paymentGateway.cancelPath || !this.isConfigured()) {
      return {
        ok: false,
        supported: false,
        mappedStatus: 'UNKNOWN',
        errorMessage: 'Cancel endpoint not configured',
      };
    }

    const cancelUrlObj = new URL(
      `${config.paymentGateway.baseUrl}${config.paymentGateway.cancelPath.startsWith('/') ? '' : '/'}${config.paymentGateway.cancelPath}`
    );
    if (config.paymentGateway.merchantId) {
      cancelUrlObj.searchParams.set('merchant_id', config.paymentGateway.merchantId);
    }
    if (config.paymentGateway.apiKey) {
      cancelUrlObj.searchParams.set('api_key', config.paymentGateway.apiKey);
    }
    if (gatewayReference) {
      cancelUrlObj.searchParams.set('trx_id', gatewayReference);
    }
    if (transactionId) {
      cancelUrlObj.searchParams.set('order_id', transactionId);
    }
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Api-Key': config.paymentGateway.apiKey,
      };
      if (config.paymentGateway.merchantId) {
        headers['X-Merchant-Id'] = config.paymentGateway.merchantId;
      }
      const response = await fetch(cancelUrlObj.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(config.paymentGateway.timeoutMs),
      });

      if (!response.ok) {
        return {
          ok: false,
          supported: true,
          mappedStatus: 'UNKNOWN',
          errorMessage: `Cancel HTTP ${response.status}`,
        };
      }
      return { ok: true, supported: true, mappedStatus: 'CANCELLED' };
    } catch (err) {
      return {
        ok: false,
        supported: true,
        mappedStatus: 'UNKNOWN',
        errorMessage: err instanceof Error ? err.message : 'Cancel request error',
      };
    }
  }
}

export const defaultPaymentGateway = new MyZZStoreGateway();
