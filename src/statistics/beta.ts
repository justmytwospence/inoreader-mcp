// Dependency-free regularized incomplete beta and its inverse. The continued
// fraction is the same Lanczos/Lentz approach formerly used by calibration.
const LOG_SQRT_2PI = 0.9189385332046727;
const EPS = 4 * Number.EPSILON;

function validate(probability: number, alpha: number, beta: number): void {
  if (!Number.isFinite(alpha) || alpha <= 0 || !Number.isFinite(beta) || beta <= 0) {
    throw new RangeError("Beta shapes must be positive finite numbers");
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("Beta probability must be finite and in [0, 1]");
  }
}

// Lanczos (g=7), with recurrence rather than reflection for small positive x.
function lgamma(x: number): number {
  if (x === 1 || x === 2) return 0;
  if (x < 1) return lgamma(x + 1) - Math.log(x);
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  const z = x - 1;
  let sum = 0.9999999999998099;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + 7.5;
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

// Stirling remainder; only used for x >= 8.
function correction(x: number): number {
  const r = 1 / x;
  const r2 = r * r;
  return r * (1 / 12 + r2 * (-1 / 360 + r2 * (1 / 1260 + r2 *
    (-1 / 1680 + r2 * (1 / 1188 + r2 * (-691 / 360360 + r2 / 156))))));
}

// log(B(a,b)): avoid subtracting enormous, nearly equal log-gammas.
function logBeta(a: number, b: number): number {
  if (a > b) return logBeta(b, a);
  if (b < 8) return lgamma(a) + lgamma(b) - lgamma(a + b);
  const ratio = a / b;
  const logSum = Math.log(b) + Math.log1p(ratio);
  if (a < 8) {
    return lgamma(a) - a * Math.log(b) - (b - 0.5 + a) * Math.log1p(ratio) + a +
      correction(b) - correction(a + b);
  }
  return LOG_SQRT_2PI - 0.5 * logSum +
    (a - 0.5) * (Math.log(ratio) - Math.log1p(ratio)) -
    (b - 0.5) * Math.log1p(ratio) + correction(a) + correction(b) - correction(a + b);
}

// log(Gamma(1+x)) without an O(epsilon) absolute error at tiny x.
function logGamma1p(x: number): number {
  if (x >= 0.01) return lgamma(1 + x);
  const coefficients = [
    0.8224670334241132, -0.40068563438653143, 0.27058080842778455,
    -0.20738555102867398, 0.1695571769974082, -0.1440498967688461,
    0.12550966952474304, -0.11133426586956469, 0.1000994575127818,
  ];
  let polynomial = coefficients[coefficients.length - 1];
  for (let i = coefficients.length - 2; i >= 0; i--) polynomial = coefficients[i] + x * polynomial;
  return x * (-0.5772156649015329 + x * polynomial);
}

function logBetaTimesA(a: number, b: number): number {
  if (a >= 1) return logBeta(a, b) + Math.log(a);
  let scale = 0;
  while (b < 8) {
    const ratio = a / b;
    scale += Number.isFinite(ratio) ? Math.log1p(ratio) : Math.log(a) - Math.log(b);
    b += 1;
  }
  const logRatio = Math.log1p(a / b);
  // Difference of Stirling remainders, without subtracting nearby values.
  const coefficients = [1 / 12, -1 / 360, 1 / 1260, -1 / 1680, 1 / 1188, -691 / 360360, 1 / 156];
  let difference = 0;
  let power = 1 / b;
  for (let i = 0; i < coefficients.length; i++) {
    difference -= coefficients[i] * power * Math.expm1(-(2 * i + 1) * logRatio);
    power /= b * b;
  }
  return scale + logGamma1p(a) - a * Math.log(b) - (b - 0.5 + a) * logRatio + a + difference;
}

function log1pmx(x: number): number {
  if (Math.abs(x) > 0.01) return Math.log1p(x) - x;
  let term = -x * x / 2;
  let sum = term;
  for (let n = 3; n < 20; n++) {
    term *= -x * (n - 1) / n;
    sum += term;
  }
  return sum;
}

// log(x^a (1-x)^b / (a B(a,b))). Keep the division by a in
// logarithms, so an underflowing prefactor cannot erase a representable tail.
function logPrefactor(x: number, logX: number, logOneMinusX: number, a: number, b: number): number {
  if (a >= 8 && b >= 8) {
    const ratio = a / b;
    const mean = a <= b ? ratio / (1 + ratio) : 1 / (1 + b / a);
    const otherMean = a <= b ? 1 / (1 + ratio) : (b / a) / (1 + b / a);
    const complement = -Math.expm1(logX);
    const delta = a <= b ? x - mean : otherMean - complement;
    const logSum = Math.log(Math.max(a, b)) + Math.log1p(Math.min(a, b) / Math.max(a, b));
    // Subtract the linear terms analytically near the mode to avoid cancellation.
    const kernel = x > 0.01 * mean && complement > 0.01 * otherMean
      ? a * log1pmx(delta / mean) + b * log1pmx(-delta / otherMean)
      : a * (logX - Math.log(mean)) + b * (logOneMinusX - Math.log(otherMean));
    return kernel + 0.5 * (Math.log(a) + Math.log(b) - logSum) - LOG_SQRT_2PI -
      correction(a) - correction(b) + correction(a + b) - Math.log(a);
  }
  return a * logX + b * logOneMinusX - logBetaTimesA(a, b);
}

// Lentz's continued fraction, evaluated only on its well-conditioned side.
function betaCf(x: number, complement: number, a: number, b: number): number {
  const floor = (v: number): number => Math.abs(v) < 1e-300 ? (v < 0 ? -1e-300 : 1e-300) : v;
  let c = 1;
  let d = 1 / floor((a * complement + 1 - b * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const m2 = 2 * m;
    const even = (m / (a + m2)) * ((b - m) / (a - 1 + m2)) * x;
    const evenD = even * d;
    const evenC = even / c;
    const denominatorD = floor(1 + evenD);
    const denominatorC = floor(1 + evenC);
    h *= denominatorC / denominatorD;
    // Write the odd coefficient as -x + adjustment. Keeping the even
    // increments separately avoids cancellation of 1 + odd near x = 1,
    // which otherwise loses many digits for highly unequal shapes.
    const r = m / (a + m2);
    const s = (b - 1 - m) / (a + 1 + m2);
    const adjustment = x * (r - s + r * s);
    d = denominatorD / floor(evenD + complement + adjustment);
    c = floor((evenC + complement + adjustment) / denominatorC);
    const change = d * c;
    h *= change;
    if (Math.abs(change - 1) <= EPS) return h;
  }
  throw new Error("Beta continued fraction did not converge");
}

function logCdf(
  x: number, logX: number, a: number, b: number,
  complement = 1 - x, logComplement = Math.log1p(-x),
): number {
  if (a === b && x === 0.5) return -Math.LN2;
  if (b === 1) return a * logX;
  if (a === 1) return logOneMinusExp(b * logComplement);
  if (a < 1 && x <= 0.5 && b * x <= 1) {
    // Integrate the binomial series. Summing only its nonconstant terms
    // retains the tiny difference from 1 when a is very small.
    let coefficient = 1;
    let sum = 0;
    for (let n = 1; n <= 10000; n++) {
      coefficient *= ((n - b) * x) / n;
      const term = coefficient * (a / (a + n));
      sum += term;
      if (Math.abs(term) <= EPS * Math.max(Math.abs(sum), Number.MIN_VALUE)) {
        return Math.min(0, a * logX - logBetaTimesA(a, b) + Math.log1p(sum));
      }
    }
    throw new Error("Beta power series did not converge");
  }
  const threshold = (a / 2 + 0.5) / (a / 2 + b / 2 + 1);
  if (x <= threshold) {
    return Math.min(0, logPrefactor(x, logX, logComplement, a, b) + Math.log(betaCf(x, complement, a, b)));
  }
  const logTail = Math.min(0, logPrefactor(complement, logComplement, logX, b, a) +
    Math.log(betaCf(complement, x, b, a)));
  return logOneMinusExp(logTail);
}

function logOneMinusExp(x: number): number {
  return x < -Math.LN2 ? Math.log1p(-Math.exp(x)) : Math.log(-Math.expm1(x));
}

/** Regularized Beta CDF. Shapes must be positive finite; x must be in [0, 1]. */
export function betaCdf(x: number, alpha: number, beta: number): number {
  validate(x, alpha, beta);
  if (x === 0 || x === 1 || (alpha === 1 && beta === 1)) return x;
  if (alpha === beta && x === 0.5) return 0.5;
  return Math.exp(logCdf(x, Math.log(x), alpha, beta));
}

/**
 * Inverse Beta CDF for q in [0, 1] and positive finite shapes. Reflect the
 * variable before inversion and bisect in log(x), not x: a fixed number of
 * ordinary bisections cannot resolve small-shape quantiles such as 1e-200.
 * Results outside the representable double range round to 0 or 1.
 */
export function betaQuantile(q: number, alpha: number, beta: number): number {
  validate(q, alpha, beta);
  if (q === 0 || q === 1 || (alpha === 1 && beta === 1)) return q;
  if (alpha === beta && q === 0.5) return 0.5;
  if (beta === 1) return Math.exp(Math.log(q) / alpha);
  if (alpha === 1) return -Math.expm1(Math.log1p(-q) / beta);
  // Reflect based on the solution's location, not q alone. A left-skewed
  // distribution can have q > 0.5 at x = 1e-100; subtracting that inverse
  // from 1 would erase it. Compare the smaller probability in log space too.
  const reflect = q > betaCdf(0.5, alpha, beta);
  const a = reflect ? beta : alpha;
  const b = reflect ? alpha : beta;
  const upper = reflect ? q < 0.5 : q > 0.5;
  const logTarget = reflect === upper ? Math.log(q) : Math.log1p(-q);
  const atOrAbove = (logX: number): boolean => {
    const x = Math.exp(logX);
    return upper
      ? logCdf(1 - x, Math.log1p(-x), b, a, x, logX) <= logTarget
      : logCdf(x, logX, a, b) >= logTarget;
  };
  let lo = Math.log(Number.MIN_VALUE) - Math.LN2;
  let hi = -Math.LN2;
  if (atOrAbove(lo)) return reflect ? 1 : 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (atOrAbove(mid)) hi = mid;
    else lo = mid;
  }
  const x = Math.exp(hi);
  return reflect ? 1 - x : x;
}
