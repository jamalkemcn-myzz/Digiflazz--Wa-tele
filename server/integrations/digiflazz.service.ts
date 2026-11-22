import { defaultDigiflazzClient, type DigiflazzPort } from './digiflazz.client';
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
}

export const digiflazzService = new DigiflazzService();
