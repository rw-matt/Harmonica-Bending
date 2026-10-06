// YIN pitch detection (de Cheveigné & Kawahara, 2002), tuned for harmonica.
// Returns { freq, clarity } or null when the signal is silent or unclear.

export function createDetector({ sampleRate, minFreq = 70, maxFreq = 4200, threshold = 0.12 }) {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.ceil(sampleRate / minFreq);
  let diff = new Float32Array(tauMax + 2);

  return function detect(buf, rmsGate = 0.01) {
    // Loudness gate
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < rmsGate) return null;

    const W = Math.min(buf.length - tauMax - 1, 2048);
    if (W < 256) return null;

    // Difference function
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const d = buf[j] - buf[j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    // Cumulative mean normalized difference + absolute threshold
    diff[0] = 1;
    let running = 0, tauEst = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau];
      diff[tau] = running === 0 ? 1 : diff[tau] * tau / running;
    }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (diff[tau] < threshold) {
        while (tau + 1 <= tauMax && diff[tau + 1] < diff[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) return null;

    // Parabolic interpolation for sub-sample accuracy
    const x0 = diff[tauEst - 1] ?? diff[tauEst];
    const x1 = diff[tauEst];
    const x2 = diff[tauEst + 1] ?? diff[tauEst];
    const denom = 2 * (2 * x1 - x2 - x0);
    const shift = denom !== 0 ? (x2 - x0) / denom : 0;
    const period = tauEst + shift;

    return { freq: sampleRate / period, clarity: 1 - x1, rms };
  };
}

/** Small median filter to steady the readout without adding much lag. */
export function createSmoother(size = 5) {
  const hist = [];
  return function push(v) {
    if (v == null) { hist.length = 0; return null; }
    hist.push(v);
    if (hist.length > size) hist.shift();
    const sorted = [...hist].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
}
