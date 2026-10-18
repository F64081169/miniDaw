import { createRoot } from 'react-dom/client';
import { engine } from './audio/engine';
import { installAudioUnlock } from './audio/unlock';
import { initAutosave, restoreAutosave, saveAudio } from './state/persistence';
import { savePrefs, useDaw } from './state/store';
import { App } from './ui/App';
import { loadDemo } from './ui/commands';
import { applyTheme } from './ui/theme';
import { addAudioTrack, setLoop, toggleArm } from './state/actions';
import { renderService } from './audio/renderService';
import './ui/styles.css';

// Small handle for automated smoke tests and debugging from the console.
(window as unknown as { __minidaw: unknown }).__minidaw = {
  masterPeak: () => {
    const m = engine.readMeter('master');
    return m ? Math.max(m.l, m.r) : 0;
  },
  addAudioTrackAndArm: () => {
    const id = addAudioTrack('測試錄音');
    toggleArm(id);
    useDaw.getState().setUi({ selectedTrackId: id });
  },
  setLoop: (a: number, b: number) => setLoop(a, b),
  openExport: () => useDaw.getState().setUi({ dialog: { type: 'export' } }),
  state: () => useDaw.getState(),
  renderStats: () => ({ pending: renderService.pendingCount(), megabytes: Math.round(renderService.cachedBytes / 1048576) }),
  audioState: () => engine.context?.state ?? 'none',
  /** Mix-balance analysis tools (development aid, loaded on demand). */
  debug: () => import('./debug/analyze'),
};

async function boot(): Promise<void> {
  const st = useDaw.getState();
  applyTheme(st.ui.theme);
  engine.setAudioSaver((id, buf) => void saveAudio(id, buf));

  const restored = await restoreAutosave().catch(() => false);
  if (restored) {
    st.toast('已還原上次的專案', 'success');
  } else {
    // first visit: open on a playable example instead of an empty screen
    await loadDemo('pop');
    useDaw.getState().setUi({ dialog: { type: 'welcome' } });
  }
  initAutosave();
  useDaw.subscribe((s, prev) => {
    if (s.ui !== prev.ui) savePrefs(s.ui);
  });

  createRoot(document.getElementById('root')!).render(<App />);

  // Start the audio engine early (suspended until the first click/key) so instrument
  // sounds are already synthesised in the background when the user presses play.
  setTimeout(() => engine.ensure(), 400);
  // phones and tablets only allow sound to start from certain gestures; keep it unlocked
  installAudioUnlock(
    () => engine.ensure(),
    () => engine.context,
  );
}

void boot();
