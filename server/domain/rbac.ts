export type AdminRole = 'OWNER' | 'ADMIN' | 'OPERATOR';

export const ALL_PERMISSIONS = [
  'overview:read',
  'transactions:read',
  'transactions:reconcile',
  'products:read',
  'products:write',
  'categories:write',
  'margins:write',
  'coupons:read',
  'coupons:write',
  'refunds:read',
  'refunds:adjust',
  'bots:read',
  'bots:manage',
  'bots:pairing',
  'logs:read',
  'settings:read',
  'settings:write',
  'maintenance:toggle',
  'backups:manage',
  'admins:manage',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const ROLE_DEFAULT_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  OWNER: new Set(ALL_PERMISSIONS),
  ADMIN: new Set([
    'overview:read',
    'transactions:read',
    'transactions:reconcile',
    'products:read',
    'products:write',
    'categories:write',
    'margins:write',
    'coupons:read',
    'coupons:write',
    'refunds:read',
    'bots:read',
    'bots:manage',
    'bots:pairing',
    'logs:read',
    'settings:read',
    'maintenance:toggle',
    'backups:manage',
  ]),
  OPERATOR: new Set([
    'overview:read',
    'transactions:read',
    'transactions:reconcile',
    'products:read',
    'coupons:read',
    'refunds:read',
    'bots:read',
    'logs:read',
    'settings:read',
  ]),
};

export function hasPermission(
  role: AdminRole,
  customPermissions: string[] | undefined,
  required: Permission
): boolean {
  if (role === 'OWNER') return true;
  if (customPermissions && customPermissions.includes('*')) return true;
  if (customPermissions && customPermissions.includes(required)) return true;
  return ROLE_DEFAULT_PERMISSIONS[role]?.has(required) ?? false;
}

export function getEffectivePermissions(role: AdminRole, customPermissions?: string[]): Permission[] {
  if (role === 'OWNER' || (customPermissions && customPermissions.includes('*'))) {
    return [...ALL_PERMISSIONS];
  }
  const combined = new Set<Permission>(ROLE_DEFAULT_PERMISSIONS[role] ?? []);
  if (customPermissions) {
    for (const p of customPermissions) {
      if ((ALL_PERMISSIONS as readonly string[]).includes(p)) {
        combined.add(p as Permission);
      }
    }
  }
  return Array.from(combined);
}
