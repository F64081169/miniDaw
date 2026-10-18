// Offline / installable app support for the multi-file build: registers the service worker
// that precaches every file of the build, reports when the app is ready to run without a
// network or when an update is waiting, and offers "add to home screen".

import { isAppleTouchDevice } from '../audio/unlock';
import { useDaw } from '../state/store';

/** Only the hosted multi-file build can work offline (the single-file build needs no server). */
export const OFFLINE_BUILD = import.meta.env.PROD && import.meta.env.MODE !== 'single';

type InstallPromptEvent = Event & { prompt(): Promise<void> };
let installPrompt: InstallPromptEvent | null = null;

export function registerOffline(): void {
  if (!OFFLINE_BUILD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('beforeinstallprompt', (e) => (installPrompt = e as InstallPromptEvent));
  const register = () => {
    const firstInstall = !navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state !== 'installed') return;
            const toast = useDaw.getState().toast;
            if (firstInstall) toast('已可離線使用：之後沒有網路也能開啟 miniDaw', 'success');
            else toast('miniDaw 有新版本，關掉再重新開啟就會更新');
          });
        });
      })
      .catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

export function isInstalledApp(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Install as an app (browser prompt where available, otherwise how to do it by hand). */
export async function installApp(): Promise<void> {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt.prompt();
    return;
  }
  useDaw
    .getState()
    .toast(
      isAppleTouchDevice()
        ? '在 Safari 點「分享」按鈕 →「加入主畫面」，就能像 App 一樣離線使用'
        : '在瀏覽器選單選「安裝 miniDaw」或「加到主畫面」，就能像 App 一樣離線使用',
    );
}
