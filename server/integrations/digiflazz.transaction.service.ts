import { defaultDigiflazzClient, type DigiflazzPort, type DigiflazzTxResponse } from './digiflazz.client';

export async function dispatchSupplierTransaction(
  params: { sku: string; destination: string; refId: string },
  client: DigiflazzPort = defaultDigiflazzClient
): Promise<DigiflazzTxResponse> {
  return client.createTransaction(params);
}
