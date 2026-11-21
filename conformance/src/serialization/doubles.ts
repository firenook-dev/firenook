import assert from "node:assert/strict";

// The double round-trip corpus: doubles a client writes as JSON numbers and
// reads back. Clients write a double in its shortest decimal form (the web
// SDK's `JSON.stringify`); read correctly rounded, that form names the same
// double, so every read must return the bits that were written.

export const doublesProject = "demo-firenook-double-round-trip";
export const doublesPerDocument = 250;
export const doubleWrites = ["rest-patch", "browser-set"] as const;
export const doubleReads = ["rest-get", "grpc-get", "browser-get"] as const;

export interface DoubleObservation {
  readonly write: typeof doubleWrites[number];
  readonly read: typeof doubleReads[number];
  readonly document: string;
  /** Each value read back, as its IEEE 754 bits in 16 hex digits. */
  readonly bits: readonly string[];
}

export interface DoubleCapture {
  /** Each value written, in order: its bits and the JSON a client sends. */
  readonly values: readonly { readonly bits: string; readonly json: string }[];
  readonly documents: number;
  readonly observations: readonly DoubleObservation[];
}

const RANDOM = 500;
const COMPUTED = 250;

/**
 * The values, the same on every run: one a client was seen to read back a
 * unit in the last place lower, boundaries, random finite bit patterns
 * (SplitMix64) and computed decimals of the kind a layout produces. Safe
 * integers are left out: the web SDK writes those as `integerValue`.
 */
export function doubleValues(): number[] {
  const values = [
    -6.394884621840902e-14, 0.1, 1 / 3, 5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, -Number.MAX_VALUE,
    1e21, 1e-7, 2 ** 63, 2 ** 64, 123456789012345680000,
  ];
  const mask = (1n << 64n) - 1n;
  const view = new DataView(new ArrayBuffer(8));
  let state = 0x5eedf10a70000001n;
  let random = 0;
  while (random < RANDOM) {
    state = (state + 0x9e3779b97f4a7c15n) & mask;
    let bits = state;
    bits = ((bits ^ (bits >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    bits = ((bits ^ (bits >> 27n)) * 0x94d049bb133111ebn) & mask;
    bits ^= bits >> 31n;
    view.setBigUint64(0, bits);
    const value = view.getFloat64(0);
    if (Number.isFinite(value) && !Number.isSafeInteger(value) && !Object.is(value, -0)) {
      values.push(value);
      random++;
    }
  }
  for (let step = 1; step <= COMPUTED; step++) values.push(step * 0.0175 / 3 - 37);
  assert.ok(values.every(value => !Number.isSafeInteger(value)));
  return values;
}

export function doubleBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

/** The cases a capture holds: one a write path and a read path. */
export function doubleCases(capture: DoubleCapture): string[] {
  return [...new Set(capture.observations.map(({ write, read }) => `${write}/${read}`))];
}

/** A recording of the reference: every read returns every value unchanged. */
export function verifyDoubleCapture(capture: DoubleCapture): void {
  const written = capture.values.map(value => value.bits);
  assert.deepEqual(capture.values.map(value => doubleBits(JSON.parse(value.json) as number)), written, "each JSON names its value");
  assert.deepEqual(capture.values.map(value => value.json), doubleValues().map(value => JSON.stringify(value)), "the corpus's values");
  assert.equal(capture.observations.length, doubleWrites.length * doubleReads.length * capture.documents);
  for (const write of doubleWrites) {
    for (const read of doubleReads) {
      const bits = capture.observations.filter(item => item.write === write && item.read === read).flatMap(item => item.bits);
      assert.deepEqual(bits, written, `${write}/${read} returns every value unchanged`);
    }
  }
}

/** Each case where `actual` read back other bits than the recording, with how many. */
export function compareDoubleCapture(actual: DoubleCapture, expected: DoubleCapture): Map<string, number> {
  assert.deepEqual(actual.values, expected.values, "the same values were written");
  const changed = new Map<string, number>();
  for (const recorded of expected.observations) {
    const replayed = actual.observations.find(item =>
      item.write === recorded.write && item.read === recorded.read && item.document === recorded.document);
    assert.ok(replayed, `${recorded.write}/${recorded.read} ${recorded.document} was read`);
    assert.equal(replayed.bits.length, recorded.bits.length, `${recorded.write}/${recorded.read} ${recorded.document}: every value`);
    const differing = recorded.bits.filter((bits, index) => replayed.bits[index] !== bits).length;
    const key = `${recorded.write}/${recorded.read}`;
    changed.set(key, (changed.get(key) ?? 0) + differing);
  }
  return new Map([...changed].filter(([, count]) => count > 0));
}
