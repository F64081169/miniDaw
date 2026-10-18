// Modal dialogs: new track, export, settings, shortcuts, rename, welcome and plug-in windows.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { engine } from '../audio/engine';
import { bounce, defaultBounceRange, peakOf } from '../audio/export';
import { FX_DEFS } from '../audio/fx/registry';
import { CATEGORY_INFO, CATEGORY_ORDER, patchesByCategory } from '../audio/instruments/patches';
import { listInputDevices } from '../audio/recorder';
import { SAMPLE_SETS } from '../audio/samples/library';
import { encodeWav, bufferToChannels, type WavFormat } from '../audio/wav';
import { saveFile, safeFilename } from '../core/files';
import { beatsPerBar, formatClock } from '../core/time';
import { zipFiles } from '../core/zip';
import { gainToDb } from '../core/util';
import GROOVES from '../music/grooves/gmd.json';
import { exportMidi } from '../music/midifile';
import { addAudioTrack, addInstrumentTrack, renameMarker, renameRegion, renameTrack, setMetronome, setProjectName } from '../state/actions';
import { useDaw, type Dialog } from '../state/store';
import * as cmd from './commands';
import { MOD } from './ControlBar';
import { Icon } from './icons';
import { disableMidi, enableMidi } from './liveInput';
import { FxWindow } from './Mixer';
import { applyTheme } from './theme';

const st = () => useDaw.getState();

