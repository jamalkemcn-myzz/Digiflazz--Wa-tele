import { getDb, closeDb } from '../database/connection';
import { runMigrations, verifyDatabaseIntegrity } from '../database/migrate';
import { logger } from '../logging/logger';

function main() {
  getDb();
  runMigrations();
  verifyDatabaseIntegrity();
  logger.info('Database migration CLI completed successfully', { service: 'migrate-cli' });
  closeDb();
}

main();
