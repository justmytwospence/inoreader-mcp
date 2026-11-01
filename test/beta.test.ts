import { test } from "node:test";
import assert from "node:assert/strict";
import { betaCdf, betaQuantile } from "../src/statistics/beta.js";

function close(actual: number, expected: number, relative = 3e-12, absolute = 0): void {
  assert.ok(Number.isFinite(actual), `nonfinite result: ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= Math.max(absolute, relative * Math.abs(expected)),
    `${actual} != ${expected}`,
  );
}

const shapes: Array<[number, number]> = [
  [1, 1], [2, 3], [0.1, 0.1], [0.01, 2], [2, 0.01],
  [0.2, 30000], [30000, 0.2], [10000, 10000], [1e-8, 5], [5, 1e-8],
];

test("Beta validates probabilities and both shapes, including at boundaries", () => {
  for (const fn of [betaCdf, betaQuantile]) {
    for (const invalid of [NaN, Infinity, -Infinity, -1, 1.0001]) {
      assert.throws(() => fn(invalid, 2, 3), RangeError);
    }
    for (const invalid of [NaN, Infinity, -Infinity, 0, -1]) {
      for (const p of [0, 0.5, 1]) {
        assert.throws(() => fn(p, invalid, 3), RangeError);
        assert.throws(() => fn(p, 2, invalid), RangeError);
      }
    }
  }
});

test("uniform Beta is the identity, including tiny probabilities", () => {
  for (const p of [0, Number.MIN_VALUE, 1e-300, 1e-100, 1e-20, 0.025, 0.5, 0.975, 1]) {
    assert.equal(betaCdf(p, 1, 1), p);
    assert.equal(betaQuantile(p, 1, 1), p);
  }
});

test("Beta has exact endpoints and symmetric medians", () => {
  for (const [a, b] of shapes) {
    assert.equal(betaCdf(0, a, b), 0);
    assert.equal(betaCdf(1, a, b), 1);
    assert.equal(betaQuantile(0, a, b), 0);
    assert.equal(betaQuantile(1, a, b), 1);
  }
  for (const a of [1e-8, 0.1, 1, 50, 10000]) {
    assert.equal(betaCdf(0.5, a, a), 0.5);
    assert.equal(betaQuantile(0.5, a, a), 0.5);
  }
});

// Fixed independent references: scipy.special.betainc / betaincinv (SciPy
// 1.18.1). No external numerical package or API is needed to run these tests.
test("Beta CDF matches fixed references for small, unequal and concentrated shapes", () => {
  const cases: Array<[number, number, number, number]> = [
    [0.2, 2, 3, 0.18080000000000004],
    [0.9, 5, 10, 0.99999993159585],
    [1e-100, 0.01, 2, 0.10100000000000002],
    [1e-250, 0.001, 3, 0.5631851183487974],
    [1e-12, 0.1, 0.1, 0.032004508367027916],
    [0.2, 1e-8, 5, 0.9999999978362876],
    [0.8, 5, 1e-8, 2.1637124759919167e-9],
    [0.499, 10000, 10000, 0.3886499521425378],
    [0.51, 1000, 1000, 0.8144473405684881],
    [0.001, 2.5, 500, 0.037595708684998765],
    [1e-8, 0.2, 30000, 0.21502000926700376],
    [0.9999999, 1e8, 3, 0.00276939436546218],
  ];
  for (const [x, a, b, expected] of cases) close(betaCdf(x, a, b), expected);
});

test("Beta quantiles match fixed references far below ordinary bisection resolution", () => {
  const cases: Array<[number, number, number, number]> = [
    [0.025, 2, 3, 0.06758598648854294],
    [0.975, 2, 3, 0.8058795503167565],
    [0.025, 0.1, 0.1, 8.458405166196453e-14],
    [0.1, 0.01, 2, 3.6971121232911064e-101],
    [0.5, 0.001, 3, 2.0836937279216174e-302],
    [0.001, 0.2, 30000, 2.1751892835795155e-20],
    [0.025, 10000, 10000, 0.4930707270025499],
    [0.975, 10000, 10000, 0.5069292729974502],
    [0.999, 2.5, 500, 0.020275970451005647],
    [0.025, 1e8, 3, 0.9999999277531267],
    [1e-100, 2, 3, 4.0824829046386306e-51],
    [1e-20, 10, 25, 0.0015477392878187476],
  ];
  for (const [q, a, b, expected] of cases) close(betaQuantile(q, a, b), expected);
});

test("one-shape formulas retain tiny tails and complementary quantiles", () => {
  close(betaCdf(1e-100, 1, 5), 5e-100);
  close(betaCdf(1e-100, 2, 1), 1e-200);
  close(betaQuantile(1e-100, 1, 5), 2e-101);
  close(betaQuantile(1e-100, 2, 1), 1e-50);
  for (const x of [0.01, 0.2, 0.5, 0.9]) {
    close(betaCdf(x, 0.5, 0.5), (2 / Math.PI) * Math.asin(Math.sqrt(x)));
  }
});

test("Beta CDF and quantiles obey reflection symmetry", () => {
  for (const [a, b] of shapes) {
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      close(betaCdf(x, a, b) + betaCdf(1 - x, b, a), 1);
    }
    for (const q of [0.025, 0.1, 0.5, 0.9, 0.975]) {
      close(betaQuantile(q, a, b) + betaQuantile(1 - q, b, a), 1);
    }
  }
});

test("Beta CDF and quantiles are monotone and bounded", () => {
  for (const [a, b] of shapes) {
    for (const fn of [betaCdf, betaQuantile]) {
      let previous = 0;
      for (const p of [0, 1e-100, 1e-20, 1e-12, 1e-6, 0.001, 0.025, 0.1, 0.25,
        0.5, 0.75, 0.9, 0.975, 0.999, 1 - 1e-6, 1 - 1e-12, 1]) {
        const result = fn(p, a, b);
        assert.ok(Number.isFinite(result) && result >= 0 && result <= 1);
        assert.ok(result >= previous, `${fn.name}(${p}, ${a}, ${b}): ${result} < ${previous}`);
        previous = result;
      }
    }
  }
});

test("Beta quantile/CDF round trips across practical calibration and feed shapes", () => {
  for (const [a, b] of [[0.1, 0.1], [0.01, 2], [0.2, 30000], [2, 3], [50, 80],
    [10000, 10000]]) {
    // Avoid upper endpoints whose nearest representable x cannot encode q.
    const probabilities = a < 0.1 ? [0.001, 0.025, 0.1, 0.5, 0.975]
      : a < 1 && b < 1 ? [0.001, 0.025, 0.1, 0.5, 0.9]
      : [1e-12, 1e-6, 0.025, 0.5, 0.975, 1 - 1e-6];
    for (const q of probabilities) {
      const x = betaQuantile(q, a, b);
      assert.ok(x > 0 && x < 1);
      close(betaCdf(x, a, b), q, 5e-11, 2e-14);
    }
  }
  for (const [a, b] of [[0.2, 30], [2, 3], [50, 80]]) {
    for (const x of [0.01, 0.1, 0.25, 0.5]) {
      const q = betaCdf(x, a, b);
      // Once CDF rounds to 1 there is no invertible interior probability.
      if (q < 1 - 1e-10) close(betaQuantile(q, a, b), x, 1e-8);
    }
  }
});

test("skewed quantiles above probability one half retain a tiny nonzero x", () => {
  // Reflection based only on q would turn these into 1 - 1 = 0.
  for (const q of [0.6, 0.9, 0.99]) {
    const x = betaQuantile(q, 0.01, 2);
    assert.ok(x > 0 && x < 0.5);
    close(betaCdf(x, 0.01, 2), q);
  }
});

test("unrepresentable quantiles round to endpoints rather than a bisection floor", () => {
  assert.equal(betaQuantile(0.025, 1e-8, 5), 0);
  assert.equal(betaQuantile(0.975, 5, 1e-8), 1);
  assert.equal(betaQuantile(0.025, 1e-8, 1e-8), 0);
  assert.equal(betaQuantile(0.975, 1e-8, 1e-8), 1);
});