function Modal({ title, onClose, children, wide = false, className = '' }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,button.btn-primary,button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn icon-btn" title="關閉 (Esc)" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function NewTrackDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="新增音軌" onClose={onClose} wide>
      <div className="newtrack">
        <div className="newtrack-audio">
          <button
            type="button"
            className="big-option"
            onClick={() => {
              addAudioTrack();
              onClose();
            }}
          >
            <Icon name="mic" size={28} />
            <strong>音訊軌</strong>
            <span>用麥克風或錄音介面錄人聲、吉他等真實樂器，或匯入音訊檔。</span>
          </button>
        </div>
        <div className="newtrack-inst">
          <h3>軟體樂器</h3>
          {CATEGORY_ORDER.map((c) => (
            <div key={c} className="nt-cat" style={{ ['--cc' as string]: CATEGORY_INFO[c].color }}>
              <div className="nt-cat-name">
                <Icon name={CATEGORY_INFO[c].icon} size={16} /> {CATEGORY_INFO[c].name}
              </div>
              <div className="nt-patches">
                {patchesByCategory(c).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="chip"
                    title={p.description}
                    onClick={() => {
                      addInstrumentTrack(p.id);
                      onClose();
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useDaw((s) => s.project);
  const [range, setRange] = useState<'song' | 'cycle'>(project.loop.enabled ? 'cycle' : 'song');
  const [bits, setBits] = useState<WavFormat>(16);
  const [rate, setRate] = useState(engine.ctx?.sampleRate === 44100 ? 44100 : 48000);
  const [normalize, setNormalize] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const r = range === 'cycle' && project.loop.end > project.loop.start ? { start: project.loop.start, end: project.loop.end } : { start: 0, end: defaultBounceRange({ ...project, loop: { ...project.loop, enabled: false } }).end };
  const seconds = ((r.end - r.start) * 60) / project.bpm;
  const base = safeFilename(project.name);
  const opts = () => ({ start: r.start, end: r.end, sampleRate: rate, tail: 2.5, normalize, onPhase: setBusy });

  const run = async (fn: () => Promise<void>) => {
    try {
      engine.ensure();
      await fn();
      if (!project.coach?.completed.includes('export')) {
        st().update('完成匯出', (d) => {
          if (d.coach && !d.coach.completed.includes('export')) d.coach.completed.push('export');
        }, { undoable: false });
      }
    } catch (err) {
      st().toast(`匯出失敗：${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const exportMix = () =>
    run(async () => {
      const buf = await bounce(project, opts());
      const peak = peakOf(buf);
      setBusy('編碼 WAV…');
      const wav = encodeWav(bufferToChannels(buf), buf.sampleRate, bits);
      await saveFile(`${base}.wav`, new Blob([wav], { type: 'audio/wav' }));
      st().toast(`已匯出混音（峰值 ${gainToDb(peak).toFixed(1)} dBFS）`, 'success');
    });

  const exportStems = () =>
    run(async () => {
      const files: { name: string; data: Uint8Array }[] = [];
      const tracks = project.tracks.filter((t) => t.regions.length > 0);
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        setBusy(`分軌 ${i + 1}/${tracks.length}：${t.name}`);
        const buf = await bounce(project, { ...opts(), soloTrackId: t.id, normalize: false, onPhase: undefined });
        files.push({ name: `${String(i + 1).padStart(2, '0')} ${safeFilename(t.name)}.wav`, data: new Uint8Array(encodeWav(bufferToChannels(buf), buf.sampleRate, bits)) });
      }
      setBusy('打包 ZIP…');
      await saveFile(`${base} 分軌.zip`, new Blob([zipFiles(files)], { type: 'application/zip' }));
      st().toast(`已匯出 ${files.length} 個分軌`, 'success');
    });

  const exportMid = () =>
    run(async () => {
      const data = exportMidi(project);
      await saveFile(`${base}.mid`, new Blob([data as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }));
      st().toast('已匯出 MIDI 檔（可直接拖進 Logic Pro／GarageBand）', 'success');
    });

  return (
    <Modal title="匯出" onClose={onClose}>
      <div className="form">
        <fieldset className="field">
          <legend>範圍</legend>
          <label className="radio">
            <input type="radio" name="range" checked={range === 'song'} onChange={() => setRange('song')} /> 整首歌
          </label>
          <label className="radio">
            <input type="radio" name="range" checked={range === 'cycle'} disabled={project.loop.end <= project.loop.start} onChange={() => setRange('cycle')} /> 循環範圍
          </label>
          <span className="muted small num">
            {formatClock(seconds)}（{Math.round(((r.end - r.start) / beatsPerBar(project.timeSig)) * 10) / 10} 小節）
          </span>
        </fieldset>
        <div className="field-row">
          <label className="field">
            <span>位元深度</span>
            <select value={bits} onChange={(e) => setBits(Number(e.target.value) as WavFormat)}>
              <option value={16}>16-bit（CD）</option>
              <option value={24}>24-bit（混音／母帶）</option>
              <option value={32}>32-bit 浮點</option>
            </select>
          </label>
          <label className="field">
            <span>取樣率</span>
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> 標準化（峰值 −0.3 dBFS）
        </label>
        <div className="export-actions">
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void exportMix()}>
            <Icon name="download" size={16} /> 匯出混音 WAV
          </button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => void exportStems()}>
            匯出分軌（ZIP）
          </button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => void exportMid()}>
            匯出 MIDI
          </button>
        </div>
        {busy && (
          <p className="busy" role="status">
            <span className="spinner" aria-hidden="true" /> {busy}
          </p>
        )}
        <p className="muted small">混音會以離線方式算出，不受電腦效能影響；分軌包含各自的殘響與延遲，方便帶到 Logic Pro 等軟體繼續混音。</p>
      </div>
    </Modal>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ui = useDaw((s) => s.ui);
  const metro = useDaw((s) => s.project.metronome);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const [midiMsg, setMidiMsg] = useState('');
  useEffect(() => {
    void listInputDevices().then(setDevices);
  }, [testing]);
  useEffect(() => {
    if (!testing) return;
    const t = setInterval(() => setLevel(engine.recorder?.isOpen ? engine.recorder.level() : 0), 80);
    return () => clearInterval(t);
  }, [testing]);
  const ctx = engine.ctx;
  return (
    <Modal title="設定" onClose={onClose}>
      <div className="form">
        <label className="field">
          <span>外觀</span>
          <select
            value={ui.theme}
            onChange={(e) => {
              const theme = e.target.value as typeof ui.theme;
              st().setUi({ theme });
              applyTheme(theme);
            }}
          >
            <option value="auto">跟隨系統</option>
            <option value="dark">深色（錄音室）</option>
            <option value="light">淺色</option>
          </select>
        </label>
        <h3>錄音</h3>
        <label className="field">
          <span>輸入裝置</span>
          <select value={ui.inputDeviceId} onChange={(e) => st().setUi({ inputDeviceId: e.target.value })}>
            <option value="">系統預設</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `輸入 ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                engine.ensure();
                await engine.recorder!.open(ui.inputDeviceId || undefined);
                setTesting(true);
              } catch (err) {
                st().toast(`無法使用麥克風：${(err as Error).message}（在 claude.ai 預覽裡無法錄音，請在本機執行 miniDaw）`, 'error');
              }
            }}
          >
            <Icon name="mic" size={16} /> 測試輸入
          </button>
          {testing && (
            <div className="level" aria-label="輸入音量">
              <div style={{ width: `${Math.min(100, level * 140)}%` }} className={level > 0.9 ? 'hot' : ''} />
            </div>
          )}
        </div>
        <label className="field">
          <span>錄音延遲補償（{ui.recordOffsetMs} ms）</span>
          <input type="range" min={-100} max={200} value={ui.recordOffsetMs} onChange={(e) => st().setUi({ recordOffsetMs: Number(e.target.value) })} />
          <span className="muted small">如果錄下的聲音總是比伴奏晚一點，就往右調。系統回報的延遲已自動補償。</span>
        </label>
        <h3>節拍器</h3>
        <label className="field">
          <span>音量</span>
          <input type="range" min={0} max={1} step={0.05} value={metro.volume} onChange={(e) => setMetronome({ volume: Number(e.target.value) })} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>預備拍</span>
            <select value={metro.countIn ? metro.countInBars : 0} onChange={(e) => setMetronome(Number(e.target.value) ? { countIn: true, countInBars: Number(e.target.value) } : { countIn: false })}>
              <option value={0}>關閉</option>
              <option value={1}>1 小節</option>
              <option value={2}>2 小節</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={metro.onlyWhileRecording} onChange={(e) => setMetronome({ onlyWhileRecording: e.target.checked })} /> 只在錄音時響
          </label>
        </div>
        <h3>MIDI 鍵盤</h3>
        <div className="row">
          <button
            type="button"
            className={`btn ${ui.midiEnabled ? 'btn-on' : ''}`}
            onClick={async () => {
              if (ui.midiEnabled) {
                disableMidi();
                st().setUi({ midiEnabled: false });
                setMidiMsg('已停用');
                return;
              }
              try {
                const n = await enableMidi();
                st().setUi({ midiEnabled: true });
                setMidiMsg(n ? `已連接 ${n} 個 MIDI 裝置` : '已啟用，尚未偵測到 MIDI 裝置');
              } catch (err) {
                setMidiMsg((err as Error).message);
              }
            }}
          >
            {ui.midiEnabled ? '停用 MIDI 輸入' : '啟用 MIDI 輸入'}
          </button>
          <span className="muted small">{midiMsg}</span>
        </div>
        <p className="muted small num">
          音訊引擎：{ctx ? `${ctx.sampleRate} Hz · 輸出延遲 ${Math.round(engine.outputLatency * 1000)} ms` : '尚未啟動（按播放或任一按鍵後啟動）'}
        </p>
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['空白鍵', '播放／停止'],
  ['R', '錄音'],
  ['Enter', '回到開頭'],
  [', / .', '倒退／快進一小節'],
  ['C', '循環開關'],
  ['K', '節拍器開關'],
  [`${MOD}Z / ${MOD}⇧Z`, '復原／重做'],
  ['Delete', '刪除選取的片段或音符'],
  [`${MOD}D`, '複製選取的片段或音符'],
  [`${MOD}B`, '在播放頭分割片段'],
  [`${MOD}A`, '全選'],
  ['Q', '量化'],
  ['M / S', '靜音／獨奏選取的音軌'],
  ['↑ ↓', '選擇上下音軌（編輯器內：移調）'],
  ['← →', '移動選取的音符'],
  ['1 / 2 / 3', '選取／畫筆／橡皮擦工具'],
  ['E / X', '編輯器／混音台'],
  ['Y / I / G', '音色庫／檢閱器／編曲教練'],
  [`${MOD}K`, '電腦鍵盤演奏（Musical Typing）'],
  [`${MOD}S`, '儲存專案檔'],
  [`${MOD}+滾輪`, '縮放時間軸'],
  ['?', '顯示這個說明'],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="鍵盤快捷鍵" onClose={onClose}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">開啟「鍵盤演奏」時，A W S E D F T G Y H U J K 等鍵會變成琴鍵（R 與空白鍵仍可使用）。</p>
    </Modal>
  );
}

function RenameDialog({ d, onClose }: { d: Extract<Dialog, { type: 'rename' }>; onClose: () => void }) {
  const [value, setValue] = useState(d.value);
  const title = { track: '重新命名音軌', region: '重新命名片段', marker: '重新命名段落', project: '專案名稱' }[d.target];
  const save = () => {
    if (d.target === 'track') renameTrack(d.id, value);
    else if (d.target === 'region') renameRegion(d.id, value);
    else if (d.target === 'marker') renameMarker(d.id, value);
    else setProjectName(value);
    onClose();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input id="rename-input" className="text-input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus onFocus={(e) => e.target.select()} aria-label="名稱" />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            儲存
          </button>
        </div>
      </form>
    </Modal>
  );
}

const LICENSE_NAMES: Record<string, { label: string; url: string }> = {
  'CC0-1.0': { label: 'CC0 1.0（公有領域）', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-3.0': { label: 'CC BY 3.0（需署名）', url: 'https://creativecommons.org/licenses/by/3.0/' },
  'CC-BY-4.0': { label: 'CC BY 4.0（需署名）', url: 'https://creativecommons.org/licenses/by/4.0/' },
  MIT: { label: 'MIT', url: 'https://opensource.org/license/mit' },
};

const MIT_NOTICE = `Copyright (c) 2000-2002, 2008 Frank Wen
Copyright (c) 2012 Benjamin Gleitzman (MIDI.js renders)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

function CreditsDialog({ onClose }: { onClose: () => void }) {
  const sets = Object.values(SAMPLE_SETS).sort((a, b) => (a.license === b.license ? 0 : a.license === 'CC0-1.0' ? 1 : -1));
  return (
    <Modal title="音色來源與授權" onClose={onClose} wide>
      <p>
        錄音音色來自以下開放授權的取樣音色庫，感謝這些作者的分享。為了在網頁上使用，取樣都經過修改：挑選音符與力度層、混合麥克風、轉成 44.1 kHz、裁掉起音前的靜音、較長的尾音加上淡出、整組音量標準化，並壓縮成 MP3。管風琴、合成器、合成貝斯與 808／909 鼓機則由 miniDaw 即時合成。
      </p>
      <ul className="credits">
        {sets.map((s) => {
          const lic = LICENSE_NAMES[s.license] ?? { label: s.license, url: s.source };
          return (
            <li key={s.name}>
              <strong>{s.name}</strong>
              <span className="muted"> — {s.author}</span>
              <div className="small">
                <a href={lic.url} target="_blank" rel="noreferrer">
                  {lic.label}
                </a>
                {' · '}
                <a href={s.source} target="_blank" rel="noreferrer">
                  來源
                </a>
                {s.notes ? <span className="muted"> · {s.notes}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <h3 className="credits-heading">編曲素材與參考</h3>
      <ul className="credits">
        <li>
          <strong>{GROOVES.source.split(' — ')[0]}</strong>
          <span className="muted"> — {GROOVES.source.split(' — ')[1]}</span>
          <div className="small">
            <a href={LICENSE_NAMES[GROOVES.license].url} target="_blank" rel="noreferrer">
              {LICENSE_NAMES[GROOVES.license].label}
            </a>
            {' · '}
            <a href={GROOVES.url} target="_blank" rel="noreferrer">
              來源
            </a>
            <span className="muted">
              {' '}
              · 編曲教練的鼓組律動與過門取自職業鼓手的演奏。修改：擷取兩小節律動與一小節過門、時間改以拍為單位並對齊節拍器、依鼓件調整力度、對應到 General MIDI 鼓件。
            </span>
          </div>
        </li>
        <li>
          <strong>Open Music Theory</strong>
          <span className="muted"> — Kris P. Shaffer, Bryn Hughes, Brian Moseley（Hybrid Pedagogy Publishing）</span>
          <div className="small">
            <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
              CC BY-SA 4.0
            </a>
            {' · '}
            <a href="https://openmusictheory.github.io" target="_blank" rel="noreferrer">
              來源
            </a>
            <span className="muted"> · 旋律產生器依其樂句結構、裝飾音與流行歌曲式章節的原則撰寫（未收錄其文字內容）。</span>
          </div>
        </li>
      </ul>
      <details className="small">
        <summary>FluidR3 GM SoundFont 的 MIT 授權全文</summary>
        <pre className="license-text">{MIT_NOTICE}</pre>
      </details>
    </Modal>
  );
}

function WelcomeDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="歡迎來到 miniDaw" onClose={onClose} className="welcome">
      <p>
        這是一個在瀏覽器裡運作的數位音樂工作站：可以錄音、用節拍器與預備拍、多軌編曲、混音，並內建鼓組、鋼琴、電鋼琴、電吉他、木吉他、貝斯等 32 種音色（多數是真實樂器的錄音取樣）。右邊的<strong>編曲教練</strong>會依照你選的曲風，一步一步帶你完成一首歌。
      </p>
      <p className="muted">目前載入的是一首「流行」示範編曲，按空白鍵就能播放。</p>
      <div className="welcome-actions">
        <button
          type="button"
          className="btn btn-primary btn-big"
          onClick={() => {
            onClose();
            void engine.play(0);
          }}
        >
          <Icon name="play" size={16} filled /> 播放示範
        </button>
        <button
          type="button"
          className="btn btn-big"
          onClick={() => {
            onClose();
            void cmd.newProject();
          }}
        >
          <Icon name="coach" size={16} /> 選一個曲風從頭做
        </button>
        <button
          type="button"
          className="btn btn-big"
          onClick={() => {
            onClose();
            void cmd.newProject();
          }}
        >
          空白專案
        </button>
      </div>
      <p className="muted small">提示：作品會自動存在這個瀏覽器裡；用「檔案 → 儲存專案檔」可以帶到別台電腦。</p>
    </Modal>
  );
}

export function DialogHost() {
  const dialog = useDaw((s) => s.ui.dialog);
  const close = () => st().setUi({ dialog: null });
  if (!dialog) return null;
  switch (dialog.type) {
    case 'newTrack':
      return <NewTrackDialog onClose={close} />;
    case 'export':
      return <ExportDialog onClose={close} />;
    case 'settings':
      return <SettingsDialog onClose={close} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    case 'rename':
      return <RenameDialog d={dialog} onClose={close} />;
    case 'welcome':
      return <WelcomeDialog onClose={close} />;
    case 'credits':
      return <CreditsDialog onClose={close} />;
    case 'fx': {
      if (dialog.trackId === 'master' || dialog.trackId === 'reverb' || dialog.trackId === 'delay' || !dialog.insertId) return null;
      const t = st().project.tracks.find((x) => x.id === dialog.trackId);
      const ins = t?.mixer.inserts.find((i) => i.id === dialog.insertId);
      return (
        <Modal title={`${ins ? FX_DEFS[ins.type].name : '效果器'} · ${t?.name ?? ''}`} onClose={close} className="fx-modal">
          <FxWindow trackId={dialog.trackId} insertId={dialog.insertId} />
        </Modal>
      );
    }
  }
}
