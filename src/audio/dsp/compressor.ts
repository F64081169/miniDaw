// Web Audio's DynamicsCompressorNode silently applies an automatic makeup gain of
// (1 / curve(1.0))^0.6 (Web Audio spec, "makeup gain"). At typical settings that is
// +6 … +15 dB, so a compressor would act as a volume knob. This reproduces the static
// curve exactly as browsers implement it so callers can divide the makeup back out.

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (x: number) => 20 * Math.log10(x);

function curve(thresholdDb: number, kneeDb: number, ratio: number) {
  const linThreshold = dbToLin(thresholdDb);
  const kneeCurve = (x: number, k: number) => (x < linThreshold ? x : linThreshold + (1 - Math.exp(-k * (x - linThreshold))) / k);
  const slopeAt = (x: number, k: number) => {
    if (x < linThreshold) return 1;
    const x2 = x * 1.001;
    return (linToDb(kneeCurve(x2, k)) - linToDb(kneeCurve(x, k))) / (linToDb(x2) - linToDb(x));
  };
  // find k so the knee meets the ratio slope where the knee ends
  const kneeEnd = dbToLin(thresholdDb + kneeDb);
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEnd, k) < 1 / ratio) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const yKneeDb = linToDb(kneeCurve(kneeEnd, k));
  return (x: number) => (x < kneeEnd ? kneeCurve(x, k) : dbToLin(yKneeDb + (linToDb(x) - (thresholdDb + kneeDb)) / ratio));
}

/** The gain a DynamicsCompressorNode adds on its own for these settings (linear). */
export function autoMakeup(thresholdDb: number, kneeDb: number, ratio: number): number {
  return Math.pow(1 / curve(thresholdDb, kneeDb, Math.max(1, ratio))(1), 0.6);
}
