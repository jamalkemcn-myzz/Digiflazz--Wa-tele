import crypto from 'node:crypto';
import { config } from '../config/env';
import { logger } from '../logging/logger';

export interface DigiflazzPriceItem {
  buyer_sku_code: string;
  product_name: string;
  category: string;
  brand: string;
  type: string;
  price: number;
  buyer_product_status: boolean;
  seller_product_status: boolean;
  unlimited_stock?: boolean;
  stock?: number;
}

export type DigiflazzMappedStatus = 'SUCCESS' | 'PENDING' | 'FAILED' | 'UNKNOWN';

export interface DigiflazzTxResponse {
  ok: boolean;
  mappedStatus: DigiflazzMappedStatus;
  refId: string;
  rc?: string;
  rawStatus?: string;
  sn?: string;
  message?: string;
  price?: number;
  errorMessage?: string;
}

export interface DigiflazzPostpaidPriceItem {
  buyer_sku_code: string;
  product_name: string;
  category?: string;
  brand?: string;
  seller_name?: string;
  admin?: number;
  commission?: number;
  buyer_product_status?: boolean;
  seller_product_status?: boolean;
  desc?: string;
}

export interface DigiflazzPostpaidInquiryResponse {
  ok: boolean;
  refId: string;
  httpStatus: number;
  rc?: string;
  rawStatus?: string;
  message?: string;
  customerName?: string;
  customerNo?: string;
  buyerSkuCode?: string;
  price?: number;
  admin?: number;
  sellingPrice?: number;
  sn?: string;
  desc?: unknown;
  rawBody?: unknown;
  errorMessage?: string;
}

export interface DigiflazzPort {
  isConfigured(): boolean;
  fetchPriceList(): Promise<{ ok: boolean; items: DigiflazzPriceItem[]; errorMessage?: string }>;
  fetchPostpaidPriceList?(): Promise<{ ok: boolean; items: DigiflazzPostpaidPriceItem[]; errorMessage?: string }>;
  createTransaction(params: {
    sku: string;
    destination: string;
    refId: string;
  }): Promise<DigiflazzTxResponse>;
  inquireTransaction(params: {
    sku: string;
    destination: string;
    refId: string;
  }): Promise<DigiflazzTxResponse>;
  inquirePostpaidBill?(params: {
    sku: string;
    customerNo: string;
    refId?: string;
    testing?: boolean;
  }): Promise<DigiflazzPostpaidInquiryResponse>;
  checkBalance(): Promise<{ ok: boolean; balance?: number; errorMessage?: string }>;
}

export function mapDigiflazzStatus(rawStatus?: string): DigiflazzMappedStatus {
  const normalized = (rawStatus || '').trim().toLowerCase();
  if (normalized === 'sukses' || normalized === 'success') return 'SUCCESS';
  if (normalized === 'pending') return 'PENDING';
  if (normalized === 'gagal' || normalized === 'failed') return 'FAILED';
  return 'UNKNOWN';
}

// Digiflazz definitive pre-execution / validation rejection response codes (never 03=Pending, 47=Duplicate/Exists, 99=Router Issue)
const DEFINITIVE_DIGIFLAZZ_REJECTION_RCS = new Set([
  '40', '41', '42', '43', '44', '45', '46', '49',
  '50', '51', '52', '53', '54', '55', '56', '57', '58', '59',
  '60', '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '70', '71', '72', '73', '74',
  '80', '81', '82', '83', '84', '85', '86',
]);

function formatDigiflazzErrorMessage(params: {
  httpStatus: number;
  rc?: string;
  message?: string;
}): string {
  const rcPart = params.rc ? `RC ${params.rc}` : '';
  const msgPart = (params.message || '').trim();
  if (rcPart && msgPart) {
    return `[${rcPart}] ${msgPart}`;
  }
  if (msgPart) {
    return params.httpStatus >= 400 ? `Digiflazz HTTP ${params.httpStatus}: ${msgPart}` : msgPart;
  }
  if (rcPart) {
    return `Digiflazz HTTP ${params.httpStatus} [${rcPart}]`;
  }
  return `Digiflazz HTTP ${params.httpStatus}`;
}

