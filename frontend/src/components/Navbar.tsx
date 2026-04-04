import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Menu, X, ChevronDown,
  ArrowUpCircle, ArrowDownCircle,
  Landmark, Droplets, Zap, RefreshCw, Vote, ArrowLeftRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import WalletButton from './WalletButton';



/* ── Types ─────────────────────────────────────────────────────────────────── */
interface MenuItem {
  path: string;
  label: string;
  desc: string;
  Icon: LucideIcon;
}

interface MenuGroup {
  id: string;
  label: string;
  items: MenuItem[];
}

/* ── Nav data ──────────────────────────────────────────────────────────────── */
const MENU_GROUPS: MenuGroup[] = [
  {
    id: 'protocol',
    label: 'Protocol',
    items: [
      { path: '/stake',    label: 'Stake XLM', Icon: ArrowUpCircle,  desc: 'Deposit XLM · receive yield-bearing sXLM' },
      { path: '/withdraw', label: 'Withdraw',   Icon: ArrowDownCircle, desc: 'Burn sXLM · redeem XLM at exchange rate' },
    ],
  },
  {
    id: 'defi',
    label: 'DeFi',
    items: [
      { path: '/lending',   label: 'Lending',   Icon: Landmark,    desc: 'Collateralize sXLM · borrow XLM at 70% LTV' },
      { path: '/liquidity', label: 'Liquidity', Icon: Droplets,    desc: 'Provide sXLM/XLM liquidity · earn swap fees' },
      { path: '/leverage',  label: 'Leverage',  Icon: Zap,         desc: 'Amplify yield up to 3.33× with loop staking' },
      { path: '/restaking', label: 'Restaking', Icon: RefreshCw,   desc: 'Auto stake-collateral-borrow loop simulation' },
       { path: '/bridge',    label: 'Bridge',    Icon: ArrowLeftRight,  desc: 'Move sXLM to EVM chains · use as DeFi collateral' },
    ],
  },
];

const SINGLE_LINKS = [
  { path: '/governance', label: 'Governance', Icon: Vote },
];

