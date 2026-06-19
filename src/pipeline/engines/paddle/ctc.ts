// Greedy CTC decoding for the PP-OCR recognition head. Pure (no DOM / no ORT)
// so it can be unit-tested in Node. The recognizer emits, per time step, a
// probability over the character vocabulary; CTC collapses repeats and drops the
// blank class (index 0) to recover the string.

export interface CtcResult {
  text: string;
  /** Mean probability of the emitted (non-blank) characters, 0..1. */
  confidence: number;
}

/**
 * Decode a [timeSteps × numClasses] probability matrix (row-major) into text.
 * @param probs  flattened softmax output, length === timeSteps * numClasses
 * @param timeSteps number of sequence positions
 * @param numClasses size of the label vocabulary (incl. the blank at index 0)
 * @param labels  label strings; labels[0] is the CTC blank and is never emitted
 */
export function decodeCTC(
  probs: Float32Array | number[],
  timeSteps: number,
  numClasses: number,
  labels: string[],
): CtcResult {
  let text = "";
  let prev = -1; // last raw argmax (a blank between equal chars splits them)
  let confSum = 0;
  let confCount = 0;

  for (let t = 0; t < timeSteps; t++) {
    const off = t * numClasses;
    let best = 0;
    let bestP = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const p = probs[off + c] as number;
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    // Emit only when the class changed and is not the blank (index 0).
    if (best !== 0 && best !== prev) {
      text += labels[best] ?? "";
      confSum += bestP;
      confCount++;
    }
    prev = best;
  }

  return { text, confidence: confCount ? confSum / confCount : 0 };
}
