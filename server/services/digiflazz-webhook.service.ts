import { config } from '../config/env';
import { logger } from '../logging/logger';
import {
  parseDigiflazzWebhookPayload,
  verifyDigiflazzWebhookSignature,
} from '../integrations/digiflazz.client';
import { applyDigiflazzWebhookUpdate } from './transaction.service';

export async function processDigiflazzWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  parsedBody: unknown,
  webhookSecret: string = config.digiflazz.webhookSecret
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const secret = webhookSecret.trim();
  if (!secret) {
    logger.warn('Rejected Digiflazz webhook: DIGIFLAZZ_WEBHOOK_SECRET not configured', {
      service: 'digiflazz-webhook',
    });
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: 'DIGIFLAZZ_WEBHOOK_SECRET belum dikonfigurasi pada server',
      },
    };
  }

  const sigHeader = headers['x-hub-signature'] ?? headers['X-Hub-Signature'];
  if (!verifyDigiflazzWebhookSignature(rawBody, sigHeader, secret)) {
    logger.warn('Rejected Digiflazz webhook: invalid X-Hub-Signature', {
      service: 'digiflazz-webhook',
    });
    return {
      statusCode: 401,
      body: {
        ok: false,
        error: 'Invalid Digiflazz webhook signature',
      },
    };
  }

  const parsed = parseDigiflazzWebhookPayload(headers, parsedBody);

  if (parsed.isPing) {
    logger.info('Digiflazz webhook ping verified', {
      service: 'digiflazz-webhook',
      details: { event: parsed.event },
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        event: parsed.event,
        message: 'Digiflazz webhook ping verified',
      },
    };
  }

  if (!parsed.refId) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: 'Payload webhook Digiflazz tidak menyertakan ref_id',
      },
    };
  }

  const result = await applyDigiflazzWebhookUpdate(parsed);
  if (!result.ok) {
    logger.warn('Digiflazz webhook processing rejected', {
      service: 'digiflazz-webhook',
      transactionId: parsed.refId,
      details: { statusCode: result.statusCode, error: result.error },
    });
    return {
      statusCode: result.statusCode,
      body: {
        ok: false,
        error: result.error || 'Gagal memproses webhook Digiflazz',
      },
    };
  }

  logger.info('Processed Digiflazz webhook update', {
    service: 'digiflazz-webhook',
    transactionId: result.transactionId,
    details: {
      event: parsed.event,
      mappedStatus: parsed.mappedStatus,
      transactionStatus: result.transactionStatus,
      alreadyProcessed: Boolean(result.alreadyProcessed),
      ignored: Boolean(result.ignored),
    },
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      transactionId: result.transactionId,
      transactionStatus: result.transactionStatus,
      alreadyProcessed: Boolean(result.alreadyProcessed),
      ignored: Boolean(result.ignored),
      ...(result.reason ? { reason: result.reason } : {}),
    },
  };
}