/* ── Mega dropdown ─────────────────────────────────────────────────────────── */
function MegaDropdown({
  group,
  isOpen,
  onClose,
}: {
  group: MenuGroup;
  isOpen: boolean;
  onClose: () => void;
}) {
  const location = useLocation();
  if (!isOpen) return null;

  const isTwoCol = group.items.length > 2;

  return (
    <div
      className="absolute top-full rounded-2xl overflow-hidden"
      style={{
        marginTop: 8,
        background: 'rgba(6,6,6,0.98)',
        border: '1px solid #252525',
        boxShadow: '0 24px 64px rgba(0,0,0,0.85), 0 0 0 1px rgba(245,207,0,0.05)',
        backdropFilter: 'blur(24px)',
        width: isTwoCol ? 440 : 300,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100,
      }}
    >
      {/* Dropdown header strip */}
      <div
        className="px-5 py-3 flex items-center justify-between"
        style={{ borderBottom: '1px solid #1a1a1a' }}
      >
        <span
          className="text-[10px] uppercase tracking-[0.15em] font-semibold"
          style={{ color: '#F5CF00' }}
        >
          {group.label}
        </span>
        <span className="text-[10px]" style={{ color: '#333' }}>
          {group.items.length} modules
        </span>
      </div>

      {/* Items grid */}
      <div className={`p-3 ${isTwoCol ? 'grid grid-cols-2 gap-2' : 'space-y-1.5'}`}>
        {group.items.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={onClose}
              className="flex items-start gap-3.5 p-3 rounded-xl transition-all duration-150"
              style={{
                background: isActive ? 'rgba(245,207,0,0.07)' : 'transparent',
                textDecoration: 'none',
                border: isActive ? '1px solid rgba(245,207,0,0.14)' : '1px solid transparent',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                  e.currentTarget.style.borderColor = '#252525';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'transparent';
                }
              }}
            >
              {/* Icon box */}
              <div
                className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                style={{
                  background: isActive
                    ? 'rgba(245,207,0,0.14)'
                    : 'rgba(255,255,255,0.05)',
                  border: isActive
                    ? '1px solid rgba(245,207,0,0.2)'
                    : '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <item.Icon
                  className="w-4 h-4"
                  style={{ color: isActive ? '#F5CF00' : '#888' }}
                  strokeWidth={1.5}
                />
              </div>

              {/* Text */}
              <div className="pt-0.5">
                <p
                  className="text-sm font-medium leading-none mb-1.5"
                  style={{ color: isActive ? '#F5CF00' : '#ddd' }}
                >
                  {item.label}
                </p>
                <p className="text-[11px] leading-snug" style={{ color: '#4a4a4a' }}>
                  {item.desc}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* ── Main Navbar ───────────────────────────────────────────────────────────── */
export default function Navbar() {
  const location = useLocation();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    setIsMobileOpen(false);
    setOpenGroup(null);
  }, [location.pathname]);

  const isGroupActive = (group: MenuGroup) =>
    group.items.some((item) => location.pathname === item.path);

  return (
    <nav
      ref={navRef}
      className="fixed top-0 left-0 right-0 z-50"
      style={{
        background: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid #1c1c1c',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 lg:px-8">
        <div className="flex items-center justify-between h-[60px]">

          {/* ── Logo ────────────────────────────────────────────────────── */}
          <Link
            to="/"
            className="flex items-center gap-2.5 flex-shrink-0 group"
            style={{ textDecoration: 'none' }}
          >
            <img
              src="/logo.jpeg"
              alt="sXLM logo"
              style={{
                height: 34,
                width: 'auto',
                display: 'block',
                filter: 'invert(1) hue-rotate(180deg) saturate(1.4) brightness(1.05)',
              }}
            />
            <span
              className="text-base font-bold tracking-wider"
              style={{ color: '#F5CF00', letterSpacing: '0.08em' }}
            >
              sXLM
            </span>
          </Link>

          {/* ── Desktop nav links ────────────────────────────────────────── */}
          <div className="hidden md:flex items-center gap-0.5">
            {MENU_GROUPS.map((group) => {
              const active = isGroupActive(group);
              const open = openGroup === group.id;
              return (
                <div key={group.id} className="relative">
                  <button
                    onClick={() => setOpenGroup(open ? null : group.id)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150"
                    style={{
                      color: active || open ? '#F5CF00' : '#777',
                      background: open ? 'rgba(245,207,0,0.07)' : 'transparent',
                      letterSpacing: '0.01em',
                    }}
                    onMouseEnter={(e) => {
                      if (!active && !open) e.currentTarget.style.color = '#e0e0e0';
                    }}
                    onMouseLeave={(e) => {
                      if (!active && !open) e.currentTarget.style.color = '#777';
                    }}
                  >
                    {group.label}
                    <ChevronDown
                      className="w-3.5 h-3.5 transition-transform duration-200"
                      style={{
                        transform: open ? 'rotate(180deg)' : 'none',
                        color: active || open ? '#F5CF00' : '#555',
                      }}
                    />
                  </button>
                  <MegaDropdown
                    group={group}
                    isOpen={open}
                    onClose={() => setOpenGroup(null)}
                  />
                </div>
              );
            })}

            {/* Single links */}
            {SINGLE_LINKS.map((link) => {
              const active = location.pathname === link.path;
              return (
                <Link
                  key={link.path}
                  to={link.path}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150"
                  style={{
                    color: active ? '#F5CF00' : '#777',
                    background: active ? 'rgba(245,207,0,0.07)' : 'transparent',
                    textDecoration: 'none',
                    letterSpacing: '0.01em',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.color = '#e0e0e0';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.color = '#777';
                  }}
                >
                  <link.Icon
                    className="w-3.5 h-3.5"
                    style={{ color: active ? '#F5CF00' : '#555' }}
                    strokeWidth={1.5}
                  />
                  {link.label}
                </Link>
              );
            })}
          </div>

          {/* ── Right: wallet + mobile burger ───────────────────────────── */}
          <div className="flex items-center gap-3">
            <div className="hidden md:block">
              <WalletButton />
            </div>
            <button
              onClick={() => setIsMobileOpen(!isMobileOpen)}
              className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg transition-all duration-150"
              style={{
                color: '#777',
                border: '1px solid #1e1e1e',
                background: isMobileOpen ? 'rgba(245,207,0,0.06)' : 'transparent',
              }}
            >
              {isMobileOpen
                ? <X className="w-4.5 h-4.5" />
                : <Menu className="w-4.5 h-4.5" />
              }
            </button>
          </div>
        </div>
      </div>

      {/* ── Mobile menu ──────────────────────────────────────────────────── */}
      {isMobileOpen && (
        <div
          className="md:hidden"
          style={{ borderTop: '1px solid #1c1c1c', background: 'rgba(2,2,2,0.98)' }}
        >
          <div className="px-5 py-4 space-y-1 max-h-[80vh] overflow-y-auto">

            {MENU_GROUPS.map((group) => (
              <div key={group.id}>
                <button
                  onClick={() => setMobileExpanded(mobileExpanded === group.id ? null : group.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{
                    color: isGroupActive(group) ? '#F5CF00' : '#888',
                    background: mobileExpanded === group.id ? 'rgba(245,207,0,0.05)' : 'transparent',
                  }}
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    className="w-4 h-4 transition-transform duration-200"
                    style={{ transform: mobileExpanded === group.id ? 'rotate(180deg)' : 'none' }}
                  />
                </button>

                {mobileExpanded === group.id && (
                  <div className="mt-1 ml-3 space-y-1 pb-1">
                    {group.items.map((item) => {
                      const active = location.pathname === item.path;
                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          onClick={() => setIsMobileOpen(false)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all"
                          style={{
                            color: active ? '#F5CF00' : '#aaa',
                            background: active ? 'rgba(245,207,0,0.06)' : 'rgba(255,255,255,0.02)',
                            textDecoration: 'none',
                          }}
                        >
                          <item.Icon
                            className="w-4 h-4 flex-shrink-0"
                            style={{ color: active ? '#F5CF00' : '#555' }}
                            strokeWidth={1.5}
                          />
                          <div>
                            <p style={{ lineHeight: 1, marginBottom: 2 }}>{item.label}</p>
                            <p className="text-[10px]" style={{ color: '#444' }}>{item.desc}</p>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            {SINGLE_LINKS.map((link) => {
              const active = location.pathname === link.path;
              return (
                <Link
                  key={link.path}
                  to={link.path}
                  onClick={() => setIsMobileOpen(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
                  style={{
                    color: active ? '#F5CF00' : '#888',
                    background: active ? 'rgba(245,207,0,0.06)' : 'transparent',
                    textDecoration: 'none',
                  }}
                >
                  <link.Icon
                    className="w-4 h-4"
                    style={{ color: active ? '#F5CF00' : '#555' }}
                    strokeWidth={1.5}
                  />
                  {link.label}
                </Link>
              );
            })}

            <div className="pt-4 mt-2" style={{ borderTop: '1px solid #1c1c1c' }}>
              <WalletButton />
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
