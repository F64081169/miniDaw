// Getting sound out of phones and tablets.
//
// - Browsers only let audio start from an activation gesture. For touch that is the finger
//   lifting (pointerup / touchend / click), not pointerdown, so we listen for exactly the
//   events that grant activation, and keep listening: the context can be suspended again.
// - iOS can leave a context 'interrupted' (a call, Siri, switching apps) instead of
//   'suspended'; anything but 'running' gets a resume().
// - iOS plays Web Audio in the "ambient" audio session, which the ringer switch mutes.
//   The Audio Session API (Safari 17+) can ask for "playback"; older versions switch to it
//   while an <audio> element is playing, so we loop a silent one.

import { encodeWav } from './wav';

type SessionNavigator = Navigator & { audioSession?: { type: string } };

export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

let sessionState: 'unknown' | 'pending' | 'playback' | 'failed' = 'unknown';
let silentAudio: HTMLAudioElement | null = null;

/** True when sound may still be muted by the iPhone / iPad ringer switch (the workaround failed). */
export function mayBeMutedByRingerSwitch(): boolean {
  return isAppleTouchDevice() && sessionState === 'failed';
}

function requestPlaybackSession(): void {
  const nav = navigator as SessionNavigator;
  if (nav.audioSession) {
    try {
      nav.audioSession.type = 'playback';
      sessionState = 'playback';
    } catch {
      sessionState = 'failed';
    }
    return;
  }
  if (!isAppleTouchDevice() || sessionState === 'pending' || sessionState === 'playback') return;
  if (!silentAudio) {
    // half a second of silence; a data: URL is the source most sandboxed pages may load
    const bytes = new Uint8Array(encodeWav([new Float32Array(4000)], 8000, 16));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    silentAudio = new Audio(`data:audio/wav;base64,${btoa(bin)}`);
    silentAudio.loop = true;
    silentAudio.setAttribute('playsinline', '');
    silentAudio.setAttribute('x-webkit-airplay', 'deny');
  }
  sessionState = 'pending';
  silentAudio.play().then(
    () => (sessionState = 'playback'),
    () => (sessionState = 'failed'), // try again on the next gesture
  );
}

function kick(ctx: AudioContext): void {
  if (ctx.state === 'running' || ctx.state === 'closed') return;
  void ctx.resume().catch(() => undefined);
  // older iOS only unlocks once a sound is started inside the gesture
  const src = ctx.createBufferSource();
  src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  src.connect(ctx.destination);
  src.start();
}

/** The events that give a page user activation (HTML spec), so audio may start in them. */
function grantsActivation(e: Event): boolean {
  if (e.type === 'pointerdown') return (e as PointerEvent).pointerType === 'mouse';
  if (e.type === 'pointerup') return (e as PointerEvent).pointerType !== 'mouse';
  if (e.type === 'keydown') return (e as KeyboardEvent).key !== 'Escape';
  return true; // touchend, click
}

/**
 * Keep the audio context unlocked: `ensure` creates (or returns) the context and is called
 * from inside gestures; `current` returns it without creating one.
 */
export function installAudioUnlock(ensure: () => AudioContext, current: () => AudioContext | null): void {
  // ask for the playback session before any sound starts
  if ((navigator as SessionNavigator).audioSession) requestPlaybackSession();
  const onGesture = (e: Event) => {
    if (!grantsActivation(e)) return;
    requestPlaybackSession();
    kick(ensure());
  };
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      silentAudio?.pause();
      if (sessionState === 'playback' && silentAudio) sessionState = 'unknown';
      return;
    }
    // coming back from another app: iOS may allow resuming without a new tap
    const ctx = current();
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
    if (silentAudio && sessionState !== 'playback') requestPlaybackSession();
  });
}
