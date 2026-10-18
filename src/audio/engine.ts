// Real-time audio engine: owns the AudioContext, keeps the mixer graph in sync with the store,
// runs the transport, metronome, live input (musical typing / MIDI) and recording.

import { beatsPerBar, floorToGrid } from '../core/time';
import type { Note, Project, Track } from '../core/types';
import { clamp, debounce, uid } from '../core/util';
import { createAudioRegion, createMidiRegion } from '../state/project';
import { getProject, useDaw } from '../state/store';
import { audioPool } from './audioPool';
import { renderClick } from './dsp/misc';
import type { RenderJob } from './dsp/render';
import { createInstrument, rangeNotes, type Instrument, type VoiceHandle } from './instruments/instrument';
import { defaultParams, getPatch } from './instruments/patches';
import { MixGraph } from './mixer';
import { AudioRecorder } from './recorder';
import { renderService } from './renderService';
import { Transport } from './scheduler';
import { mayBeMutedByRingerSwitch } from './unlock';

interface RecNote {
  trackId: string;
  pitch: number;
  vel: number;
  start: number;
  end: number | null;
}

interface RecSession {
  audioTrackId: string | null;
  midiTrackIds: string[];
  startBeat: number;
  startTime: number;
  loop: { start: number; end: number } | null;
}

type AudioSaver = (id: string, buffer: AudioBuffer) => void;

