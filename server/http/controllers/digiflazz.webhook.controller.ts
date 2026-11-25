import type { Request, Response } from 'express';
import { processDigiflazzWebhook } from '../../services/digiflazz-webhook.service';

export async function handleDigiflazzWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
  const result = await processDigiflazzWebhook(req.headers, rawBody, req.body);
  res.status(result.statusCode).json(result.body);
}
