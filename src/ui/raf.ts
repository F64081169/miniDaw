// One shared requestAnimationFrame loop for playheads, meters and the LCD (no React re-renders).

type FrameFn = (now: number) => void;

const subs = new Set<FrameFn>();
let running = false;

function loop(now: number): void {
  for (const fn of subs) fn(now);
  if (subs.size) requestAnimationFrame(loop);
  else running = false;
}

export function onFrame(fn: FrameFn): () => void {
  subs.add(fn);
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
  return () => {
    subs.delete(fn);
  };
}
