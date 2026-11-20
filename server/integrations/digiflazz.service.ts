import {
  defaultDigiflazzClient,
  type DigiflazzPort,
  type DigiflazzPostpaidInquiryResponse,
  type DigiflazzPostpaidPriceItem,
} from './digiflazz.client';
import { runDigiflazzPriceSync, isPriceSyncRunning } from './digiflazz.price-sync';
import { inquireSupplierTransaction } from './digiflazz.inquiry.service';
import { dispatchSupplierTransaction } from './digiflazz.transaction.service';

export class DigiflazzService {
  constructor(private readonly client: DigiflazzPort = defaultDigiflazzClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  isPriceSyncRunning(): boolean {
    return isPriceSyncRunning();
  }

  syncPrices(triggerSource: 'CRON' | 'MANUAL' = 'CRON') {
    return runDigiflazzPriceSync(this.client, triggerSource);
  }

  purchase(params: { sku: string; destination: string; refId: string }) {
    return dispatchSupplierTransaction(params, this.client);
  }

  inquire(params: { sku: string; destination: string; refId: string }) {
    return inquireSupplierTransaction(params, this.client);
  }

  checkBalance() {
    return this.client.checkBalance();
  }

  fetchPostpaidPriceList(): Promise<{
    ok: boolean;
    items: DigiflazzPostpaidPriceItem[];
    errorMessage?: string;
  }> {
    if (!this.client.fetchPostpaidPriceList) {
      return Promise.resolve({ ok: false, items: [], errorMessage: 'Postpaid price list belum didukung client' });
    }
    return this.client.fetchPostpaidPriceList();
  }

  inquirePostpaid(params: {
    sku: string;
    customerNo: string;
    refId?: string;
    testing?: boolean;
  }): Promise<DigiflazzPostpaidInquiryResponse> {
    if (!this.client.inquirePostpaidBill) {
      return Promise.resolve({
        ok: false,
        refId: params.refId || '',
        httpStatus: 0,
        errorMessage: 'Inquiry pascabayar belum didukung client',
      });
    }
    return this.client.inquirePostpaidBill(params);
  }
}

export const digiflazzService = new DigiflazzService();
