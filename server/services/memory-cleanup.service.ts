import { config } from '../config/env';
import { logger } from '../logging/logger';
import { runSqliteMemoryMaintenance } from '../database/connection';
import { getBotSessionMemoryStats, pruneBotSessionsMemory } from '../bots/bot-session';
import { pruneWhatsappCooldowns } from '../bots/whatsapp.command-handler';
import { pruneProcessedWhatsappMessages } from '../bots/whatsapp.message-handler';
import { pruneTelegramRateLimits } from '../bots/telegram.command-handler';

export interface MemoryUsageSnapshotMb {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
}

export interface MemoryCleanupResult {
  trigger: 'AUTO' | 'MANUAL';
  ranAt: string;
  evicted: {
    botSessions: number;
    pendingVouchers: number;
    telegramMessageRefs: number;
    whatsappCooldowns: number;
    whatsappDedupIds: number;
    telegramRateLimits: number;
    total: number;
  };
  sqlite: {
    ran: boolean;
    walCheckpointed: boolean;
    memoryShrunk: boolean;
  };
  gcTriggered: boolean;
  before: MemoryUsageSnapshotMb;
  after: MemoryUsageSnapshotMb;
  activeCaches: ReturnType<typeof getBotSessionMemoryStats>;
}

export interface MemoryCleanupStatus {
  lastRunAt: string | null;
  totalRuns: number;
  totalEvictedEntries: number;
  lastEvictedEntries: number;
  lastRssMb: number | null;
  lastHeapUsedMb: number | null;
}

const status: MemoryCleanupStatus = {
  lastRunAt: null,
  totalRuns: 0,
  totalEvictedEntries: 0,
  lastEvictedEntries: 0,
  lastRssMb: null,
  lastHeapUsedMb: null,
};

function toMb(bytes: number): number {
  return Math.round((bytes / 1048576) * 10) / 10;
}

export function getMemorySnapshotMb(): MemoryUsageSnapshotMb {
  const m = process.memoryUsage();
  return {
    rssMb: toMb(m.rss),
    heapUsedMb: toMb(m.heapUsed),
    heapTotalMb: toMb(m.heapTotal),
    externalMb: toMb(m.external),
  };
}

export function runAutomaticMemoryCleanup(
  trigger: 'AUTO' | 'MANUAL' = 'AUTO',
  now = Date.now()
): MemoryCleanupResult {
  const ranAt = new Date(now).toISOString();
  const before = getMemorySnapshotMb();

  const botPrune = pruneBotSessionsMemory(now);
  const whatsappCooldowns = pruneWhatsappCooldowns(now);
  const whatsappDedupIds = pruneProcessedWhatsappMessages(now);
  const telegramRateLimits = pruneTelegramRateLimits(now);
  const sqlite = runSqliteMemoryMaintenance();

  let gcTriggered = false;
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') {
    try {
      maybeGc();
      gcTriggered = true;
    } catch {
      // Ignore GC errors
    }
  }

  const after = getMemorySnapshotMb();
  const totalEvicted =
    botPrune.sessionsEvicted +
    botPrune.vouchersEvicted +
    botPrune.tgMessageRefsEvicted +
    whatsappCooldowns +
    whatsappDedupIds +
    telegramRateLimits;

  status.lastRunAt = ranAt;
  status.totalRuns += 1;
  status.totalEvictedEntries += totalEvicted;
  status.lastEvictedEntries = totalEvicted;
  status.lastRssMb = after.rssMb;
  status.lastHeapUsedMb = after.heapUsedMb;

  const highRssThresholdMb = config.nodeEnv === 'production' ? 350 : 650;
  if (trigger === 'MANUAL' || totalEvicted > 0 || after.rssMb >= highRssThresholdMb) {
    logger.info('Automatic RAM & cache cleanup completed', {
      service: 'memory',
      details: {
        trigger,
        evictedEntries: totalEvicted,
        rssBeforeMb: before.rssMb,
        rssAfterMb: after.rssMb,
        heapUsedAfterMb: after.heapUsedMb,
        sqliteMemoryShrunk: sqlite.memoryShrunk,
        gcTriggered,
      },
    });
  }

  return {
    trigger,
    ranAt,
    evicted: {
      botSessions: botPrune.sessionsEvicted,
      pendingVouchers: botPrune.vouchersEvicted,
      telegramMessageRefs: botPrune.tgMessageRefsEvicted,
      whatsappCooldowns,
      whatsappDedupIds,
      telegramRateLimits,
      total: totalEvicted,
    },
    sqlite,
    gcTriggered,
    before,
    after,
    activeCaches: getBotSessionMemoryStats(),
  };
}

export function getMemoryCleanupStatus(): MemoryCleanupStatus {
  return { ...status };
}
