// Shared UI controls: pointer-drag helper, knobs, faders, level meters and small widgets.

import { useEffect, useRef, type ReactNode } from 'react';
import { engine } from '../../audio/engine';
import { clamp, gainToDb } from '../../core/util';
import { useDaw } from '../../state/store';
import { onFrame } from '../raf';
import { cssVar, setupCanvas } from '../theme';

export function dragPointer(
  e: { clientX: number; clientY: number; pointerId?: number; target?: EventTarget | null },
  handlers: { move: (ev: PointerEvent, dx: number, dy: number) => void; up?: (ev: PointerEvent, moved: boolean) => void; threshold?: number },
): void {
  const x0 = e.clientX;
  const y0 = e.clientY;
  const threshold = handlers.threshold ?? 3;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    moved = true;
    handlers.move(ev, dx, dy);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    handlers.up?.(ev, moved);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ fader scale

/** Fader position 0 … 1 ↔ dB. 0.8 is unity; the top 20 % covers +6 dB. */
export function faderToDb(pos: number): number {
  if (pos <= 0.002) return -96;
  if (pos >= 0.8) return ((pos - 0.8) / 0.2) * 6;
  return Math.max(-96, 50 * Math.log10(pos / 0.8));
}

export function dbToFader(db: number): number {
  if (db <= -95.9) return 0;
  if (db >= 0) return 0.8 + (Math.min(6, db) / 6) * 0.2;
  return 0.8 * Math.pow(10, db / 50);
}

// ------------------------------------------------------------------ knob

interface KnobProps {
  value: number;
  min?: number;
  max?: number;
  def?: number;
  onChange: (v: number) => void;
  label?: string;
  size?: number;
  log?: boolean;
  bipolar?: boolean;
  format?: (v: number) => string;
  title?: string;
  gestureLabel?: string;
  step?: number;
}

export function Knob({ value, min = 0, max = 1, def, onChange, label, size = 34, log, bipolar, format, title, gestureLabel, step }: KnobProps) {
  const norm = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const denorm = (n: number) => {
    const c = clamp(n, 0, 1);
    let v = log ? min * Math.pow(max / min, c) : min + c * (max - min);
    if (step) v = Math.round(v / step) * step;
    return v;
  };
  const n = clamp(norm(value), 0, 1);
  const a0 = -135;
  const a = a0 + n * 270;
  const r = size / 2 - 3;
  const cx = size / 2;
  const cy = size / 2;
  const pt = (deg: number, rr = r) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + rr * Math.cos(rad), cy + rr * Math.sin(rad)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M${x1} ${y1}A${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`;
  };
  const start = bipolar ? 0 : a0;
  const [px, py] = pt(a, r - 4);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    const n0 = n;
    const st = useDaw.getState();
    st.beginGesture();
    dragPointer(e, {
      threshold: 1,
      move: (ev, _dx, dy) => onChange(denorm(n0 - dy / (ev.shiftKey ? 900 : 160))),
      up: () => st.endGesture(gestureLabel ?? label ?? '調整參數'),
    });
  };
  return (
    <div className="knob" title={title ?? label}>
      <div
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => def !== undefined && onChange(def)}
        onWheel={(e) => {
          e.stopPropagation();
          onChange(denorm(n - Math.sign(e.deltaY) * 0.02));
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(denorm(n + 0.02));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(denorm(n - 0.02));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <svg width={size} height={size} aria-hidden="true">
          <path d={arc(a0, a0 + 270)} className="knob-track" />
          {Math.abs(a - start) > 0.5 && <path d={a > start ? arc(start, a) : arc(a, start)} className="knob-value" />}
          <line x1={cx} y1={cy} x2={px} y2={py} className="knob-pointer" />
        </svg>
      </div>
      {label && <div className="knob-label">{label}</div>}
      <div className="knob-readout">{format ? format(value) : value.toFixed(2)}</div>
    </div>
  );
}

// ------------------------------------------------------------------ fader

export function Fader({ db, onChange, height = 150, label = '音量' }: { db: number; onChange: (db: number) => void; height?: number; label?: string }) {
  const pos = dbToFader(db);
  const ref = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const st = useDaw.getState();
    st.beginGesture();
    const rect = ref.current!.getBoundingClientRect();
    const usable = rect.height - 18;
    const onCap = (e.target as HTMLElement).classList.contains('fader-cap');
    let p0 = pos;
    if (!onCap) {
      p0 = clamp(1 - (e.clientY - rect.top - 9) / usable, 0, 1);
      onChange(Math.round(faderToDb(p0) * 10) / 10);
    }
    dragPointer(e, {
      threshold: 0,
      move: (ev, _dx, dy) => onChange(Math.round(faderToDb(clamp(p0 - dy / (usable * (ev.shiftKey ? 6 : 1)), 0, 1)) * 10) / 10),
      up: () => st.endGesture(label),
    });
  };
  return (
    <div
      ref={ref}
      className="fader"
      style={{ height }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={db}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(0)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onChange(Math.min(6, db + (e.shiftKey ? 0.1 : 1)));
        else if (e.key === 'ArrowDown') onChange(Math.max(-96, db - (e.shiftKey ? 0.1 : 1)));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onWheel={(e) => {
        e.stopPropagation();
        onChange(Math.round(faderToDb(clamp(pos - Math.sign(e.deltaY) * 0.02, 0, 1)) * 10) / 10);
      }}
    >
      <div className="fader-slot" />
      <div className="fader-unity" style={{ bottom: 0.8 * (height - 18) + 8 }} />
      <div className="fader-cap" style={{ bottom: pos * (height - 18) }} />
    </div>
  );
}

// ------------------------------------------------------------------ meter

const METER_TICKS = [6, 0, -6, -12, -24, -48];

export function Meter({ id, height = 150, width = 14, ticks = false }: { id: string; height?: number; width?: number; ticks?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let lastClip = 0;
    return onFrame((now) => {
      const c = ref.current;
      if (!c) return;
      const ctx = setupCanvas(c, width, height);
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = cssVar('--meter-bg');
      ctx.fillRect(0, 0, width, height);
      const m = engine.readMeter(id);
      const barW = (width - 3) / 2;
      const h = height - 4;
      const toY = (g: number) => 2 + h - dbToFader(gainToDb(g)) * h;
      const drawBar = (x: number, g: number, hold: number) => {
        const y = toY(g);
        const grad = ctx.createLinearGradient(0, 2 + h, 0, 2);
        grad.addColorStop(0, cssVar('--meter-low'));
        grad.addColorStop(0.72, cssVar('--meter-low'));
        grad.addColorStop(0.8, cssVar('--meter-mid'));
        grad.addColorStop(0.93, cssVar('--meter-high'));
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, 2 + h - y);
        if (hold > 0.0001) {
          ctx.fillStyle = hold >= 1 ? cssVar('--rec') : cssVar('--fg-2');
          ctx.fillRect(x, toY(hold) - 1, barW, 1.5);
        }
      };
      if (m) {
        drawBar(1, m.l, m.holdL);
        drawBar(2 + barW, m.r, m.holdR);
        if (m.l >= 1 || m.r >= 1) lastClip = now;
      }
      if (now - lastClip < 1500) {
        ctx.fillStyle = cssVar('--rec');
        ctx.fillRect(0, 0, width, 3);
      }
      if (ticks) {
        ctx.fillStyle = cssVar('--fg-3');
        for (const t of METER_TICKS) ctx.fillRect(0, toY(Math.pow(10, t / 20)), 2, 1);
      }
    });
  }, [id, height, width, ticks]);
  return <canvas ref={ref} className="meter" aria-hidden="true" />;
}

export function MeterScale({ height = 150 }: { height?: number }) {
  const h = height - 4;
  return (
    <div className="meter-scale" style={{ height }} aria-hidden="true">
      {METER_TICKS.map((t) => (
        <span key={t} style={{ top: 2 + h - dbToFader(t) * h - 6 }}>
          {t > 0 ? `+${t}` : t}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ misc

export function ToggleButton({
  on,
  onClick,
  children,
  title,
  className = '',
  kind,
  disabled,
}: {
  on: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
  title?: string;
  className?: string;
  kind?: 'mute' | 'solo' | 'rec' | 'mon' | 'accent';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tbtn ${kind ? `tbtn-${kind}` : ''} ${on ? 'on' : ''} ${className}`}
      aria-pressed={on}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Number that can be dragged vertically or typed (LCD tempo etc.). */
export function DragNumber({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  className = '',
  label,
  pixelsPerStep = 4,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  className?: string;
  label: string;
  pixelsPerStep?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const v0 = value;
    const st = useDaw.getState();
    st.beginGesture();
    dragPointer(e, {
      move: (ev, _dx, dy) => {
        const steps = Math.round(-dy / (ev.shiftKey ? pixelsPerStep * 4 : pixelsPerStep));
        onChange(clamp(Math.round((v0 + steps * step) / step) * step, min, max));
      },
      up: (ev, moved) => {
        st.endGesture(label);
        if (!moved) {
          ev.preventDefault();
          const input = window.document.createElement('input');
          input.type = 'number';
          input.value = String(value);
          input.min = String(min);
          input.max = String(max);
          input.step = String(step);
          input.className = 'dragnum-input';
          input.setAttribute('aria-label', label);
          const host = ref.current;
          if (!host) return;
          host.style.visibility = 'hidden';
          host.parentElement?.insertBefore(input, host);
          input.focus();
          input.select();
          let done = false;
          const finish = (commit: boolean) => {
            if (done) return;
            done = true;
            if (commit) {
              const v = Number(input.value);
              if (Number.isFinite(v)) onChange(clamp(v, min, max));
            }
            input.remove();
            host.style.visibility = '';
          };
          input.addEventListener('keydown', (k) => {
            k.stopPropagation();
            if (k.key === 'Enter') finish(true);
            if (k.key === 'Escape') finish(false);
          });
          input.addEventListener('blur', () => finish(true));
        }
      },
    });
  };
  return (
    <button
      ref={ref}
      type="button"
      className={`dragnum ${className}`}
      aria-label={label}
      title={`${label}（上下拖曳或點擊輸入）`}
      onPointerDown={onPointerDown}
      onWheel={(e) => onChange(clamp(value - Math.sign(e.deltaY) * step, min, max))}
    >
      {format ? format(value) : value}
    </button>
  );
}
