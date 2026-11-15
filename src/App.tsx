import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ReceiptText,
  Package,
  Tags,
  Percent,
  TicketPercent,
  RotateCcw,
  Bot,
  ScrollText,
  Settings,
  LogOut,
  Menu,
  X,
  MessageSquareCode,
} from 'lucide-react';
import { getAuthStatus, logoutSession } from './api/client';
import type { AdminSession } from './types/admin';
import { LoginScreen } from './components/LoginScreen';
import { OverviewPage } from './components/OverviewPage';
import { TransactionsPage } from './components/TransactionsPage';
import { CatalogPage } from './components/CatalogPage';
import { CouponsPage } from './components/CouponsPage';
import { RefundsPage } from './components/RefundsPage';
import { BotsPage } from './components/BotsPage';
import { BotDemoPage } from './components/BotDemoPage';
import { LogsPage } from './components/LogsPage';
import { SettingsPage } from './components/SettingsPage';

type NavKey =
  | 'overview'
  | 'transactions'
  | 'products'
  | 'categories'
  | 'margins'
  | 'coupons'
  | 'refunds'
  | 'bots'
  | 'bot-demo'
  | 'logs'
  | 'settings';

const NAV_ITEMS: Array<{ key: NavKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'transactions', label: 'Transactions', icon: ReceiptText },
  { key: 'products', label: 'Products', icon: Package },
  { key: 'categories', label: 'Categories', icon: Tags },
  { key: 'margins', label: 'Margin Settings', icon: Percent },
  { key: 'coupons', label: 'Coupons', icon: TicketPercent },
  { key: 'refunds', label: 'Refund Ledger', icon: RotateCcw },
  { key: 'bots', label: 'Bot Management', icon: Bot },
  { key: 'bot-demo', label: 'Demo Bot', icon: MessageSquareCode },
  { key: 'logs', label: 'Logs', icon: ScrollText },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [booting, setBooting] = useState(true);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [activeNav, setActiveNav] = useState<NavKey>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const status = await getAuthStatus();
        setAuthConfigured(status.authConfigured);
        setAdmin(status.authenticated ? status.admin : null);
      } catch {
        setAdmin(null);
      } finally {
        setBooting(false);
      }
    }
    void init();
  }, []);

  async function handleLogout() {
    await logoutSession().catch(() => undefined);
    setAdmin(null);
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-[#0b111e] flex items-center justify-center text-sm text-slate-400">
        Memuat sesi konsol admin...
      </div>
    );
  }

  if (!admin) {
    return <LoginScreen authConfigured={authConfigured} onSuccess={(a) => setAdmin(a)} />;
  }

  const activeItem = NAV_ITEMS.find((n) => n.key === activeNav)!;

  return (
    <div className="min-h-screen bg-[#0b111e] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-60 bg-[#1b2434] border-r border-[#26334a] text-slate-100 shrink-0">
        <div className="h-14 px-5 flex items-center border-b border-[#26334a]">
          <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">
            PPOB Bot Ecosystem
          </span>
        </div>

        <nav aria-label="Navigasi utama" className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveNav(item.key)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-[#1668ff] text-white shadow-sm'
                    : 'text-slate-300 hover:bg-[#232e42] hover:text-white'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-white' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-[#26334a] text-xs text-slate-400">
          <p className="font-semibold text-slate-100 truncate">{admin.name}</p>
          <p className="font-mono mt-0.5 text-slate-400">{admin.role} · {admin.username}</p>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative w-64 bg-[#1b2434] border-r border-[#26334a] text-slate-100 flex flex-col z-10">
            <div className="h-14 px-4 flex items-center justify-between border-b border-[#26334a]">
              <span className="text-base font-bold text-white">PPOB Bot Ecosystem</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Tutup menu navigasi"
                className="p-2 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav aria-label="Navigasi seluler" className="flex-1 p-3 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      setActiveNav(item.key);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg cursor-pointer whitespace-nowrap ${
                      active ? 'bg-[#1668ff] text-white shadow-sm' : 'text-slate-300 hover:bg-[#232e42] hover:text-white'
                    }`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-white' : 'text-slate-400'}`} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-[#11192a] border-b border-[#1f2b42] px-4 lg:px-8 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Buka menu navigasi"
              className="lg:hidden p-2 text-slate-300 hover:text-white rounded-lg cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-400 truncate">
              <span>Admin Console</span>
              <span className="mx-2 text-slate-600">/</span>
              <span className="font-semibold text-slate-100">{activeItem.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span className="hidden sm:inline text-xs font-mono text-slate-400">
              {admin.username} ({admin.role})
            </span>
            <button
              onClick={() => void handleLogout()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#192233] border border-[#2a3852] rounded-lg hover:bg-[#232e42] cursor-pointer whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              Keluar
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">
          {activeNav === 'overview' && <OverviewPage />}
          {activeNav === 'transactions' && <TransactionsPage permissions={admin.permissions} />}
          {activeNav === 'products' && <CatalogPage initialTab="products" permissions={admin.permissions} />}
          {activeNav === 'categories' && <CatalogPage initialTab="categories" permissions={admin.permissions} />}
          {activeNav === 'margins' && <CatalogPage initialTab="margins" permissions={admin.permissions} />}
          {activeNav === 'coupons' && <CouponsPage permissions={admin.permissions} />}
          {activeNav === 'refunds' && <RefundsPage permissions={admin.permissions} />}
          {activeNav === 'bots' && <BotsPage permissions={admin.permissions} />}
          {activeNav === 'bot-demo' && <BotDemoPage admin={admin} />}
          {activeNav === 'logs' && <LogsPage />}
          {activeNav === 'settings' && <SettingsPage permissions={admin.permissions} />}
        </main>
      </div>
    </div>
  );
}
