// Top control bar: panels, transport, LCD (position / tempo / meter / key), metronome and file menu.

import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { beatsToSeconds, formatBBT, formatClock } from '../core/time';
import { keyPrefersFlats, pcName } from '../music/theory';
import { setBpm, setKey, setMasterVolume, setTimeSig } from '../state/actions';
import { useDaw } from '../state/store';
import * as cmd from './commands';
import { DragNumber, Knob, ToggleButton } from './controls/controls';
import { Icon } from './icons';
import { MenuButton, type MenuItem } from './menu';
import { onFrame } from './raf';
import type { ScaleMode } from '../core/types';
import { formatDb } from '../core/util';
import { renderService } from '../audio/renderService';
import { sampleLibrary } from '../audio/samples/library';
import { installApp, isInstalledApp, OFFLINE_BUILD } from '../core/offline';

const MODE_SHORT: Record<ScaleMode, string> = {
  major: '大調',
  minor: '小調',
  dorian: 'Dorian',
  mixolydian: 'Mixo',
  phrygian: 'Phryg',
  lydian: 'Lydian',
  harmonicMinor: '和聲小調',
};

function shortKey(root: number, mode: ScaleMode): string {
  return `${pcName(root, keyPrefersFlats(root, mode))} ${MODE_SHORT[mode]}`;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';

function Lcd() {
  const bbtRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      onFrame(() => {
        const p = useDaw.getState().project;
        const left = engine.countInLeft();
        const beat = left > 0 ? useDaw.getState().transport.position : engine.currentBeat();
        const b = formatBBT(beat, p.timeSig);
        if (bbtRef.current) {
          const txt = `${String(b.bar).padStart(3, ' ')} ${b.beat} ${b.div} ${String(b.tick).padStart(3, '0')}`;
          if (bbtRef.current.textContent !== txt) bbtRef.current.textContent = txt;
        }
        if (timeRef.current) {
          const txt = formatClock(beatsToSeconds(Math.max(0, beat), p.bpm));
          if (timeRef.current.textContent !== txt) timeRef.current.textContent = txt;
        }
        if (countRef.current) {
          const txt = left > 0 ? `預備 ${Math.ceil(left)}` : '';
          if (countRef.current.textContent !== txt) countRef.current.textContent = txt;
          countRef.current.hidden = left <= 0;
        }
      }),
    [],
  );
  const bpm = useDaw((s) => s.project.bpm);
  const sig = useDaw((s) => s.project.timeSig);
  const key = useDaw((s) => s.project.key);
  return (
    <div className="lcd" role="group" aria-label="位置與速度顯示">
      <div className="lcd-cell lcd-pos">
        <span ref={bbtRef} className="lcd-big">
          1 1 1 001
        </span>
        <span className="lcd-cap">小節 拍 格 Tick</span>
      </div>
      <div className="lcd-cell lcd-time">
        <span ref={timeRef} className="lcd-mid">
          00:00.000
        </span>
        <span className="lcd-cap">時間</span>
      </div>
      <div className="lcd-cell">
        <DragNumber className="lcd-mid" value={bpm} min={30} max={300} step={1} onChange={setBpm} label="速度 BPM" format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))} />
        <span className="lcd-cap">BPM</span>
      </div>
      <div className="lcd-cell">
        <select
          className="lcd-select lcd-mid"
          aria-label="拍號"
          value={`${sig[0]}/${sig[1]}`}
          onChange={(e) => {
            const [n, d] = e.target.value.split('/').map(Number);
            setTimeSig(n, d);
          }}
        >
          {['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '12/8'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="lcd-cap">拍號</span>
      </div>
      <div className="lcd-cell">
        <select
          className="lcd-select lcd-mid"
          aria-label="調性"
          value={`${key.root}:${key.mode}`}
          onChange={(e) => {
            const [r, m] = e.target.value.split(':');
            setKey(Number(r), m as ScaleMode);
          }}
        >
          {(['major', 'minor', 'dorian', 'mixolydian', 'phrygian', 'harmonicMinor', 'lydian'] as ScaleMode[]).map((mode) =>
            Array.from({ length: 12 }, (_, r) => (
              <option key={`${r}:${mode}`} value={`${r}:${mode}`}>
                {shortKey(r, mode)}
              </option>
            )),
          )}
        </select>
        <span className="lcd-cap">調性</span>
      </div>
      <span ref={countRef} className="lcd-countin" hidden />
    </div>
  );
}

export function LoadingIndicator() {
  const [count, setCount] = useState({ render: 0, download: 0 });
  const preparing = useDaw((s) => s.transport.preparing);
  useEffect(() => {
    const update = () => setCount({ render: renderService.pendingCount(), download: sampleLibrary.pendingCount() });
    const offRender = renderService.onChange(update);
    const offSamples = sampleLibrary.onChange(update);
    const t = setInterval(update, 500);
    return () => {
      offRender();
      offSamples();
      clearInterval(t);
    };
  }, []);
  if (!preparing && count.render === 0 && count.download === 0) return null;
  return (
    <div className="loading-pill" role="status">
      <span className="spinner" aria-hidden="true" />
      {preparing ? '準備音色中…' : count.download > 0 ? `載入音色 ${count.download}` : `合成音色 ${count.render}`}
    </div>
  );
}

