// ============================================================
// Halo V2 — OLS with HAC (Newey-West) standard errors.
//
// Brief §19: weekly time-series residuals are usually autocorrelated, so the
// classical standard error understates uncertainty and the confidence interval
// comes out too narrow. A too-narrow interval is the one failure mode this whole
// redesign exists to avoid — it manufactures confidence. So HAC is the default
// and the classical SE is kept only for comparison.
//
// Brief §22: lagged copies of the same series are collinear almost by
// definition, which makes INDIVIDUAL lag coefficients unstable while their SUM
// stays well estimated. That is why the cumulative coefficient — not any single
// beta — is the headline number, and why we report VIF so the UI can say so.
// ============================================================

import { transpose, matMul, matVec, invert, mean } from './matrix.js';

// Fit y = Xb. X must already include an intercept column if one is wanted.
// Returns null when the system can't be solved (singular / degenerate).
export function ols(X, y) {
  if (!X.length || X.length !== y.length) return null;
  const n = X.length;
  const k = X[0].length;
  if (n <= k) return null;                 // no residual degrees of freedom

  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const XtXinv = invert(XtX);
  if (!XtXinv) return null;
  const beta = matVec(matMul(XtXinv, Xt), y);
  if (beta.some((b) => !Number.isFinite(b))) return null;

  const fitted = matVec(X, beta);
  const resid = y.map((v, i) => v - fitted[i]);
  const rss = resid.reduce((s, e) => s + e * e, 0);
  const ybar = mean(y);
  const tss = y.reduce((s, v) => s + (v - ybar) * (v - ybar), 0);
  const r2 = tss > 0 ? 1 - rss / tss : null;
  const dof = n - k;
  const adjR2 = (r2 == null || dof <= 0 || n - 1 <= 0) ? null : 1 - (1 - r2) * ((n - 1) / dof);
  const sigma2 = dof > 0 ? rss / dof : null;

  // Classical covariance: sigma^2 (X'X)^-1
  const covClassic = sigma2 == null ? null : XtXinv.map((row) => row.map((v) => v * sigma2));

  return { beta, fitted, resid, rss, r2, adjR2, n, k, dof, XtXinv, X, y, covClassic };
}

// Newey-West bandwidth: the standard Greene/Newey rule of thumb.
export function hacBandwidth(n) {
  return Math.max(1, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
}

// HAC (Newey-West) covariance matrix. Bartlett kernel weights w_l = 1 - l/(L+1),
// with the usual n/(n-k) small-sample correction.
export function hacCovariance(fit, bandwidth) {
  if (!fit) return null;
  const { X, resid, XtXinv, n, k } = fit;
  const L = bandwidth == null ? hacBandwidth(n) : bandwidth;
  const p = X[0].length;

  const meat = Array.from({ length: p }, () => new Array(p).fill(0));
  // Lag 0 term: sum_t e_t^2 x_t x_t'
  for (let t = 0; t < n; t++) {
    const e2 = resid[t] * resid[t];
    for (let i = 0; i < p; i++) {
      if (X[t][i] === 0) continue;
      for (let j = 0; j < p; j++) meat[i][j] += e2 * X[t][i] * X[t][j];
    }
  }
  // Autocovariance terms, symmetrised.
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1);
    for (let t = l; t < n; t++) {
      const ee = resid[t] * resid[t - l];
      if (ee === 0) continue;
      for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) {
          meat[i][j] += w * ee * (X[t][i] * X[t - l][j] + X[t - l][i] * X[t][j]);
        }
      }
    }
  }
  const scale = n - k > 0 ? n / (n - k) : 1;
  const scaled = meat.map((row) => row.map((v) => v * scale));
  const cov = matMul(matMul(XtXinv, scaled), XtXinv);
  return { cov, bandwidth: L };
}

// Variance of a linear combination c'beta — this is how the cumulative
// coefficient's interval is built (c = 1 on every lag term, 0 elsewhere).
export function linearCombo(beta, cov, c) {
  const value = c.reduce((s, w, i) => s + w * beta[i], 0);
  let variance = 0;
  for (let i = 0; i < c.length; i++) {
    if (c[i] === 0) continue;
    for (let j = 0; j < c.length; j++) {
      if (c[j] === 0) continue;
      variance += c[i] * c[j] * cov[i][j];
    }
  }
  const se = variance > 0 ? Math.sqrt(variance) : null;
  return { value, se, variance };
}

// 95% interval on the normal approximation. Small samples are already blocked
// by the sufficiency guardrail (brief §13), so a t-quantile table would add
// precision the sample size doesn't justify claiming.
export function ci95(value, se) {
  if (se == null || !Number.isFinite(se)) return { lower: null, upper: null };
  return { lower: value - 1.96 * se, upper: value + 1.96 * se };
}

// VIF per predictor: regress each column on the others (brief §22). Returns
// null entries where the sub-regression can't be fit. Intercept is skipped.
export function varianceInflation(X, interceptIndex = 0) {
  const p = X[0]?.length || 0;
  const out = new Array(p).fill(null);
  for (let j = 0; j < p; j++) {
    if (j === interceptIndex) continue;
    const yj = X.map((row) => row[j]);
    const Xj = X.map((row) => row.filter((_, i) => i !== j));
    const f = ols(Xj, yj);
    if (!f || f.r2 == null) continue;
    const r2 = Math.min(0.999999, Math.max(0, f.r2));
    out[j] = 1 / (1 - r2);
  }
  return out;
}

// Cook's distance — which observations move the estimate most (brief §30).
// We never drop them automatically; we flag them and offer a refit.
export function influence(fit) {
  if (!fit) return [];
  const { X, resid, XtXinv, k, rss, n } = fit;
  const dof = n - k;
  const s2 = dof > 0 ? rss / dof : null;
  if (!s2) return [];
  return X.map((xt, t) => {
    // leverage h_t = x_t' (X'X)^-1 x_t
    let h = 0;
    for (let i = 0; i < xt.length; i++) {
      for (let j = 0; j < xt.length; j++) h += xt[i] * XtXinv[i][j] * xt[j];
    }
    const denom = (1 - h);
    const d = denom > 1e-9 ? (resid[t] * resid[t] * h) / (k * s2 * denom * denom) : null;
    return { index: t, leverage: h, cooksD: d };
  });
}
