// Piano roll editor: canvas grid with native scrolling, keyboard, velocity lane, pointer / pencil /
// eraser tools, marquee, move / resize / copy of notes, scale guide and audition.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { engine } from '../audio/engine';
import { DRUM_BY_NOTE } from '../audio/dsp/drums';
import { getPatch } from '../audio/instruments/patches';
import { beatsPerBar, floorToGrid, gridBeats, snapBeat, tidy } from '../core/time';
import type { MidiRegion, Note, Track } from '../core/types';
import { clamp, uid } from '../core/util';
import { isInScale, noteName } from '../music/theory';
import { addNotes, deleteNotes, editMidiRegion, setNoteVelocity, transposeNotes } from '../state/actions';
import { useDaw, type EditorTool } from '../state/store';
import * as cmd from './commands';
import { dragPointer } from './controls/controls';
import { Icon } from './icons';
import { onFrame } from './raf';
import { cssVar, onThemeChange, setupCanvas } from './theme';

const st = () => useDaw.getState();
const KEYS_W = 64;
const VEL_H = 60;

const BLACK = new Set([1, 3, 6, 8, 10]);

export function velocityColor(v: number, selected: boolean): string {
  const t = clamp(v / 127, 0, 1);
  const hue = 265 - t * 255;
  return `hsl(${hue} ${selected ? 90 : 72}% ${selected ? 66 : 56}%)`;
}

let lastDuration = 0.5;

