// Web Worker: renders instrument zones / drum pieces off the main thread.
import { runJob, type RenderJob } from './dsp/render';

interface WorkerScope {
  onmessage: ((e: MessageEvent<{ id: number; job: RenderJob }>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const { id, job } = e.data;
  try {
    const data = runJob(job);
    scope.postMessage({ id, data }, [data.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