export class DigiflazzClient implements DigiflazzPort {
  isConfigured(): boolean {
    return Boolean(config.digiflazz.username && config.digiflazz.apiKey);
  }

  private sign(suffix: string): string {
    return crypto
      .createHash('md5')
      .update(`${config.digiflazz.username}${config.digiflazz.apiKey}${suffix}`)
      .digest('hex');
  }

  private async postJsonRaw<T>(
    endpointPath: string,
    payload: Record<string, unknown>
  ): Promise<{ httpOk: boolean; httpStatus: number; body: T | null; rawText?: string }> {
    const url = `${config.digiflazz.baseUrl}${endpointPath}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.digiflazz.timeoutMs),
    });

    const rawText = await response.text().catch(() => '');
    let parsed: T | null = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as T;
      } catch {
        parsed = null;
      }
    }

    return {
      httpOk: response.ok,
      httpStatus: response.status,
      body: parsed,
      rawText: rawText ? rawText.slice(0, 300) : undefined,
    };
  }

  async fetchPriceList(): Promise<{ ok: boolean; items: DigiflazzPriceItem[]; errorMessage?: string }> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        items: [],
        errorMessage: 'Kredensial Digiflazz (DIGIFLAZZ_USERNAME / DIGIFLAZZ_API_KEY) belum dikonfigurasi',
      };
    }

    try {
      const res = await this.postJsonRaw<{
        message?: string;
        data?: DigiflazzPriceItem[] | { message?: string; rc?: string };
      }>('/price-list', {
        cmd: 'prepaid',
        username: config.digiflazz.username,
        sign: this.sign('pricelist'),
      });

      if (!res.httpOk || !res.body || !Array.isArray(res.body.data)) {
        const dataObj =
          res.body?.data && !Array.isArray(res.body.data) ? res.body.data : undefined;
        const msg = formatDigiflazzErrorMessage({
          httpStatus: res.httpStatus,
          rc: dataObj?.rc,
          message: dataObj?.message || res.body?.message || res.rawText || 'Format respons price-list Digiflazz tidak valid',
        });
        logger.warn('Digiflazz fetchPriceList failed', {
          service: 'digiflazz',
          details: { httpStatus: res.httpStatus, error: msg },
        });
        return { ok: false, items: [], errorMessage: msg };
      }

      return { ok: true, items: res.body.data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal mengambil price list Digiflazz';
      logger.error('Digiflazz fetchPriceList failed', {
        service: 'digiflazz',
        details: { error: msg },
      });
      return { ok: false, items: [], errorMessage: msg };
    }
  }

  private async sendTxRequest(params: {
    sku: string;
    destination: string;
    refId: string;
  }): Promise<DigiflazzTxResponse> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        mappedStatus: 'UNKNOWN',
        refId: params.refId,
        errorMessage: 'Kredensial Digiflazz belum dikonfigurasi',
      };
    }

    try {
      const res = await this.postJsonRaw<{
        message?: string;
        rc?: string;
        status?: string;
        data?: {
          ref_id?: string;
          status?: string;
          rc?: string;
          sn?: string;
          message?: string;
          price?: number;
        };
      }>('/transaction', {
        username: config.digiflazz.username,
        buyer_sku_code: params.sku,
        customer_no: params.destination,
        ref_id: params.refId,
        sign: this.sign(params.refId),
      });

      const d = res.body?.data && typeof res.body.data === 'object' ? res.body.data : undefined;
      const rc = d?.rc ?? res.body?.rc;
      const rawStatus = d?.status ?? res.body?.status;
      const rawMessage = d?.message ?? res.body?.message ?? (!res.body ? res.rawText : undefined);

      if (!d && !res.body) {
        const msg = formatDigiflazzErrorMessage({ httpStatus: res.httpStatus, message: rawMessage });
        logger.warn('Digiflazz empty/non-JSON response; marking UNKNOWN', {
          service: 'digiflazz',
          transactionId: params.refId,
          details: { httpStatus: res.httpStatus, error: msg },
        });
        return {
          ok: false,
          mappedStatus: 'UNKNOWN',
          refId: params.refId,
          errorMessage: msg,
        };
      }

      let mappedStatus = mapDigiflazzStatus(rawStatus);
      // Guard: RC 99 = Digiflazz router/server issue (never treat as definitive FAILED); RC 03 = Pending
      if (rc === '99') {
        mappedStatus = 'UNKNOWN';
      } else if (rc === '03' && mappedStatus === 'UNKNOWN') {
        mappedStatus = 'PENDING';
      } else if (
        mappedStatus === 'UNKNOWN' &&
        res.httpStatus >= 400 &&
        res.httpStatus < 500 &&
        rc &&
        DEFINITIVE_DIGIFLAZZ_REJECTION_RCS.has(String(rc).trim())
      ) {
        mappedStatus = 'FAILED';
      }

      const formattedMsg = formatDigiflazzErrorMessage({
        httpStatus: res.httpStatus,
        rc,
        message: rawMessage,
      });

      if (!res.httpOk || mappedStatus !== 'SUCCESS') {
        logger.warn('Digiflazz transaction/inquiry response', {
          service: 'digiflazz',
          transactionId: params.refId,
          details: {
            httpStatus: res.httpStatus,
            mappedStatus,
            rawStatus: rawStatus || null,
            rc: rc || null,
            message: formattedMsg,
          },
        });
      }

      return {
        ok: mappedStatus !== 'UNKNOWN',
        mappedStatus,
        refId: d?.ref_id || params.refId,
        rc,
        rawStatus,
        sn: d?.sn ? String(d.sn).slice(0, 200) : undefined,
        message: (mappedStatus === 'FAILED' || mappedStatus === 'UNKNOWN'
          ? formattedMsg
          : rawMessage || 'Sukses'
        ).slice(0, 250),
        price: typeof d?.price === 'number' ? d.price : undefined,
        errorMessage: mappedStatus === 'UNKNOWN' ? formattedMsg.slice(0, 250) : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Digiflazz request error';
      logger.warn('Digiflazz transaction/inquiry error; marking UNKNOWN', {
        service: 'digiflazz',
        transactionId: params.refId,
        details: { error: msg },
      });
      return {
        ok: false,
        mappedStatus: 'UNKNOWN',
        refId: params.refId,
        errorMessage: msg,
      };
    }
  }

  async createTransaction(params: {
    sku: string;
    destination: string;
    refId: string;
  }): Promise<DigiflazzTxResponse> {
    return this.sendTxRequest(params);
  }

  async inquireTransaction(params: {
    sku: string;
    destination: string;
    refId: string;
  }): Promise<DigiflazzTxResponse> {
    // Per official Digiflazz v1 docs, calling /transaction with the same ref_id performs an idempotent status inquiry
    return this.sendTxRequest(params);
  }

  async checkBalance(): Promise<{ ok: boolean; balance?: number; errorMessage?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, errorMessage: 'Kredensial Digiflazz belum dikonfigurasi' };
    }
    try {
      const res = await this.postJsonRaw<{
        message?: string;
        data?: { deposit?: number; message?: string; rc?: string };
      }>('/cek-saldo', {
        cmd: 'deposit',
        username: config.digiflazz.username,
        sign: this.sign('depo'),
      });
      if (res.httpOk && typeof res.body?.data?.deposit === 'number') {
        return { ok: true, balance: res.body.data.deposit };
      }
      return {
        ok: false,
        errorMessage: formatDigiflazzErrorMessage({
          httpStatus: res.httpStatus,
          rc: res.body?.data?.rc,
          message: res.body?.data?.message || res.body?.message || res.rawText || 'Saldo tidak tersedia',
        }),
      };
    } catch (err) {
      return { ok: false, errorMessage: err instanceof Error ? err.message : 'Cek saldo gagal' };
    }
  }

  async fetchPostpaidPriceList(): Promise<{
    ok: boolean;
    items: DigiflazzPostpaidPriceItem[];
    errorMessage?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        items: [],
        errorMessage: 'Kredensial Digiflazz (DIGIFLAZZ_USERNAME / DIGIFLAZZ_API_KEY) belum dikonfigurasi',
      };
    }

    try {
      const res = await this.postJsonRaw<{
        message?: string;
        data?: DigiflazzPostpaidPriceItem[] | { message?: string; rc?: string };
      }>('/price-list', {
        cmd: 'pasca',
        username: config.digiflazz.username,
        sign: this.sign('pricelist'),
      });

      if (!res.httpOk || !res.body || !Array.isArray(res.body.data)) {
        const dataObj =
          res.body?.data && !Array.isArray(res.body.data) ? res.body.data : undefined;
        const msg = formatDigiflazzErrorMessage({
          httpStatus: res.httpStatus,
          rc: dataObj?.rc,
          message: dataObj?.message || res.body?.message || res.rawText || 'Format respons price-list pascabayar Digiflazz tidak valid',
        });
        return { ok: false, items: [], errorMessage: msg };
      }

      return { ok: true, items: res.body.data };
    } catch (err) {
      return {
        ok: false,
        items: [],
        errorMessage: err instanceof Error ? err.message : 'Gagal mengambil price list pascabayar Digiflazz',
      };
    }
  }

  async inquirePostpaidBill(params: {
    sku: string;
    customerNo: string;
    refId?: string;
    testing?: boolean;
  }): Promise<DigiflazzPostpaidInquiryResponse> {
    const refId =
      (params.refId || '').trim() ||
      `INQ-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    if (!this.isConfigured()) {
      return {
        ok: false,
        refId,
        httpStatus: 0,
        errorMessage: 'Kredensial Digiflazz belum dikonfigurasi',
      };
    }

    try {
      const payload: Record<string, unknown> = {
        commands: 'inq-pasca',
        username: config.digiflazz.username,
        buyer_sku_code: params.sku.trim(),
        customer_no: params.customerNo.trim(),
        ref_id: refId,
        sign: this.sign(refId),
      };
      if (params.testing) {
        payload.testing = true;
      }

      const res = await this.postJsonRaw<{
        message?: string;
        rc?: string;
        status?: string;
        data?: {
          ref_id?: string;
          customer_no?: string;
          customer_name?: string;
          buyer_sku_code?: string;
          admin?: number;
          message?: string;
          status?: string;
          rc?: string;
          sn?: string;
          price?: number;
          selling_price?: number;
          desc?: unknown;
        };
      }>('/transaction', payload);

      const d = res.body?.data && typeof res.body.data === 'object' ? res.body.data : undefined;
      const rc = d?.rc ?? res.body?.rc;
      const rawStatus = d?.status ?? res.body?.status;
      const rawMessage = d?.message ?? res.body?.message ?? (!res.body ? res.rawText : undefined);
      const mapped = mapDigiflazzStatus(rawStatus);
      const ok = res.httpOk && (mapped === 'SUCCESS' || rc === '00');
      const formattedErr = formatDigiflazzErrorMessage({
        httpStatus: res.httpStatus,
        rc,
        message: rawMessage,
      });

      return {
        ok,
        refId: d?.ref_id || refId,
        httpStatus: res.httpStatus,
        rc,
        rawStatus,
        message: rawMessage,
        customerName: d?.customer_name,
        customerNo: d?.customer_no || params.customerNo.trim(),
        buyerSkuCode: d?.buyer_sku_code || params.sku.trim(),
        price: typeof d?.price === 'number' ? d.price : undefined,
        admin: typeof d?.admin === 'number' ? d.admin : undefined,
        sellingPrice: typeof d?.selling_price === 'number' ? d.selling_price : undefined,
        sn: d?.sn ? String(d.sn) : undefined,
        desc: d?.desc,
        rawBody: res.body ?? res.rawText ?? null,
        errorMessage: ok ? undefined : formattedErr,
      };
    } catch (err) {
      return {
        ok: false,
        refId,
        httpStatus: 0,
        errorMessage: err instanceof Error ? err.message : 'Gagal menjalankan inq-pasca Digiflazz',
      };
    }
  }
}

export const defaultDigiflazzClient = new DigiflazzClient();
