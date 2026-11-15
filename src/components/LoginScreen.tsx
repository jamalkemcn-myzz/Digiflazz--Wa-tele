import React, { useState } from 'react';
import { Lock, AlertTriangle } from 'lucide-react';
import { loginBasicAuth } from '../api/client';
import type { AdminSession } from '../types/admin';

interface LoginScreenProps {
  authConfigured: boolean;
  onSuccess: (admin: AdminSession) => void;
}

export function LoginScreen({ authConfigured, onSuccess }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Username dan password wajib diisi.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await loginBasicAuth(username.trim(), password);
      setPassword('');
      onSuccess(res.admin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Autentikasi gagal.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0b111e] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-[#131c2e] border border-[#1f2b42] rounded-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-[#1668ff] text-white flex items-center justify-center shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100 tracking-tight">PPOB Bot Ecosystem</h1>
            <p className="text-sm text-slate-400">Admin Console — HTTP Basic Authentication</p>
          </div>
        </div>

        {!authConfigured && (
          <div className="mb-6 p-4 rounded-lg bg-amber-950/50 border border-amber-800/60 text-amber-200 text-sm flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
            <div>
              <p className="font-semibold">Konfigurasi Autentikasi Belum Diisi</p>
              <p className="mt-1 text-amber-300/90">
                Set <code className="font-mono text-xs">DASHBOARD_AUTH_USER</code> dan{' '}
                <code className="font-mono text-xs">DASHBOARD_AUTH_PASSWORD</code> di file{' '}
                <code className="font-mono text-xs">.env</code> pada server untuk mengaktifkan akses dashboard.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="mb-5 p-3.5 rounded-lg bg-red-950/50 border border-red-800/60 text-red-200 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="auth-username" className="block text-sm font-medium text-slate-300 mb-1.5">
              Username Admin
            </label>
            <input
              id="auth-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={!authConfigured || submitting}
              placeholder="Masukkan username dari .env"
              className="w-full px-3.5 py-2.5 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1668ff] focus:border-[#1668ff] disabled:bg-[#192233]"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-sm font-medium text-slate-300 mb-1.5">
              Password Admin
            </label>
            <input
              id="auth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!authConfigured || submitting}
              placeholder="Masukkan password dari .env"
              className="w-full px-3.5 py-2.5 text-sm bg-[#0d1422] border border-[#28354e] text-slate-100 placeholder:text-slate-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1668ff] focus:border-[#1668ff] disabled:bg-[#192233]"
            />
          </div>

          <button
            type="submit"
            disabled={!authConfigured || submitting}
            className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#1668ff] rounded-lg hover:bg-[#2574ff] disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            {submitting ? 'Memverifikasi...' : 'Masuk ke Dashboard'}
          </button>
        </form>

        <p className="mt-6 text-xs text-slate-400 leading-relaxed">
          Kredensial diverifikasi di backend menggunakan constant-time comparison dan tidak pernah disimpan di localStorage atau sessionStorage.
        </p>
      </div>
    </div>
  );
}
