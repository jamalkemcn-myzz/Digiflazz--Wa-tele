import type { AdminSession } from '../types/admin';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

// Held strictly in JS memory (never localStorage/sessionStorage) so cross-site HTTPS iframes work even when third-party cookies are restricted
let inMemorySessionToken: string | null = null;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const customHeaders = (init?.headers as Record<string, string> | undefined) || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  if (inMemorySessionToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${inMemorySessionToken}`;
  }

  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  });

  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || body.ok === false) {
    if (res.status === 401) {
      inMemorySessionToken = null;
    }
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export async function getAuthStatus(): Promise<{
  authConfigured: boolean;
  authenticated: boolean;
  admin: AdminSession | null;
}> {
  return requestJson('/api/auth/status');
}

export async function getSessionMe(): Promise<{ admin: AdminSession }> {
  return requestJson('/api/auth/me');
}

export async function loginBasicAuth(
  username: string,
  password: string
): Promise<{ admin: AdminSession; sessionToken?: string }> {
  // Encode UTF-8 credentials safely for HTTP Basic Auth header without storing password in storage
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary);

  const res = await requestJson<{ ok: true; admin: AdminSession; sessionToken?: string }>('/api/auth/login', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encoded}`,
    },
  });
  inMemorySessionToken = res.sessionToken || null;
  return res;
}

export async function logoutSession(): Promise<void> {
  inMemorySessionToken = null;
  await requestJson('/api/auth/logout', { method: 'POST' });
}

