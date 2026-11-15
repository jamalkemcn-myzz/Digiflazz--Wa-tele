import type { Request, Response } from 'express';
import { processGatewayCallback } from '../../services/payment.service';

export async function handleMyZZStoreCallback(req: Request, res: Response): Promise<void> {
  const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
  const result = await processGatewayCallback(req.headers, rawBody, req.body);
  res.status(result.statusCode).json(result.body);
}
