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

export interface DigiflazzPort {
  isConfigured(): boolean;
  fetchPriceList(): Promise<{ ok: boolean; items: DigiflazzPriceItem[]; errorMessage?: string }>;
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
  checkBalance(): Promise<{ ok: boolean; balance?: number; errorMessage?: string }>;
}

export function mapDigiflazzStatus(rawStatus?: string): DigiflazzMappedStatus {
  const normalized = (rawStatus || '').trim().toLowerCase();
  if (normalized === 'sukses' || normalized === 'success') return 'SUCCESS';
  if (normalized === 'pending') return 'PENDING';
  if (normalized === 'gagal' || normalized === 'failed') return 'FAILED';
  return 'UNKNOWN';
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

  private async postJson<T>(endpointPath: string, payload: Record<string, unknown>): Promise<T> {
    const url = `${config.digiflazz.baseUrl}${endpointPath}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.digiflazz.timeoutMs),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(`Digiflazz HTTP ${response.status}`);
    }
    return data as T;
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
      const res = await this.postJson<{ data?: DigiflazzPriceItem[] | { message?: string } }>('/price-list', {
        cmd: 'prepaid',
        username: config.digiflazz.username,
        sign: this.sign('pricelist'),
      });

      if (!Array.isArray(res.data)) {
        const msg = (res.data as { message?: string } | undefined)?.message || 'Format respons price-list Digiflazz tidak valid';
        return { ok: false, items: [], errorMessage: msg };
      }

      return { ok: true, items: res.data };
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
      const res = await this.postJson<{
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

      const d = res.data;
      if (!d || typeof d !== 'object') {
        return {
          ok: false,
          mappedStatus: 'UNKNOWN',
          refId: params.refId,
          errorMessage: 'Respons transaksi Digiflazz tidak valid',
        };
      }

      const mappedStatus = mapDigiflazzStatus(d.status);
      return {
        ok: true,
        mappedStatus,
        refId: d.ref_id || params.refId,
        rc: d.rc,
        rawStatus: d.status,
        sn: d.sn ? String(d.sn).slice(0, 200) : undefined,
        message: d.message ? String(d.message).slice(0, 250) : undefined,
        price: typeof d.price === 'number' ? d.price : undefined,
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
      const res = await this.postJson<{ data?: { deposit?: number; message?: string } }>('/cek-saldo', {
        cmd: 'deposit',
        username: config.digiflazz.username,
        sign: this.sign('depo'),
      });
      if (typeof res.data?.deposit === 'number') {
        return { ok: true, balance: res.data.deposit };
      }
      return { ok: false, errorMessage: res.data?.message || 'Saldo tidak tersedia' };
    } catch (err) {
      return { ok: false, errorMessage: err instanceof Error ? err.message : 'Cek saldo gagal' };
    }
  }
}

export const defaultDigiflazzClient = new DigiflazzClient();