export const api = {
  getOverview: () => requestJson<{ ok: true; data: any }>('/api/admin/overview'),

  getTransactions: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return requestJson<{ ok: true; data: any }>(`/api/admin/transactions?${qs.toString()}`);
  },
  getTransactionDetail: (txId: string) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/transactions/${encodeURIComponent(txId)}`),
  reconcileTransaction: (txId: string) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/transactions/${encodeURIComponent(txId)}/reconcile`, {
      method: 'POST',
    }),
  retrySupplierTransaction: (txId: string) =>
    requestJson<{
      ok: true;
      data: {
        transaction: any;
        retryRefId: string;
        mappedStatus: 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNKNOWN';
        supplierMessage: string;
        refundReversedAmount: number;
      };
    }>(`/api/admin/transactions/${encodeURIComponent(txId)}/retry-supplier`, {
      method: 'POST',
    }),

  getProducts: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return requestJson<{ ok: true; data: any }>(`/api/admin/products?${qs.toString()}`);
  },
  saveProduct: (payload: Record<string, unknown>) =>
    requestJson<{ ok: true; data: any }>('/api/admin/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  toggleProductStatus: (id: number, status: 'ACTIVE' | 'INACTIVE') =>
    requestJson<{ ok: true; data: any }>(`/api/admin/products/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  deleteProduct: (id: number) =>
    requestJson<{ ok: true; data: { id: number; sku: string; name: string } }>(`/api/admin/products/${id}`, {
      method: 'DELETE',
    }),
  syncDigiflazz: () =>
    requestJson<{ ok: true; data: any }>('/api/admin/products/sync-digiflazz', {
      method: 'POST',
    }),
  getSyncLogs: () => requestJson<{ ok: true; data: any[] }>('/api/admin/products/sync-logs'),
  getProductAutoRefresh: () =>
    requestJson<{ ok: true; data: any }>('/api/admin/products/auto-refresh'),
  updateProductAutoRefresh: (payload: {
    mode: 'DISABLED' | 'INTERVAL' | 'DAILY_TIME' | 'CRON';
    intervalMinutes?: number;
    dailyTime?: string;
    cronExpression?: string;
  }) =>
    requestJson<{ ok: true; data: any }>('/api/admin/products/auto-refresh', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  getCategories: () => requestJson<{ ok: true; data: any[] }>('/api/admin/categories'),
  createCategory: (payload: Record<string, unknown>) =>
    requestJson<{ ok: true; data: any }>('/api/admin/categories', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCategory: (id: number, payload: Record<string, unknown>) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteCategory: (id: number) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/categories/${id}`, {
      method: 'DELETE',
    }),

  getMargins: () => requestJson<{ ok: true; data: any }>('/api/admin/margins'),
  setGlobalMargin: (marginType: 'FIXED' | 'PERCENT', marginValue: number, maxMargin: number | null = null) =>
    requestJson<{ ok: true; data: any }>('/api/admin/margins/global', {
      method: 'PUT',
      body: JSON.stringify({ marginType, marginValue, maxMargin }),
    }),
  setCategoryMargin: (
    id: number,
    marginType: 'FIXED' | 'PERCENT' | null,
    marginValue: number | null,
    maxMargin: number | null = null
  ) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/margins/category/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ marginType, marginValue, maxMargin }),
    }),
  setProductMargin: (
    id: number,
    marginType: 'FIXED' | 'PERCENT' | null,
    marginValue: number | null,
    maxMargin: number | null = null
  ) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/margins/product/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ marginType, marginValue, maxMargin }),
    }),

  getCoupons: () => requestJson<{ ok: true; data: any }>('/api/admin/coupons'),
  createCoupon: (payload: Record<string, unknown>) =>
    requestJson<{ ok: true; data: any }>('/api/admin/coupons', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCoupon: (id: number, payload: Record<string, unknown>) =>
    requestJson<{ ok: true; data: any }>(`/api/admin/coupons/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteCoupon: (id: number) =>
    requestJson<{ ok: true }>(`/api/admin/coupons/${id}`, { method: 'DELETE' }),

  getRefunds: (page = 1) => requestJson<{ ok: true; data: any }>(`/api/admin/refunds?page=${page}`),
  getCustomers: () => requestJson<{ ok: true; data: any[] }>('/api/admin/customers'),
  getUsers: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return requestJson<{ ok: true; data: any }>(`/api/admin/users?${qs.toString()}`);
  },
  adjustRefundLedger: (payload: Record<string, unknown>) =>
    requestJson<{ ok: true; data: any }>('/api/admin/refunds/adjust', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getBotsStatus: () => requestJson<{ ok: true; data: any }>('/api/admin/bots/status'),
  generateWaPairingCode: (phoneNumber: string) =>
    requestJson<{ ok: true; data: { pairingCode: string } }>('/api/admin/bots/whatsapp/pairing-code', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),
  reconnectWhatsapp: (resetSession = false) =>
    requestJson<{ ok: true; data: any }>('/api/admin/bots/whatsapp/reconnect', {
      method: 'POST',
      body: JSON.stringify({ resetSession }),
    }),
  reconnectTelegram: () =>
    requestJson<{ ok: true; data: any }>('/api/admin/bots/telegram/reconnect', {
      method: 'POST',
    }),
  simulateBotDemo: (payload: {
    platform: 'WHATSAPP' | 'TELEGRAM';
    senderRole: 'CUSTOMER' | 'ADMIN';
    inputType: 'TEXT' | 'CALLBACK';
    text?: string;
    callbackData?: string;
    senderId?: string;
  }) =>
    requestJson<{
      ok: true;
      data: {
        platform: 'WHATSAPP' | 'TELEGRAM';
        senderRole: 'CUSTOMER' | 'ADMIN';
        dryRun: true;
        replies: Array<{
          text: string;
          imageDataUrl?: string;
          buttons?: Array<Array<{ text: string; callbackData?: string; url?: string; replyText?: string }>>;
        }>;
        alert?: {
          text: string;
          showAlert: boolean;
        };
      };
    }>('/api/admin/bots/demo', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getLogs: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return requestJson<{ ok: true; data: any }>(`/api/admin/logs?${qs.toString()}`);
  },

  getSettings: () => requestJson<{ ok: true; data: any }>('/api/admin/settings'),
  runDigiflazzDiagnostic: () =>
    requestJson<{
      ok: true;
      data: {
        checkedAt: string;
        env: {
          configured: boolean;
          baseUrl: string;
          usernameMasked: string;
          usernameLength: number;
          apiKeyMode: 'DEVELOPMENT' | 'PRODUCTION' | 'EMPTY';
          apiKeyLength: number;
          envFileExists: boolean;
          overriddenByContainerEnv: boolean;
          warnings: string[];
        };
        outboundIp: string | null;
        balanceCheck: {
          ok: boolean;
          balance?: number;
          errorMessage?: string;
        };
      };
    }>('/api/admin/settings/digiflazz-diagnostic', { method: 'POST' }),
  setMaintenanceMode: (enabled: boolean, reason?: string) =>
    requestJson<{ ok: true; data: { maintenanceMode: boolean } }>('/api/admin/settings/maintenance', {
      method: 'PUT',
      body: JSON.stringify({ enabled, reason }),
    }),
  setConfirmationDescription: (description: string | null) =>
    requestJson<{ ok: true; data: { confirmationDescription: string | null } }>(
      '/api/admin/settings/confirmation-description',
      {
        method: 'PUT',
        body: JSON.stringify({ description }),
      }
    ),
  runBackup: () => requestJson<{ ok: true; data: any }>('/api/admin/backups/run', { method: 'POST' }),
  createAdmin: (payload: {
    name: string;
    role: 'OWNER' | 'ADMIN' | 'OPERATOR';
    platform?: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD';
    platformUserId?: string;
  }) =>
    requestJson<{ ok: true; data: any }>('/api/admin/admins', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAdminRole: (id: number, role: string, status: string, name?: string) =>
    requestJson<{ ok: true }>(`/api/admin/admins/${id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role, status, name }),
    }),
  addAdminIdentity: (id: number, platform: string, platformUserId: string) =>
    requestJson<{ ok: true }>(`/api/admin/admins/${id}/identities`, {
      method: 'POST',
      body: JSON.stringify({ platform, platformUserId }),
    }),
  removeAdminIdentity: (id: number, identityId: number) =>
    requestJson<{ ok: true }>(`/api/admin/admins/${id}/identities/${identityId}`, {
      method: 'DELETE',
    }),
  resetAdmins: (mode: 'SYNC_OWNER_FROM_ENV' | 'RESET_TO_PRIMARY_OWNER') =>
    requestJson<{ ok: true; data: any[] }>('/api/admin/admins/reset', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
};