export function ControlBar() {
  const playing = useDaw((s) => s.transport.playing);
  const recording = useDaw((s) => s.transport.recording);
  const loopOn = useDaw((s) => s.project.loop.enabled);
  const metro = useDaw((s) => s.project.metronome.enabled);
  const countIn = useDaw((s) => s.project.metronome.countIn);
  const ui = useDaw((s) => s.ui);
  const masterDb = useDaw((s) => s.project.master.volumeDb);
  const canUndo = useDaw((s) => s.past.length > 0);
  const canRedo = useDaw((s) => s.future.length > 0);
  const setUi = useDaw((s) => s.setUi);

  const fileMenu = (): MenuItem[] => [
    { label: '新增空白專案', onClick: () => void cmd.newProject() },
    { label: '載入示範歌曲', onClick: () => void cmd.loadDemo('pop') },
    { separator: true },
    { label: '開啟專案檔…', onClick: () => void cmd.openProject() },
    { label: '儲存專案檔', shortcut: `${MOD}S`, onClick: () => void cmd.saveProject() },
    { separator: true },
    { label: '匯入音訊檔…', onClick: () => void cmd.importAudio() },
    { label: '匯入 MIDI 檔…', onClick: () => void cmd.importMidi() },
    { separator: true },
    { label: '匯出（WAV／分軌／MIDI）…', onClick: () => setUi({ dialog: { type: 'export' } }) },
    { separator: true },
    { label: '設定…', onClick: () => setUi({ dialog: { type: 'settings' } }) },
    { label: '鍵盤快捷鍵', shortcut: '?', onClick: () => setUi({ dialog: { type: 'shortcuts' } }) },
    { label: '音色來源與授權', onClick: () => setUi({ dialog: { type: 'credits' } }) },
    ...(OFFLINE_BUILD && !isInstalledApp() ? [{ separator: true }, { label: '安裝到主畫面（離線使用）', onClick: () => void installApp() }] : []),
  ];

  return (
    <header className="controlbar">
      <div className="cb-group cb-left">
        <MenuButton items={fileMenu} className="btn-file" title="檔案">
          <Icon name="menu" />
          <span className="brand">miniDaw</span>
        </MenuButton>
        <ToggleButton on={ui.leftPanel === 'library'} onClick={() => cmd.toggleLeft('library')} title="音色庫 (Y)">
          <Icon name="library" />
        </ToggleButton>
        <ToggleButton on={ui.leftPanel === 'inspector'} onClick={() => cmd.toggleLeft('inspector')} title="檢閱器 (I)">
          <Icon name="inspector" />
        </ToggleButton>
        <button type="button" className="btn icon-btn" title={`復原 (${MOD}Z)`} disabled={!canUndo} onClick={() => useDaw.getState().undo()}>
          <Icon name="undo" />
        </button>
        <button type="button" className="btn icon-btn" title={`重做 (${MOD}⇧Z)`} disabled={!canRedo} onClick={() => useDaw.getState().redo()}>
          <Icon name="redo" />
        </button>
      </div>

      <div className="cb-group cb-transport" role="group" aria-label="走帶控制">
        <button type="button" className="tp-btn" title="回到開頭 (Enter)" onClick={cmd.toStart}>
          <Icon name="toStart" />
        </button>
        <button type="button" className="tp-btn" title="倒退一小節 (,)" onClick={() => cmd.moveBars(-1)}>
          <Icon name="back" />
        </button>
        <button type="button" className="tp-btn" title="快進一小節 (.)" onClick={() => cmd.moveBars(1)}>
          <Icon name="forward" />
        </button>
        <button type="button" className="tp-btn" title="停止" onClick={() => void engine.stop()}>
          <Icon name="stop" filled />
        </button>
        <button type="button" className={`tp-btn tp-play ${playing && !recording ? 'on' : ''}`} title="播放／停止 (空白鍵)" aria-pressed={playing} onClick={() => void engine.togglePlay()}>
          <Icon name="play" filled />
        </button>
        <button type="button" className={`tp-btn tp-rec ${recording ? 'on' : ''}`} title="錄音 (R)" aria-pressed={recording} onClick={() => void engine.record()}>
          <Icon name="record" filled />
        </button>
        <ToggleButton on={loopOn} kind="accent" onClick={cmd.toggleLoop} title="循環 Cycle (C)">
          <Icon name="cycle" />
        </ToggleButton>
      </div>

      <Lcd />

      <div className="cb-group">
        <ToggleButton on={metro} kind="accent" onClick={cmd.toggleMetronome} title="節拍器 (K)">
          <Icon name="metronome" />
        </ToggleButton>
        <ToggleButton on={countIn} kind="accent" onClick={cmd.toggleCountIn} title="錄音前預備拍 Count-in">
          <Icon name="countIn" />
        </ToggleButton>
      </div>

      <div className="cb-group cb-right">
        <div className="master-knob">
          <Knob value={masterDb} min={-40} max={6} def={0} size={30} onChange={setMasterVolume} format={(v) => formatDb(v)} title="主音量" gestureLabel="主音量" />
        </div>
        <ToggleButton on={ui.typingOpen} onClick={() => setUi({ typingOpen: !ui.typingOpen })} title={`電腦鍵盤演奏 (${MOD}K)`}>
          <Icon name="keyboard" />
        </ToggleButton>
        <ToggleButton on={ui.bottomPanel === 'editor'} onClick={() => cmd.toggleBottom('editor')} title="編輯器 (E)">
          <Icon name="editor" />
        </ToggleButton>
        <ToggleButton on={ui.bottomPanel === 'mixer'} onClick={() => cmd.toggleBottom('mixer')} title="混音台 (X)">
          <Icon name="mixer" />
        </ToggleButton>
        <ToggleButton on={ui.coachOpen} kind="accent" onClick={() => setUi({ coachOpen: !ui.coachOpen })} title="曲風編曲教練 (G)" className="coach-toggle">
          <Icon name="coach" />
          <span className="tbtn-text">編曲教練</span>
        </ToggleButton>
      </div>
    </header>
  );
}