export function PianoRoll({ region, track }: { region: MidiRegion; track: Track }) {
  const ppb = useDaw((s) => s.ui.editorPxPerBeat);
  const rowH = useDaw((s) => s.ui.editorRowHeight);
  const tool = useDaw((s) => s.ui.tool);
  const snap = useDaw((s) => s.ui.snap);
  const scaleGuide = useDaw((s) => s.ui.scaleGuide);
  const selected = useDaw(useShallow((s) => s.ui.selectedNoteIds));
  const timeSig = useDaw((s) => s.project.timeSig);
  const key = useDaw((s) => s.project.key);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLCanvasElement>(null);
  const velRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pressedKey, setPressedKey] = useState<number | null>(null);
  const [cursor, setCursor] = useState('default');
  const isDrums = getPatch(track.instrument?.patchId).engine === 'drums';
  const bar = beatsPerBar(timeSig);
  const contentBeats = Math.max(region.length + bar * 4, bar * 8);
  const contentW = contentBeats * ppb;
  const contentH = 128 * rowH;
  const grid = gridBeats(snap, ppb, timeSig, 12);
  const selSet = new Set(selected);
  const dirty = useRef(true);

  const draw = useCallback(() => {
    const sc = scrollRef.current;
    const cv = canvasRef.current;
    if (!sc || !cv) return;
    const vw = sc.clientWidth;
    const vh = sc.clientHeight;
    const sl = sc.scrollLeft;
    const stp = sc.scrollTop;
    const ctx = setupCanvas(cv, vw, vh);
    if (!ctx) return;
    // rows
    const firstRow = Math.floor(stp / rowH);
    const lastRow = Math.min(127, Math.ceil((stp + vh) / rowH));
    for (let row = firstRow; row <= lastRow; row++) {
      const pitch = 127 - row;
      const y = row * rowH - stp;
      const black = BLACK.has(pitch % 12);
      ctx.fillStyle = black ? cssVar('--roll-black') : cssVar('--roll-white');
      ctx.fillRect(0, y, vw, rowH);
      if (scaleGuide && !isDrums && isInScale(pitch, key.root, key.mode)) {
        ctx.fillStyle = cssVar('--roll-scale');
        ctx.fillRect(0, y, vw, rowH);
      }
      if (isDrums && DRUM_BY_NOTE.has(pitch)) {
        ctx.fillStyle = cssVar('--roll-scale');
        ctx.fillRect(0, y, vw, rowH);
      }
      ctx.fillStyle = pitch % 12 === 0 ? cssVar('--grid-bar') : cssVar('--grid-sub');
      ctx.fillRect(0, y + rowH - 1, vw, 1);
    }
    // vertical grid
    const b0 = sl / ppb;
    const b1 = (sl + vw) / ppb;
    const beatUnit = 4 / timeSig[1];
    const drawLines = (step: number, color: string) => {
      ctx.fillStyle = color;
      for (let b = Math.ceil(b0 / step) * step; b <= b1; b += step) ctx.fillRect(Math.round(b * ppb - sl), 0, 1, vh);
    };
    if (grid > 0 && grid * ppb >= 6) drawLines(grid, cssVar('--grid-sub'));
    drawLines(beatUnit, cssVar('--grid-beat'));
    drawLines(bar, cssVar('--grid-bar'));
    // outside the region
    const endX = region.length * ppb - sl;
    if (endX < vw) {
      ctx.fillStyle = cssVar('--roll-outside');
      ctx.fillRect(Math.max(0, endX), 0, vw - Math.max(0, endX), vh);
      ctx.fillStyle = cssVar('--accent');
      ctx.fillRect(endX - 1, 0, 2, vh);
    }
    // notes
    ctx.font = `600 ${Math.min(10, rowH - 3)}px ${cssVar('--font-mono')}`;
    ctx.textBaseline = 'middle';
    for (const n of region.notes) {
      const x = n.start * ppb - sl;
      const w = Math.max(3, n.duration * ppb - 1);
      const y = (127 - n.pitch) * rowH - stp;
      if (x > vw || x + w < 0 || y > vh || y + rowH < 0) continue;
      const isSel = selSet.has(n.id);
      const outside = n.start >= region.length;
      ctx.globalAlpha = outside ? 0.35 : 1;
      ctx.fillStyle = velocityColor(n.velocity, isSel);
      const r = Math.min(3, rowH / 3);
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 1, w, rowH - 2, r);
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = cssVar('--note-outline');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (w > 28 && rowH >= 11) {
        ctx.fillStyle = cssVar('--note-text');
        const label = isDrums ? DRUM_BY_NOTE.get(n.pitch)?.short ?? noteName(n.pitch) : noteName(n.pitch);
        ctx.fillText(label, x + 4, y + rowH / 2 + 0.5, w - 6);
      }
      ctx.globalAlpha = 1;
    }
    // keyboard
    const kc = keysRef.current;
    if (kc) {
      const kctx = setupCanvas(kc, KEYS_W, vh);
      if (kctx) {
        kctx.font = `500 ${Math.min(10, rowH - 3)}px ${cssVar('--font-ui')}`;
        kctx.textBaseline = 'middle';
        for (let row = firstRow; row <= lastRow; row++) {
          const pitch = 127 - row;
          const y = row * rowH - stp;
          const black = BLACK.has(pitch % 12);
          const pressed = pressedKey === pitch;
          kctx.fillStyle = pressed ? cssVar('--accent') : black ? cssVar('--key-black') : cssVar('--key-white');
          kctx.fillRect(0, y, black && !isDrums ? KEYS_W * 0.62 : KEYS_W, rowH);
          if (black && !isDrums) {
            kctx.fillStyle = cssVar('--key-white');
            kctx.fillRect(KEYS_W * 0.62, y, KEYS_W * 0.38, rowH);
          }
          kctx.fillStyle = cssVar('--key-line');
          kctx.fillRect(0, y + rowH - 1, KEYS_W, 1);
          if (isDrums) {
            const d = DRUM_BY_NOTE.get(pitch);
            if (d && rowH >= 9) {
              kctx.fillStyle = cssVar('--key-label');
              kctx.fillText(d.short, 4, y + rowH / 2, KEYS_W - 6);
            }
          } else if (pitch % 12 === 0 && rowH >= 8) {
            kctx.fillStyle = cssVar('--key-label');
            kctx.fillText(noteName(pitch), KEYS_W - 26, y + rowH / 2);
          }
        }
      }
    }
    // velocity lane
    const vc = velRef.current;
    if (vc) {
      const vctx = setupCanvas(vc, vw, VEL_H);
      if (vctx) {
        vctx.fillStyle = cssVar('--surface');
        vctx.fillRect(0, 0, vw, VEL_H);
        vctx.fillStyle = cssVar('--grid-sub');
        for (const f of [0.25, 0.5, 0.75]) vctx.fillRect(0, Math.round(VEL_H * f), vw, 1);
        for (const n of region.notes) {
          const x = n.start * ppb - sl;
          if (x < -4 || x > vw + 4) continue;
          const h = (n.velocity / 127) * (VEL_H - 8);
          const isSel = selSet.has(n.id);
          vctx.fillStyle = velocityColor(n.velocity, isSel);
          vctx.fillRect(x, VEL_H - 2 - h, 2, h);
          vctx.beginPath();
          vctx.arc(x + 1, VEL_H - 2 - h, isSel ? 4 : 3, 0, Math.PI * 2);
          vctx.fill();
        }
      }
    }
    dirty.current = false;
  }, [ppb, rowH, region, timeSig, key, scaleGuide, isDrums, selected, grid, pressedKey]);

  useEffect(() => {
    dirty.current = true;
  }, [draw]);

  useEffect(() => onThemeChange(() => (dirty.current = true)), []);

  useEffect(
    () =>
      onFrame(() => {
        if (dirty.current) draw();
        const sc = scrollRef.current;
        const ph = playheadRef.current;
        if (sc && ph) {
          const beat = engine.currentBeat() - region.start;
          const x = beat * ppb - sc.scrollLeft;
          ph.style.transform = `translateX(${x}px)`;
          ph.hidden = x < 0 || x > sc.clientWidth;
          if (st().transport.playing && beat >= 0 && beat <= region.length) {
            const bx = beat * ppb;
            if (bx > sc.scrollLeft + sc.clientWidth * 0.95) sc.scrollLeft = bx - sc.clientWidth * 0.1;
          }
        }
      }),
    [draw, ppb, region.start, region.length],
  );

  // initial scroll: centre on the notes (or around C4)
  const regionId = region.id;
  const fitToNotes = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const pitches = region.notes.map((n) => n.pitch);
    const lo = pitches.length ? Math.min(...pitches) : isDrums ? 36 : 55;
    const hi = pitches.length ? Math.max(...pitches) : isDrums ? 51 : 72;
    // zoom rows so the used range fits, then centre it
    const h = Math.max(7, Math.min(16, Math.floor(sc.clientHeight / (hi - lo + 3))));
    if (h !== st().ui.editorRowHeight) st().setUi({ editorRowHeight: h });
    const mid = (lo + hi) / 2;
    requestAnimationFrame(() => {
      sc.scrollTop = Math.max(0, (127.5 - mid) * h - sc.clientHeight / 2);
      sc.scrollLeft = 0;
      dirty.current = true;
    });
  }, [region.notes, isDrums]);

  useLayoutEffect(() => {
    // the panel may still be settling its height on the first frame
    const raf = requestAnimationFrame(fitToNotes);
    return () => cancelAnimationFrame(raf);
  }, [regionId]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => (dirty.current = true));
    ro.observe(sc);
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s = st();
        const old = s.ui.editorPxPerBeat;
        const next = clamp(old * Math.pow(1.0018, -e.deltaY), 12, 800);
        const px = e.clientX - sc.getBoundingClientRect().left;
        const beat = (sc.scrollLeft + px) / old;
        s.setUi({ editorPxPerBeat: next });
        requestAnimationFrame(() => (sc.scrollLeft = beat * next - px));
      } else if (e.altKey) {
        e.preventDefault();
        const s = st();
        const old = s.ui.editorRowHeight;
        const next = clamp(old - Math.sign(e.deltaY), 7, 28);
        if (next !== old) {
          const py = e.clientY - sc.getBoundingClientRect().top;
          const pitchAt = (sc.scrollTop + py) / old;
          s.setUi({ editorRowHeight: next });
          requestAnimationFrame(() => (sc.scrollTop = pitchAt * next - py));
        }
      }
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      sc.removeEventListener('wheel', onWheel);
    };
  }, []);

  // ---------------------------------------------------------------- pointer interactions

  const toContent = (e: { clientX: number; clientY: number }) => {
    const sc = scrollRef.current!;
    const rect = sc.getBoundingClientRect();
    return { x: e.clientX - rect.left + sc.scrollLeft, y: e.clientY - rect.top + sc.scrollTop };
  };

  const hitNote = (x: number, y: number): Note | null => {
    const pitch = 127 - Math.floor(y / rowH);
    for (let i = region.notes.length - 1; i >= 0; i--) {
      const n = region.notes[i];
      if (n.pitch !== pitch) continue;
      const nx = n.start * ppb;
      const nw = Math.max(4, n.duration * ppb);
      if (x >= nx && x <= nx + nw) return n;
    }
    return null;
  };

  const preview = (pitch: number, vel = 100) => engine.previewNote(track.id, pitch, vel, isDrums ? 0.5 : 0.3);

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons) return;
    const { x, y } = toContent(e);
    const n = hitNote(x, y);
    if (tool === 'eraser') setCursor('not-allowed');
    else if (n) {
      const right = n.start * ppb + n.duration * ppb;
      setCursor(x > right - Math.min(8, (n.duration * ppb) / 3) ? 'ew-resize' : 'grab');
    } else setCursor(tool === 'pencil' ? 'crosshair' : 'default');
  };

  const createNoteAt = (e: React.PointerEvent, x: number, y: number) => {
    const pitch = clamp(127 - Math.floor(y / rowH), 0, 127);
    const g = e.metaKey || e.ctrlKey ? 0 : grid || 0.25;
    const start = Math.max(0, g ? floorToGrid(x / ppb, g) : tidy(x / ppb));
    const dur = isDrums ? Math.max(0.125, Math.min(0.25, g || 0.25)) : lastDuration;
    const s = st();
    s.beginGesture();
    const [id] = addNotes(region.id, [{ pitch, start, duration: dur, velocity: s.ui.typingVelocity }]);
    s.setUi({ selectedNoteIds: [id] });
    preview(pitch);
    dragPointer(e, {
      move: (ev) => {
        const p2 = toContent(ev);
        const end = Math.max(start + (g || 1 / 32), g ? snapBeat(p2.x / ppb, g) : p2.x / ppb);
        editMidiRegion(region.id, '畫音符', (r) => {
          const n = r.notes.find((q) => q.id === id);
          if (n) n.duration = tidy(end - start);
        });
      },
      up: () => {
        const n = findNote(id);
        if (n) lastDuration = n.duration;
        s.endGesture('畫音符');
      },
    });
  };

  const findNote = (id: string): Note | undefined => {
    const r = st().project.tracks.flatMap((t) => t.regions).find((x) => x.id === region.id);
    return r && r.kind === 'midi' ? r.notes.find((n) => n.id === id) : undefined;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    cmd.setFocusZone('editor');
    const { x, y } = toContent(e);
    const hit = hitNote(x, y);
    const s = st();
    if (tool === 'eraser') {
      const erased = new Set<string>();
      if (hit) erased.add(hit.id);
      s.beginGesture();
      if (hit) deleteNotes(region.id, [hit.id]);
      dragPointer(e, {
        threshold: 0,
        move: (ev) => {
          const p2 = toContent(ev);
          const n = hitNote(p2.x, p2.y);
          if (n && !erased.has(n.id)) {
            erased.add(n.id);
            deleteNotes(region.id, [n.id]);
          }
        },
        up: () => s.endGesture('刪除音符'),
      });
      return;
    }
    if (!hit) {
      if (tool === 'pencil' || e.detail >= 2) {
        createNoteAt(e, x, y);
        return;
      }
      // marquee
      const additive = e.shiftKey;
      const before = additive ? s.ui.selectedNoteIds : [];
      if (!additive) s.setUi({ selectedNoteIds: [] });
      dragPointer(e, {
        move: (ev) => {
          const p2 = toContent(ev);
          const rx = Math.min(x, p2.x);
          const ry = Math.min(y, p2.y);
          const rw = Math.abs(p2.x - x);
          const rh = Math.abs(p2.y - y);
          const sc = scrollRef.current!;
          setMarquee({ x: rx - sc.scrollLeft, y: ry - sc.scrollTop, w: rw, h: rh });
          const ids = region.notes
            .filter((n) => {
              const nx = n.start * ppb;
              const ny = (127 - n.pitch) * rowH;
              return nx + n.duration * ppb >= rx && nx <= rx + rw && ny + rowH >= ry && ny <= ry + rh;
            })
            .map((n) => n.id);
          st().setUi({ selectedNoteIds: Array.from(new Set([...before, ...ids])) });
        },
        up: () => setMarquee(null),
      });
      return;
    }
    // hit a note: select / move / resize / copy
    let sel = s.ui.selectedNoteIds;
    if (e.shiftKey) {
      sel = sel.includes(hit.id) ? sel.filter((i) => i !== hit.id) : [...sel, hit.id];
      s.setUi({ selectedNoteIds: sel });
      return;
    }
    if (!sel.includes(hit.id)) {
      sel = [hit.id];
      s.setUi({ selectedNoteIds: sel });
    }
    const right = hit.start * ppb + hit.duration * ppb;
    const resize = x > right - Math.min(8, (hit.duration * ppb) / 3);
    const orig = new Map(region.notes.filter((n) => sel.includes(n.id)).map((n) => [n.id, { ...n }]));
    let ids = [...orig.keys()];
    let copied = false;
    let lastPitchDelta = 0;
    preview(hit.pitch, hit.velocity);
    s.beginGesture();
    dragPointer(e, {
      move: (ev, dx, dy) => {
        const g = ev.metaKey || ev.ctrlKey ? 0 : grid;
        if (resize) {
          const newEnd = g ? snapBeat(hit.start + hit.duration + dx / ppb, g) : hit.start + hit.duration + dx / ppb;
          const delta = newEnd - (hit.start + hit.duration);
          editMidiRegion(region.id, '調整音符長度', (r) => {
            for (const n of r.notes) {
              const o = orig.get(n.id);
              if (o) n.duration = tidy(Math.max(g ? g / 2 : 1 / 64, o.duration + delta));
            }
          });
          return;
        }
        if (ev.altKey && !copied) {
          copied = true;
          const map = new Map<string, string>();
          editMidiRegion(region.id, '複製音符', (r) => {
            for (const o of orig.values()) {
              const nid = uid('n');
              map.set(o.id, nid);
              r.notes.push({ ...o, id: nid });
            }
          });
          ids = ids.map((i) => map.get(i)!);
          const remapped = new Map<string, Note>();
          for (const [oid, o] of orig) remapped.set(map.get(oid)!, { ...o, id: map.get(oid)! });
          orig.clear();
          remapped.forEach((v, k) => orig.set(k, v));
          st().setUi({ selectedNoteIds: ids });
        }
        const targetStart = g ? snapBeat(hit.start + dx / ppb, g) : hit.start + dx / ppb;
        const minStart = Math.min(...[...orig.values()].map((o) => o.start));
        const dBeat = Math.max(targetStart - hit.start, -minStart);
        const dPitch = Math.round(-dy / rowH);
        editMidiRegion(region.id, '移動音符', (r) => {
          for (const n of r.notes) {
            const o = orig.get(n.id);
            if (!o) continue;
            n.start = tidy(Math.max(0, o.start + dBeat));
            n.pitch = clamp(o.pitch + dPitch, 0, 127);
          }
        });
        if (dPitch !== lastPitchDelta) {
          lastPitchDelta = dPitch;
          preview(clamp(hit.pitch + dPitch, 0, 127), hit.velocity);
        }
      },
      up: (_ev, moved) => {
        s.endGesture(resize ? '調整音符長度' : copied ? '複製音符' : '移動音符');
        if (!moved && sel.length > 1 && !e.shiftKey) st().setUi({ selectedNoteIds: [hit.id] });
        if (resize) {
          const n = findNote(hit.id);
          if (n) lastDuration = n.duration;
        }
      },
    });
  };

  const onKeysDown = (e: React.PointerEvent) => {
    const kc = keysRef.current!;
    const sc = scrollRef.current!;
    const pitchAt = (cy: number) => clamp(127 - Math.floor((cy - kc.getBoundingClientRect().top + sc.scrollTop) / rowH), 0, 127);
    let cur = pitchAt(e.clientY);
    engine.noteOn(track.id, cur, 100);
    setPressedKey(cur);
    dragPointer(e, {
      threshold: 0,
      move: (ev) => {
        const p = pitchAt(ev.clientY);
        if (p !== cur) {
          engine.noteOff(track.id, cur);
          cur = p;
          engine.noteOn(track.id, cur, 100);
          setPressedKey(cur);
        }
      },
      up: () => {
        engine.noteOff(track.id, cur);
        setPressedKey(null);
      },
    });
  };

  const onVelDown = (e: React.PointerEvent) => {
    cmd.setFocusZone('editor');
    const vc = velRef.current!;
    const sc = scrollRef.current!;
    const s = st();
    s.beginGesture();
    const apply = (ev: { clientX: number; clientY: number }) => {
      const rect = vc.getBoundingClientRect();
      const x = ev.clientX - rect.left + sc.scrollLeft;
      const v = clamp(Math.round((1 - (ev.clientY - rect.top - 2) / (VEL_H - 8)) * 127), 1, 127);
      const sel = st().ui.selectedNoteIds;
      const under = region.notes.filter((n) => Math.abs(n.start * ppb - x) <= 5).map((n) => n.id);
      const targets = under.some((id) => sel.includes(id)) ? sel : under;
      if (targets.length) setNoteVelocity(region.id, targets, v);
    };
    apply(e);
    dragPointer(e, { threshold: 0, move: (ev) => apply(ev), up: () => s.endGesture('力度') });
  };

  const selNotes = region.notes.filter((n) => selSet.has(n.id));
  const avgVel = selNotes.length ? Math.round(selNotes.reduce((a, n) => a + n.velocity, 0) / selNotes.length) : null;

  const toolBtn = (t: EditorTool, icon: string, label: string) => (
    <button type="button" className={`tbtn ${tool === t ? 'on' : ''}`} aria-pressed={tool === t} title={label} onClick={() => st().setUi({ tool: t })}>
      <Icon name={icon} size={16} />
    </button>
  );

  return (
    <div className="roll">
      <div className="editor-toolbar">
        <div className="seg">
          {toolBtn('pointer', 'pointer', '選取工具 (1)：拖曳移動、拉右緣調長度、Option 拖曳複製、雙擊新增')}
          {toolBtn('pencil', 'pencil', '畫筆工具 (2)：點擊新增音符、拖曳決定長度')}
          {toolBtn('eraser', 'eraser', '橡皮擦 (3)：點擊或拖過音符刪除')}
        </div>
        <button type="button" className="btn" onClick={cmd.quantizeSelection} title="量化（選取的音符；沒選就整個片段）(Q)">
          <Icon name="quantize" size={16} /> 量化
        </button>
        <div className="seg" role="group" aria-label="移調">
          <button type="button" className="btn" title="降八度" onClick={() => transposeNotes(region.id, selected.length ? selected : null, -12)}>
            −12
          </button>
          <button type="button" className="btn" title="降半音 (↓)" onClick={() => transposeNotes(region.id, selected.length ? selected : null, -1)}>
            −1
          </button>
          <button type="button" className="btn" title="升半音 (↑)" onClick={() => transposeNotes(region.id, selected.length ? selected : null, 1)}>
            +1
          </button>
          <button type="button" className="btn" title="升八度" onClick={() => transposeNotes(region.id, selected.length ? selected : null, 12)}>
            +12
          </button>
        </div>
        {avgVel !== null && (
          <label className="tb-field" title="選取音符的力度">
            力度
            <input
              type="range"
              min={1}
              max={127}
              value={avgVel}
              aria-label="力度"
              onPointerDown={() => st().beginGesture()}
              onPointerUp={() => st().endGesture('力度')}
              onChange={(e) => setNoteVelocity(region.id, selected, Number(e.target.value))}
            />
            <span className="num">{avgVel}</span>
          </label>
        )}
        {!isDrums && (
          <button type="button" className={`tbtn ${scaleGuide ? 'on' : ''}`} aria-pressed={scaleGuide} title="調性輔助：標示目前調性的音" onClick={() => st().setUi({ scaleGuide: !scaleGuide })}>
            <Icon name="rows" size={16} />
            <span className="tbtn-text">調性輔助</span>
          </button>
        )}
        <div className="tb-spacer" />
        <span className="editor-info">
          {selected.length ? `已選 ${selected.length} 個音符 · ` : ''}
          {region.notes.length} 音符 · {Math.round((region.length / bar) * 100) / 100} 小節
        </span>
        <button type="button" className="btn" title="把所有音符放進畫面" onClick={fitToNotes}>
          符合音符
        </button>
        <button type="button" className="btn icon-btn" title="縮小" onClick={() => st().setUi({ editorPxPerBeat: clamp(ppb / 1.4, 12, 800) })}>
          <Icon name="zoomOut" />
        </button>
        <button type="button" className="btn icon-btn" title="放大" onClick={() => st().setUi({ editorPxPerBeat: clamp(ppb * 1.4, 12, 800) })}>
          <Icon name="zoomIn" />
        </button>
      </div>
      <div className="roll-body" style={{ ['--keys-w' as string]: `${KEYS_W}px`, ['--vel-h' as string]: `${VEL_H}px` }}>
        <canvas ref={keysRef} className="roll-keys" onPointerDown={onKeysDown} aria-label="鍵盤（點擊試聽）" />
        <div className="roll-scroll" ref={scrollRef} onScroll={() => (dirty.current = true)}>
          <div className="roll-sticky">
            <canvas ref={canvasRef} className="roll-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} style={{ cursor }} />
            <div className="roll-playhead" ref={playheadRef} aria-hidden="true" />
            {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
          </div>
          <div className="roll-spacer" style={{ width: contentW, height: contentH }} />
        </div>
        <div className="vel-label">力度</div>
        <canvas ref={velRef} className="roll-vel" onPointerDown={onVelDown} aria-label="力度（拖曳調整）" />
      </div>
    </div>
  );
}