class Engine {
  ctx: AudioContext | null = null;
  graph: MixGraph | null = null;
  transport: Transport | null = null;
  recorder: AudioRecorder | null = null;
  private clicks: [AudioBuffer, AudioBuffer] | null = null;
  private metroGain: GainNode | null = null;
  private live = new Map<string, VoiceHandle>();
  private held = new Map<string, VoiceHandle>(); // released keys held by the sustain pedal
  private sustain = new Set<string>(); // trackIds with pedal down
  private rec: RecSession | null = null;
  private recNotes: RecNote[] = [];
  private audioSaver: AudioSaver | null = null;
  private monitorTrack: string | null = null;
  private previewInst: Instrument | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  /** Create (or resume) the AudioContext. Must first be called from a user gesture. */
  ensure(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.graph = new MixGraph(ctx, { meters: true });
      this.graph.sync(getProject(), true);
      this.metroGain = ctx.createGain();
      this.metroGain.gain.value = getProject().metronome.volume;
      this.metroGain.connect(ctx.destination);
      this.clicks = [true, false].map((accent) => {
        const data = renderClick(ctx.sampleRate, accent);
        const b = new AudioBuffer({ length: data.length, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
        b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
        return b;
      }) as [AudioBuffer, AudioBuffer];
      this.transport = new Transport({
        ctx,
        project: getProject,
        graph: () => this.graph!,
        getAudio: (id) => audioPool.get(id),
        click: (time, accent) => this.click(time, accent),
        clicksWanted: (recording, countingIn) => {
          const m = getProject().metronome;
          if (countingIn) return true;
          return m.enabled && (!m.onlyWhileRecording || recording);
        },
      });
      this.recorder = new AudioRecorder(ctx);
      useDaw.subscribe((s, prev) => {
        if (s.project !== prev.project) this.onProject(s.project, prev.project);
      });
      this.prefetchProject();
    }
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  /** The AudioContext if it exists (never creates one). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  private ringerTipShown = false;

  /**
   * Make sure the context is running before scheduling sound. Must start inside the user
   * gesture; never waits forever (iOS can leave resume() pending when it refuses).
   */
  private async wake(ctx: AudioContext): Promise<boolean> {
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    }
    const st = useDaw.getState();
    if (ctx.state !== 'running') {
      st.toast('瀏覽器暫停了聲音，請再點一次播放鍵', 'error');
      return false;
    }
    if (!this.ringerTipShown && mayBeMutedByRingerSwitch()) {
      this.ringerTipShown = true;
      st.toast('沒有聲音嗎？請關閉 iPhone／iPad 側邊的靜音開關，並調高音量');
    }
    return true;
  }

  setAudioSaver(fn: AudioSaver): void {
    this.audioSaver = fn;
  }

  private onProject(p: Project, prev: Project): void {
    this.graph?.sync(p);
    if (this.metroGain) this.metroGain.gain.value = p.metronome.volume;
    this.updateMonitoring(p);
    if (p.tracks !== prev.tracks) this.prefetchSoon();
  }

  private click(time: number, accent: boolean): void {
    if (!this.ctx || !this.clicks || !this.metroGain) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.clicks[accent ? 0 : 1];
    src.connect(this.metroGain);
    src.start(time);
    src.onended = () => src.disconnect();
  }

  get outputLatency(): number {
    const c = this.ctx;
    if (!c) return 0;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  /** The beat you are hearing right now (compensates output latency). */
  currentBeat(): number {
    const s = useDaw.getState().transport;
    if (!this.ctx || !this.transport || !this.transport.playing) return s.position;
    return this.transport.beatAt(this.ctx.currentTime - this.outputLatency);
  }

  /** Beats left in the count-in (0 when not counting in). */
  countInLeft(): number {
    if (!this.transport?.playing || !this.ctx) return 0;
    const end = this.transport.countInEnd;
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, end - this.currentBeat());
  }

  // ---------------------------------------------------------------- sample preparation

  private jobsForRange(p: Project, from: number, to: number): RenderJob[] {
    if (!this.graph) return [];
    const jobs: RenderJob[] = [];
    for (const t of p.tracks) {
      const inst = this.graph.instrument(t.id);
      if (!inst) continue;
      const notes: Note[] = [];
      for (const r of t.regions) {
        if (r.kind !== 'midi') continue;
        for (const n of r.notes) {
          const b = r.start + n.start;
          if (b + n.duration >= from && b < to) notes.push(n);
        }
      }
      jobs.push(...inst.jobsFor(notes));
    }
    return jobs;
  }

  private prefetchProject(): void {
    const p = getProject();
    renderService.prefetch(this.jobsForRange(p, -Infinity, Infinity));
    const sel = useDaw.getState().ui.selectedTrackId;
    if (sel) this.prefetchTrackRange(sel);
  }

  private prefetchSoon = debounce(() => this.prefetchProject(), 400);

  /** Warm up the playable range of a track (for musical typing / MIDI keyboards). */
  prefetchTrackRange(trackId: string): void {
    const inst = this.graph?.instrument(trackId);
    if (!inst) return;
    const range: number[] = [];
    const [lo, hi] = inst.patch.range;
    for (let p = Math.max(lo, 36); p <= Math.min(hi, 84); p++) range.push(p);
    renderService.prefetch(inst.jobsFor(rangeNotes(range)));
  }

  private async prepare(from: number, to: number): Promise<void> {
    const jobs = this.jobsForRange(getProject(), from, to).filter((j) => !renderService.get(j));
    if (jobs.length === 0) return;
    const slow = setTimeout(() => useDaw.getState().setTransport({ preparing: true }), 150);
    await Promise.race([renderService.ensureAll(jobs), new Promise((r) => setTimeout(r, 4000))]);
    clearTimeout(slow);
    useDaw.getState().setTransport({ preparing: false });
  }

  // ---------------------------------------------------------------- transport

  async play(from?: number): Promise<void> {
    const ctx = this.ensure();
    if (this.transport?.playing) return;
    if (!(await this.wake(ctx))) return;
    const start = Math.max(0, from ?? useDaw.getState().transport.position);
    const bar = beatsPerBar(getProject().timeSig);
    await this.prepare(start, start + bar * 8);
    this.transport!.start(start);
    useDaw.getState().setTransport({ playing: true, recording: false, countingIn: false });
    // keep preparing the rest of the song in the background
    renderService.prefetch(this.jobsForRange(getProject(), start, Infinity));
  }

  async stop(): Promise<void> {
    if (!this.transport) return;
    const st = useDaw.getState();
    if (!this.transport.playing) {
      // second stop: back to the start (or the cycle start)
      const p = getProject();
      st.setTransport({ position: p.loop.enabled ? p.loop.start : 0 });
      return;
    }
    const beat = this.currentBeat();
    const rec = this.rec;
    this.transport.stop();
    this.releaseAllLive();
    if (rec) await this.finishRecording(beat);
    this.rec = null;
    const pos = rec ? Math.max(rec.startBeat, beat) : Math.max(0, beat);
    st.setTransport({ playing: false, recording: false, countingIn: false, position: pos });
  }

  async togglePlay(): Promise<void> {
    if (this.transport?.playing) await this.stop();
    else await this.play();
  }

  seek(beat: number): void {
    const b = Math.max(0, beat);
    const st = useDaw.getState();
    if (this.transport?.playing && !this.rec) {
      this.transport.stop();
      st.setTransport({ position: b });
      this.transport.start(b);
      return;
    }
    st.setTransport({ position: b });
  }

  // ---------------------------------------------------------------- recording

  async record(): Promise<void> {
    const ctx = this.ensure();
    if (!(await this.wake(ctx))) return;
    const st = useDaw.getState();
    if (this.rec) {
      await this.stop();
      return;
    }
    let from = st.transport.position;
    if (this.transport?.playing) {
      from = Math.max(0, this.currentBeat());
      this.transport.stop();
    }
    const p = getProject();
    let audioTrack = p.tracks.find((t) => t.kind === 'audio' && t.armed) ?? null;
    let midiTracks = p.tracks.filter((t) => t.kind === 'instrument' && t.armed);
    if (!audioTrack && midiTracks.length === 0) {
      const sel = p.tracks.find((t) => t.id === st.ui.selectedTrackId);
      if (!sel) {
        st.toast('請先選擇一條音軌，或按下音軌上的錄音鍵 (R)', 'error');
        return;
      }
      st.update('啟用錄音', (d) => {
        const t = d.tracks.find((x) => x.id === sel.id);
        if (t) t.armed = true;
      }, { undoable: false });
      if (sel.kind === 'audio') audioTrack = sel;
      else midiTracks = [sel];
    }
    if (audioTrack) {
      if (!AudioRecorder.supported()) {
        st.toast('這個瀏覽器不支援麥克風錄音', 'error');
        return;
      }
      try {
        await this.recorder!.open(st.ui.inputDeviceId || undefined);
      } catch (err) {
        st.toast(`無法使用麥克風：${(err as Error).message || '權限被拒絕'}`, 'error');
        return;
      }
    }
    const bar = beatsPerBar(p.timeSig);
    const countInBeats = p.metronome.countIn ? p.metronome.countInBars * bar : 0;
    await this.prepare(from, from + bar * 8);
    this.recNotes = [];
    if (audioTrack) this.recorder!.start();
    const startTime = this.transport!.start(from, { countInBeats, recording: true, noLoop: !!audioTrack });
    this.rec = {
      audioTrackId: audioTrack?.id ?? null,
      midiTrackIds: midiTracks.map((t) => t.id),
      startBeat: from,
      startTime,
      loop: !audioTrack && p.loop.enabled ? { start: p.loop.start, end: p.loop.end } : null,
    };
    st.setTransport({ playing: true, recording: true, countingIn: countInBeats > 0 });
    if (countInBeats > 0) {
      setTimeout(() => {
        if (this.rec) useDaw.getState().setTransport({ countingIn: false });
      }, Math.max(0, (startTime - ctx.currentTime) * 1000));
    }
    if (!this.levelTimer) {
      this.levelTimer = setInterval(() => {
        const lvl = this.recorder?.isOpen ? this.recorder.level() : 0;
        useDaw.getState().setTransport({ inputLevel: lvl });
      }, 120);
    }
  }

  private async finishRecording(endBeat: number): Promise<void> {
    const rec = this.rec;
    if (!rec || !this.ctx) return;
    const st = useDaw.getState();
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    const p = getProject();
    // ---- audio
    if (rec.audioTrackId && this.recorder) {
      const take = await this.recorder.stop();
      const track = p.tracks.find((t) => t.id === rec.audioTrackId);
      if (take && track) {
        const comp = this.outputLatency + this.recorder.inputLatency() + st.ui.recordOffsetMs / 1000;
        const startIdx = Math.round((rec.startTime + comp - take.startTime) * take.sampleRate);
        const chans = take.channels.map((c) => c.subarray(Math.max(0, startIdx)));
        const len = chans[0]?.length ?? 0;
        if (len > take.sampleRate * 0.05) {
          const buf = new AudioBuffer({ length: len, sampleRate: take.sampleRate, numberOfChannels: chans.length });
          chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
          const id = audioPool.add(buf, uid('a'));
          this.audioSaver?.(id, buf);
          const n = track.regions.length + 1;
          const region = createAudioRegion(rec.startBeat, id, buf.duration, `${track.name} #${n}`);
          st.update('錄音', (d) => {
            d.tracks.find((t) => t.id === track.id)?.regions.push(region);
          });
          st.setUi({ selectedRegionIds: [region.id], selectedTrackId: track.id });
        } else st.toast('錄音太短，已略過');
      }
    }
    // ---- MIDI
    if (rec.midiTrackIds.length) {
      const end = endBeat;
      const bar = beatsPerBar(p.timeSig);
      for (const trackId of rec.midiTrackIds) {
        const notes = this.recNotes.filter((n) => n.trackId === trackId);
        if (!notes.length) continue;
        for (const n of notes) if (n.end === null) n.end = Math.max(n.start + 0.05, rec.loop ? rec.loop.end : end);
        let rs: number;
        let re: number;
        if (rec.loop) {
          rs = rec.loop.start;
          re = rec.loop.end;
        } else {
          rs = floorToGrid(Math.min(...notes.map((n) => n.start)), bar);
          re = Math.ceil((Math.max(...notes.map((n) => n.end!)) - 1e-6) / bar) * bar;
          rs = Math.min(rs, floorToGrid(rec.startBeat, bar));
        }
        const region = createMidiRegion(
          rs,
          Math.max(bar, re - rs),
          notes.map((n) => ({ pitch: n.pitch, velocity: n.vel, start: n.start - rs, duration: Math.max(0.03, n.end! - n.start) })),
          '錄音片段',
        );
        st.update('錄製 MIDI', (d) => {
          d.tracks.find((t) => t.id === trackId)?.regions.push(region);
        });
        st.setUi({ selectedRegionIds: [region.id], editorRegionId: region.id });
      }
    }
    this.recNotes = [];
  }

  // ---------------------------------------------------------------- live input

  private recordingTrack(trackId: string): boolean {
    return !!this.rec && this.rec.midiTrackIds.includes(trackId);
  }

  noteOn(trackId: string, pitch: number, velocity: number): void {
    const ctx = this.ensure();
    const inst = this.graph?.instrument(trackId);
    if (!inst) return;
    const key = `${trackId}:${pitch}`;
    this.live.get(key)?.release(ctx.currentTime);
    this.held.get(key)?.release(ctx.currentTime);
    this.held.delete(key);
    const h = inst.noteOn(pitch, clamp(velocity, 1, 127), ctx.currentTime);
    if (h) this.live.set(key, h);
    if (this.recordingTrack(trackId) && this.rec) {
      let b = this.currentBeat();
      if (b < this.rec.startBeat) {
        if (b < this.rec.startBeat - 0.5) return; // too early in the count-in
        b = this.rec.startBeat;
      }
      this.recNotes.push({ trackId, pitch, vel: velocity, start: b, end: null });
    }
  }

  noteOff(trackId: string, pitch: number): void {
    if (!this.ctx) return;
    const key = `${trackId}:${pitch}`;
    const h = this.live.get(key);
    this.live.delete(key);
    if (h) {
      if (this.sustain.has(trackId)) this.held.set(key, h);
      else h.release(this.ctx.currentTime);
    }
    if (this.recordingTrack(trackId)) {
      const open = [...this.recNotes].reverse().find((n) => n.trackId === trackId && n.pitch === pitch && n.end === null);
      if (open) {
        let e = this.currentBeat();
        if (this.rec?.loop && e < open.start) e = this.rec.loop.end; // wrapped around the cycle
        open.end = Math.max(open.start + 0.03, e);
      }
    }
  }

  setSustain(trackId: string, down: boolean): void {
    if (down) this.sustain.add(trackId);
    else {
      this.sustain.delete(trackId);
      const t = this.ctx?.currentTime ?? 0;
      for (const [key, h] of this.held) {
        if (key.startsWith(trackId + ':')) {
          h.release(t);
          this.held.delete(key);
        }
      }
    }
  }

  releaseAllLive(): void {
    const t = this.ctx?.currentTime ?? 0;
    this.live.forEach((h) => h.release(t));
    this.held.forEach((h) => h.release(t));
    this.live.clear();
    this.held.clear();
  }

  /** Short audition of a note on a track (piano roll clicks, step sequencer). */
  previewNote(trackId: string, pitch: number, velocity = 100, seconds = 0.35): void {
    const ctx = this.ensure();
    this.graph?.instrument(trackId)?.play(pitch, velocity, ctx.currentTime + 0.005, seconds);
  }

  /** Library audition: plays a short phrase with a patch without touching the project. */
  async auditionPatch(patchId: string, phrase: { pitch: number; start: number; dur: number; vel: number }[], bpm = 100): Promise<void> {
    const ctx = this.ensure();
    if (!(await this.wake(ctx))) return;
    this.stopAudition();
    const patch = getPatch(patchId);
    const inst = createInstrument(ctx, patch, defaultParams(patch));
    inst.output.connect(this.graph!.master.input);
    this.previewInst = inst;
    await Promise.race([renderService.ensureAll(inst.jobsFor(phrase.map((n) => ({ pitch: n.pitch, velocity: n.vel })))), new Promise((r) => setTimeout(r, 3000))]);
    if (this.previewInst !== inst) return;
    const spb = 60 / bpm;
    const t0 = ctx.currentTime + 0.05;
    let end = 0;
    for (const n of phrase) {
      inst.play(n.pitch, n.vel, t0 + n.start * spb, n.dur * spb);
      end = Math.max(end, (n.start + n.dur) * spb);
    }
    this.previewTimer = setTimeout(() => this.stopAudition(), (end + 2.5) * 1000);
  }

  stopAudition(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    const inst = this.previewInst;
    this.previewInst = null;
    if (inst) {
      inst.allNotesOff();
      setTimeout(() => {
        inst.output.disconnect();
        inst.dispose();
      }, 250);
    }
  }

  // ---------------------------------------------------------------- monitoring & meters

  private updateMonitoring(p: Project): void {
    const t: Track | undefined = p.tracks.find((x) => x.kind === 'audio' && x.monitor);
    const id = t?.id ?? null;
    if (id === this.monitorTrack) return;
    this.monitorTrack = id;
    if (!this.recorder || !this.graph) return;
    if (!id) {
      this.recorder.setMonitor(null);
      return;
    }
    const strip = this.graph.strip(id);
    void this.recorder
      .open(useDaw.getState().ui.inputDeviceId || undefined)
      .then(() => this.recorder!.setMonitor(strip?.input ?? null))
      .catch((err: Error) => useDaw.getState().toast(`無法開啟輸入監聽：${err.message}`, 'error'));
  }

  readMeter(id: string): { l: number; r: number; holdL: number; holdR: number } | null {
    if (!this.graph) return null;
    if (id === 'master') return this.graph.master.meter?.read() ?? null;
    return this.graph.strip(id)?.meter?.read() ?? null;
  }

  insertReduction(trackId: string, insertId: string): number {
    const fx = this.graph?.strip(trackId)?.insert(insertId) as { reduction?: number } | undefined;
    return fx?.reduction ?? 0;
  }
}

export const engine = new Engine();
