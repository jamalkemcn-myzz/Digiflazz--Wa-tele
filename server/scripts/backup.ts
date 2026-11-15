import { getDb, closeDb } from '../database/connection';
import { runMigrations } from '../database/migrate';
import { runDatabaseBackup } from '../services/backup.service';

async function main() {
  getDb();
  runMigrations();
  const res = await runDatabaseBackup('CLI');
  if (!res.ok) {
    console.error('Backup failed:', res.errorMessage);
    closeDb();
    process.exit(1);
  }
  console.log(`Backup created: ${res.filePath} (${res.sizeBytes} bytes)`);
  closeDb();
}

void main();
