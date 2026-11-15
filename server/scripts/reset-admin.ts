import { config } from '../config/env';
import { closeDb } from '../database/connection';
import { runMigrations } from '../database/migrate';
import { resetAdminsAndSyncOwner } from '../services/admin.service';

const fullReset = process.argv.includes('--full');
const mode = fullReset ? 'RESET_TO_PRIMARY_OWNER' : 'SYNC_OWNER_FROM_ENV';

runMigrations();
const admins = resetAdminsAndSyncOwner(
  mode,
  { id: 'cli:reset-admin', role: 'OWNER' },
  {
    dashboardUser: config.auth.dashboardUser,
    ownerWhatsappJid: config.auth.ownerWhatsappJid,
    ownerTelegramId: config.auth.ownerTelegramId,
  }
);

console.log(
  JSON.stringify(
    {
      ok: true,
      mode,
      totalAdmins: admins.length,
      admins: admins.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        identities: a.identities.map((i) => `${i.platform}:${i.platform_user_id}`),
      })),
    },
    null,
    2
  )
);

closeDb();
