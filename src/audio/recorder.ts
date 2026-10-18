// Microphone / line-in capture with sample-accurate start time (AudioWorklet, ScriptProcessor fallback).

const WORKLET_SRC = `
class MiniDawRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.chunks = [];
    this.size = 0;
    this.first = -1;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.active = true; this.first = -1; this.chunks = []; this.size = 0; }
      else if (e.data === 'stop') { this.flush(); this.active = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.chunks.length) return;
    const chs = this.chunks[0].length;
    const out = [];
    for (let c = 0; c < chs; c++) {
      const a = new Float32Array(this.size);
      let o = 0;
      for (const k of this.chunks) { a.set(k[c] || k[0], o); o += k[0].length; }
      out.push(a);
    }
    this.port.postMessage({ first: this.first, data: out }, out.map((a) => a.buffer));
    this.chunks = [];
    this.size = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.active && inp && inp.length && inp[0].length) {
      if (this.first < 0) this.first = currentFrame;
      this.chunks.push(inp.map((c) => c.slice(0)));
      this.size += inp[0].length;
      if (this.size >= 16384) this.flush();
    }
    return true;
  }
}
registerProcessor('minidaw-recorder', MiniDawRecorder);
`;

export interface Take {
  channels: Float32Array[];
  sampleRate: number;
  startTime: number; // context time of the first captured sample
}

export class AudioRecorder {
  private ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode;
  private chunks: Float32Array[][] = [];
  private firstFrame = -1;
  private firstTime = -1;
  private capturing = false;
  private stopResolve: (() => void) | null = null;
  private levelBuf = new Float32Array(1024);
  private monitorDest: AudioNode | null = null;
  deviceLabel = '';

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
  }

  get isOpen(): boolean {
    return !!this.source;
  }

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async open(deviceId?: string): Promise<void> {
    if (this.source && (!deviceId || this.stream?.getAudioTracks()[0]?.getSettings().deviceId === deviceId)) return;
    this.close();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.stream = stream;
    this.deviceLabel = stream.getAudioTracks()[0]?.label ?? '';
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    await this.createCaptureNode();
    if (this.monitorDest) this.source.connect(this.monitorDest);
  }

  private async createCaptureNode(): Promise<void> {
    if (!this.source) return;
    try {
      if (!this.ctx.audioWorklet) throw new Error('no worklet');
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(this.ctx, 'minidaw-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max' });
      node.port.onmessage = (e: MessageEvent<{ first?: number; data?: Float32Array[]; done?: boolean }>) => {
        if (e.data.data) {
          if (this.firstFrame < 0 && e.data.first !== undefined) this.firstFrame = e.data.first;
          this.chunks.push(e.data.data);
        }
        if (e.data.done) this.stopResolve?.();
      };
      this.node = node;
    } catch {
      // ScriptProcessor fallback (older browsers): timing is approximate
      const sp = this.ctx.createScriptProcessor(4096, 2, 2);
      sp.onaudioprocess = (e) => {
        if (!this.capturing) return;
        const ib = e.inputBuffer;
        if (this.firstTime < 0) this.firstTime = this.ctx.currentTime - ib.duration;
        const chans: Float32Array[] = [];
        for (let c = 0; c < ib.numberOfChannels; c++) chans.push(ib.getChannelData(c).slice(0));
        this.chunks.push(chans);
      };
      this.node = sp;
    }
    this.source.connect(this.node);
    this.node.connect(this.sink);
  }

  /** Route the live input into a channel strip (input monitoring). */
  setMonitor(dest: AudioNode | null): void {
    if (this.monitorDest && this.source) {
      try {
        this.source.disconnect(this.monitorDest);
      } catch {
        /* not connected */
      }
    }
    this.monitorDest = dest;
    if (dest && this.source) this.source.connect(dest);
  }

  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let p = 0;
    for (let i = 0; i < this.levelBuf.length; i++) p = Math.max(p, Math.abs(this.levelBuf[i]));
    return p;
  }

  start(): void {
    this.chunks = [];
    this.firstFrame = -1;
    this.firstTime = -1;
    this.capturing = true;
    if (this.node instanceof AudioWorkletNode) this.node.port.postMessage('start');
  }

  async stop(): Promise<Take | null> {
    if (!this.capturing) return null;
    this.capturing = false;
    if (this.node instanceof AudioWorkletNode) {
      const done = new Promise<void>((r) => (this.stopResolve = r));
      this.node.port.postMessage('stop');
      await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
      this.stopResolve = null;
    }
    if (this.chunks.length === 0) return null;
    const chs = Math.max(...this.chunks.map((c) => c.length));
    const total = this.chunks.reduce((a, c) => a + c[0].length, 0);
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < chs; ch++) {
      const out = new Float32Array(total);
      let o = 0;
      for (const c of this.chunks) {
        out.set(c[ch] ?? c[0], o);
        o += c[0].length;
      }
      channels.push(out);
    }
    this.chunks = [];
    const startTime = this.firstFrame >= 0 ? this.firstFrame / this.ctx.sampleRate : Math.max(0, this.firstTime);
    return { channels: collapseMono(channels), sampleRate: this.ctx.sampleRate, startTime };
  }

  /** Input path latency reported by the browser (seconds). */
  inputLatency(): number {
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    return typeof settings?.latency === 'number' ? settings.latency : 0;
  }

  close(): void {
    this.capturing = false;
    this.source?.disconnect();
    this.node?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.node = null;
    this.analyser = null;
  }
}

/** Most microphones arrive as two identical channels; keep one to halve memory. */
function collapseMono(chans: Float32Array[]): Float32Array[] {
  if (chans.length !== 2) return chans;
  const [l, r] = chans;
  let diff = 0;
  let energy = 0;
  const step = Math.max(1, Math.floor(l.length / 20000));
  for (let i = 0; i < l.length; i += step) {
    diff += Math.abs(l[i] - r[i]);
    energy += Math.abs(l[i]);
  }
  return diff < energy * 0.02 ? [l] : chans;
}

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}
