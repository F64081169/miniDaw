// Dropdown menus and right-click context menus (in-page; native dialogs are unavailable in artifacts).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  danger?: boolean;
}

interface MenuState {
  open: { x: number; y: number; items: MenuItem[]; key: number } | null;
  show(x: number, y: number, items: MenuItem[]): void;
  hide(): void;
}

let key = 0;
export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items, key: ++key } }),
  hide: () => set({ open: null }),
}));

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]): void {
  e.preventDefault();
  useMenu.getState().show(e.clientX, e.clientY, items);
}

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onDone();
              it.onClick?.();
            }}
          >
            <span className="menu-check">{it.checked ? '✓' : ''}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** Rendered once at the app root. */
export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  const hide = useMenu((s) => s.hide);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(open.x, window.innerWidth - r.width - 8);
    const y = Math.min(open.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      hide();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', hide);
    };
  }, [open, hide]);
  if (!open) return null;
  return (
    <div ref={ref} key={open.key} className="ctx-menu" style={{ left: pos?.x ?? open.x, top: pos?.y ?? open.y, visibility: pos ? 'visible' : 'hidden' }}>
      <MenuList items={open.items} onDone={hide} />
    </div>
  );
}

/** A button that opens a dropdown menu below itself. */
export function MenuButton({ items, children, className = '', title }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; className?: string; title?: string }) {
  return (
    <button
      type="button"
      className={`btn ${className}`}
      title={title}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        useMenu.getState().show(r.left, r.bottom + 4, typeof items === 'function' ? items() : items);
      }}
    >
      {children}
    </button>
  );
}
