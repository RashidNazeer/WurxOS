// ============================================================
// Halo V2 — minimal dense linear algebra.
//
// Everything the distributed-lag model needs and nothing more: solve a normal
// system, invert a small symmetric matrix, multiply. Matrices are plain arrays
// of row arrays; vectors are plain arrays.
//
// Sizes here are tiny (a handful of predictors), so clarity beats cleverness —
// but Gauss-Jordan with PARTIAL PIVOTING, not naive elimination, because the
// lagged columns of a distributed-lag design are highly collinear and a zero
// pivot is a realistic outcome rather than a theoretical one.
// ============================================================

export function transpose(A) {
  const rows = A.length, cols = A[0]?.length || 0;
  const T = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) T[j][i] = A[i][j];
  return T;
}

export function matMul(A, B) {
  const n = A.length, m = B[0]?.length || 0, k = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const a = A[i][p];
      if (a === 0) continue;
      for (let j = 0; j < m; j++) C[i][j] += a * B[p][j];
    }
  }
  return C;
}

export function matVec(A, v) {
  return A.map((row) => row.reduce((s, a, j) => s + a * v[j], 0));
}

// Inverse via Gauss-Jordan with partial pivoting. Returns null when the matrix
// is singular to working precision — the caller must treat that as "this model
// cannot be estimated", never as zeros.
export function invert(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (!(Math.abs(A[piv][col]) > 1e-12)) return null;
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
    const p = A[col][col];
    for (let j = 0; j < 2 * n; j++) A[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[col][j];
    }
  }
  return A.map((row) => row.slice(n));
}

export const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
