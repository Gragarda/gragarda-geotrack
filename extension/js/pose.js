/*
 * Gragarda GeoTrack — maths de pose côté panneau (sans dépendance).
 * Repère : x droite, y bas, z vers l'avant (comme AE). Pose = (rvec, tvec) :
 *   point_camera = R(rvec) * point_mesh + tvec
 * Utilisable dans le panneau (window.GTPose) et dans Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTPose = factory();
})(this, function () {
  'use strict';

  function rodrigues(r) {
    var th = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    var kx = r[0] / th, ky = r[1] / th, kz = r[2] / th;
    var c = Math.cos(th), s = Math.sin(th), v = 1 - c;
    return [
      [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s],
      [ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s],
      [kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v]
    ];
  }

  function matToRvec(R) {
    var tr = R[0][0] + R[1][1] + R[2][2];
    var c = Math.max(-1, Math.min(1, (tr - 1) / 2));
    var th = Math.acos(c);
    if (th < 1e-9) return [0, 0, 0];
    if (Math.PI - th < 1e-4) {
      // ~180° : axe = colonne dominante de (R + I)/2
      var xx = (R[0][0] + 1) / 2, yy = (R[1][1] + 1) / 2, zz = (R[2][2] + 1) / 2;
      var ax;
      if (xx >= yy && xx >= zz) { var x = Math.sqrt(xx); ax = [x, R[0][1] / (2 * x), R[0][2] / (2 * x)]; }
      else if (yy >= zz) { var y = Math.sqrt(yy); ax = [R[0][1] / (2 * y), y, R[1][2] / (2 * y)]; }
      else { var z = Math.sqrt(zz); ax = [R[0][2] / (2 * z), R[1][2] / (2 * z), z]; }
      var n = Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]);
      return [ax[0] / n * th, ax[1] / n * th, ax[2] / n * th];
    }
    var k = th / (2 * Math.sin(th));
    return [(R[2][1] - R[1][2]) * k, (R[0][2] - R[2][0]) * k, (R[1][0] - R[0][1]) * k];
  }

  function mul(A, B) {
    var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++)
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    return C;
  }

  function transpose(A) {
    return [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
  }

  function axisRot(axis, a) {
    var c = Math.cos(a), s = Math.sin(a);
    if (axis === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
    if (axis === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  }

  /* camera : {f, cx, cy} en px de comp */
  function project(R, t, X, cam) {
    var x = R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0];
    var y = R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1];
    var z = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2];
    if (z < 1e-3) return null;
    return [cam.f * x / z + cam.cx, cam.f * y / z + cam.cy, z];
  }

  function projectAll(rvec, tvec, verts, cam) {
    var R = rodrigues(rvec), out = new Array(verts.length);
    for (var i = 0; i < verts.length; i++) out[i] = project(R, tvec, verts[i], cam);
    return out;
  }

  /* --- résolution linéaire 6x6 (Gauss avec pivot) --- */
  function solve(A, b) {
    var n = b.length, M = [], i, j, k;
    for (i = 0; i < n; i++) M.push(A[i].slice().concat([b[i]]));
    for (k = 0; k < n; k++) {
      var p = k;
      for (i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
      if (Math.abs(M[p][k]) < 1e-15) return null;
      var tmp = M[k]; M[k] = M[p]; M[p] = tmp;
      for (i = k + 1; i < n; i++) {
        var f = M[i][k] / M[k][k];
        for (j = k; j <= n; j++) M[i][j] -= f * M[k][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /*
   * Ajuste la pose pour que chaque pin (point 3D du mesh) tombe sur sa cible 2D.
   * Comportement inspiré de GeoTracker :
   *   1 pin  -> l'objet glisse (translation dans le plan de l'image, distance conservée)
   *   2 pins -> glisse + tourne dans le plan de l'image + avance/recule
   *   3+ pins -> rotation 3D libre (légèrement retenue à 3 pins pour rester stable)
   * La rotation est paramétrée dans le repère caméra : R = rot(d) * R0.
   * pins : [{X:[x,y,z], target:[u,v]}]
   */
  function solvePins(pins, rvec, tvec, cam, opts) {
    opts = opts || {};
    var n = pins.length;
    if (!n) return { rvec: rvec.slice(), tvec: tvec.slice(), error: 0 };
    var R0 = rodrigues(rvec), t0 = tvec.slice();
    var LOCK = 1e4, FREE = 1e-4;
    // poids [pitch, yaw, roll] (px par radian) et [tx, ty, tz] (px par px)
    var wR, wT;
    if (n === 1) { wR = [LOCK, LOCK, LOCK]; wT = [FREE, FREE, LOCK]; }
    else if (n === 2) { wR = [LOCK, LOCK, FREE]; wT = [FREE, FREE, FREE]; }
    else if (n === 3) { wR = [3, 3, FREE]; wT = [FREE, FREE, FREE]; }
    else { wR = [1e-2, 1e-2, 1e-2]; wT = [FREE, FREE, FREE]; }
    if (opts.free) { wR = [1e-4, 1e-4, 1e-4]; wT = [FREE, FREE, FREE]; }
    if (opts.lockDepth) wT[2] = LOCK;
    var lambda = 1e-3;

    function poseOf(q) { return { R: mul(rodrigues([q[0], q[1], q[2]]), R0), t: [t0[0] + q[3], t0[1] + q[4], t0[2] + q[5]] }; }
    function residuals(q) {
      var P = poseOf(q), r = [];
      for (var i = 0; i < n; i++) {
        var pr = project(P.R, P.t, pins[i].X, cam);
        if (!pr) { r.push(1e4, 1e4); continue; }
        r.push(pr[0] - pins[i].target[0], pr[1] - pins[i].target[1]);
      }
      for (var k = 0; k < 3; k++) r.push(wR[k] * q[k]);
      for (var k2 = 0; k2 < 3; k2++) r.push(wT[k2] * q[3 + k2]);
      return r;
    }
    function cost(r) { var s = 0; for (var i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }

    var p = [0, 0, 0, 0, 0, 0];
    var r = residuals(p), c = cost(r);
    var steps = [1e-6, 1e-6, 1e-6, 1e-3, 1e-3, 1e-3];
    for (var it = 0; it < (opts.iterations || 50); it++) {
      var J = [];
      for (var k = 0; k < 6; k++) {
        var q = p.slice(); var h = steps[k] * Math.max(1, Math.abs(p[k]));
        q[k] += h;
        var rk = residuals(q), col = new Array(r.length);
        for (var m = 0; m < r.length; m++) col[m] = (rk[m] - r[m]) / h;
        J.push(col);
      }
      var A = [], g = [];
      for (var a = 0; a < 6; a++) {
        A.push([]);
        var ga = 0;
        for (var m2 = 0; m2 < r.length; m2++) ga += J[a][m2] * r[m2];
        g.push(-ga);
        for (var b = 0; b < 6; b++) {
          var s = 0;
          for (var m3 = 0; m3 < r.length; m3++) s += J[a][m3] * J[b][m3];
          A[a].push(s);
        }
      }
      var improved = false, converged = false;
      for (var tries = 0; tries < 10; tries++) {
        var Ad = A.map(function (row, i) { var rr = row.slice(); rr[i] += lambda * (A[i][i] + 1e-9); return rr; });
        var dx = solve(Ad, g);
        if (!dx) { lambda *= 10; continue; }
        var pn = p.map(function (v, i) { return v + dx[i]; });
        var rn = residuals(pn), cn = cost(rn);
        if (cn < c) {
          converged = (c - cn) / Math.max(c, 1e-12) < 1e-12;
          p = pn; r = rn; c = cn;
          lambda = Math.max(lambda / 10, 1e-12); improved = true;
          break;
        }
        lambda *= 10;
      }
      if (!improved || converged) break;
    }
    var P = poseOf(p), e = 0;
    for (var i = 0; i < n; i++) {
      var pr = project(P.R, P.t, pins[i].X, cam);
      if (pr) e += Math.hypot(pr[0] - pins[i].target[0], pr[1] - pins[i].target[1]);
    }
    return { rvec: matToRvec(P.R), tvec: P.t, error: e / n };
  }

  /*
   * Recherche globale (au relâchement d'un pin, 4 pins ou plus) : l'optimisation locale peut rester
   * coincée dans une mauvaise solution, typiquement la pose "miroir" quand tous les pins sont sur
   * une face plane. On repart de ~40 orientations différentes et on garde la meilleure.
   */
  function solvePinsGlobal(pins, rvec, tvec, cam) {
    var best = solvePins(pins, rvec, tvec, cam, { free: true });
    if (pins.length < 4 || best.error < 0.5) return best;
    var R0 = rodrigues(rvec), d = Math.PI / 180;
    var yaws = [0, 45, -45, 90, -90, 135, -135, 180], pitches = [0, 45, -45, 90, -90];
    for (var a = 0; a < yaws.length; a++) for (var b = 0; b < pitches.length; b++) {
      if (!a && !b) continue;
      var D = mul(axisRot(0, pitches[b] * d), axisRot(1, yaws[a] * d));
      var start = matToRvec(mul(D, R0));
      var sol = solvePins(pins, start, tvec, cam, { free: true, iterations: 80 });
      if (sol.error < best.error - 1e-6) best = sol;
      if (best.error < 0.05) return best;
    }
    return best;
  }

  /* Orbite : tourne l'objet autour de son centre, dans le repère caméra. */
  function orbit(rvec, tvec, dyaw, dpitch, droll) {
    var R = rodrigues(rvec);
    var D = mul(axisRot(2, droll || 0), mul(axisRot(0, dpitch), axisRot(1, dyaw)));
    return { rvec: matToRvec(mul(D, R)), tvec: tvec.slice() };
  }

  /* ---------- Euler d'After Effects ----------
   * AE ne documente pas précisément l'ordre de ses rotations X/Y/Z : le panneau le mesure
   * (voir host.jsx gt_probeRotation) puis on choisit la convention qui reproduit la mesure.
   * Une convention = ordre d'application (ex. [0,1,2] = X puis Y puis Z) + signe par axe.
   */
  var ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

  function eulerToMatrix(deg, conv) {
    var M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var i = 0; i < 3; i++) {
      var ax = conv.order[i];
      M = mul(axisRot(ax, conv.signs[ax] * deg[ax] * Math.PI / 180), M); // appliqué après les précédents
    }
    return M;
  }

  function parity(o) {
    var even = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
    for (var i = 0; i < 3; i++) if (even[i][0] === o[0] && even[i][1] === o[1] && even[i][2] === o[2]) return 1;
    return -1;
  }

  /* Décomposition fermée pour M = R_k(c) R_j(b) R_i(a), (i,j,k) = conv.order. Renvoie [x,y,z] en degrés. */
  function matrixToEuler(M, conv) {
    var i = conv.order[0], j = conv.order[1], k = conv.order[2], sg = parity(conv.order);
    var a, b, c;
    var sb = -sg * M[k][i];
    sb = Math.max(-1, Math.min(1, sb));
    b = Math.asin(sb);
    if (Math.sqrt(Math.max(0, 1 - sb * sb)) > 1e-10) {
      a = Math.atan2(sg * M[k][j], M[k][k]);
      c = Math.atan2(sg * M[j][i], M[i][i]);
    } else { // blocage de cardan : on met tout sur a
      c = 0;
      a = Math.atan2(-sg * M[j][k], M[j][j]);
    }
    var out = [0, 0, 0];
    out[i] = a; out[j] = b; out[k] = c;
    for (var t = 0; t < 3; t++) out[t] = conv.signs[t] * out[t] * 180 / Math.PI;
    return out;
  }

  /* measured : matrice 3x3 mesurée dans AE pour les angles testAngles (degrés). */
  function detectConvention(measured, testAngles) {
    var best = null;
    for (var o = 0; o < ORDERS.length; o++) for (var s = 0; s < 8; s++) {
      var conv = { order: ORDERS[o], signs: [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1] };
      var M = eulerToMatrix(testAngles, conv), err = 0;
      for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) err += Math.abs(M[a][b] - measured[a][b]);
      if (!best || err < best.err) best = { conv: conv, err: err };
    }
    return best;
  }

  /* Choisit la représentation d'angles la plus proche de la précédente (évite les sauts de 360°). */
  function unwrap(prev, cur) {
    if (!prev) return cur;
    return cur.map(function (v, i) {
      while (v - prev[i] > 180) v -= 360;
      while (v - prev[i] < -180) v += 360;
      return v;
    });
  }

  /* Deuxième solution d'Euler équivalente (b -> 180-b) ; on garde celle qui saute le moins. */
  function alternateEuler(deg, conv) {
    var i = conv.order[0], j = conv.order[1], k = conv.order[2];
    var raw = [0, 0, 0];
    for (var t = 0; t < 3; t++) raw[t] = deg[t] * conv.signs[t];
    var alt = raw.slice();
    alt[i] = raw[i] + 180; alt[j] = 180 - raw[j]; alt[k] = raw[k] + 180;
    return alt.map(function (v, t) { return v * conv.signs[t]; });
  }

  function continuousEuler(prev, M, conv) {
    var e1 = matrixToEuler(M, conv);
    if (!prev) return e1;
    var a = unwrap(prev, e1), b = unwrap(prev, alternateEuler(e1, conv));
    function dist(x) { return Math.abs(x[0] - prev[0]) + Math.abs(x[1] - prev[1]) + Math.abs(x[2] - prev[2]); }
    return dist(a) <= dist(b) ? a : b;
  }

  /* Les 24 rotations "à angle droit" (symétries du cube), pour le repère parent. */
  function rightAngleRotations() {
    var out = [], seen = {}, q = Math.PI / 2;
    for (var a = 0; a < 4; a++) for (var b = 0; b < 4; b++) for (var c = 0; c < 4; c++) {
      var M = mul(axisRot(2, c * q), mul(axisRot(1, b * q), axisRot(0, a * q)));
      M = M.map(function (r) { return r.map(function (v) { return Math.round(v); }); });
      var key = JSON.stringify(M);
      if (!seen[key]) { seen[key] = 1; out.push(M); }
    }
    return out;
  }

  /* Marge au blocage de cardan : min sur toutes les frames de |cos(angle du milieu)| (1 = parfait, 0 = bloqué). */
  function gimbalMargin(Rs, C, conv) {
    var Ct = transpose(C), m = 1;
    var i = conv.order[0], j = conv.order[1], k = conv.order[2], sg = parity(conv.order);
    for (var f = 0; f < Rs.length; f++) {
      var M = mul(Ct, Rs[f]);
      var sb = Math.max(-1, Math.min(1, -sg * M[k][i]));
      m = Math.min(m, Math.sqrt(1 - sb * sb));
    }
    return m;
  }

  /*
   * Convertit des poses (repère caméra) en keyframes AE pour un null 3D (ancrage 0, échelle 100 %),
   * avec une caméra one-node fixe au centre de la comp, à z = -zoom, sans rotation.
   * Si les rotations passeraient près du blocage de cardan, on choisit un repère parent tourné
   * d'angles droits (C) : monde = C * local, donc local = Cᵀ * monde.
   * poses : [{rvec, tvec}] ; renvoie {positions, rotations, parentRotation (ou null), margin}
   */
  function toAEKeys(poses, conv, W, H, zoom) {
    var Rs = poses.map(function (p) { return rodrigues(p.rvec); });
    var I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], C = I, margin = gimbalMargin(Rs, I, conv);
    if (margin < 0.35) {
      rightAngleRotations().forEach(function (cand) {
        var m = gimbalMargin(Rs, cand, conv);
        if (m > margin + 1e-9) { margin = m; C = cand; }
      });
    }
    var Ct = transpose(C), prev = null, positions = [], rotations = [];
    for (var f = 0; f < poses.length; f++) {
      var t = poses[f].tvec, w = [t[0] + W / 2, t[1] + H / 2, t[2] - zoom];
      positions.push([0, 1, 2].map(function (r) { return Ct[r][0] * w[0] + Ct[r][1] * w[1] + Ct[r][2] * w[2]; }));
      prev = continuousEuler(prev, mul(Ct, Rs[f]), conv);
      rotations.push(prev.slice());
    }
    var round = function (a) { return a.map(function (v) { return Math.round(v * 1e4) / 1e4; }); };
    return {
      positions: positions.map(round), rotations: rotations.map(round),
      parentRotation: C === I ? null : round(matrixToEuler(C, conv)), margin: margin
    };
  }

  /* Focale équivalente 24x36 (mm) -> Zoom AE (px), et inverse. */
  function zoomFromFocal(focalMm, compWidth) { return compWidth * focalMm / 36; }
  function focalFromZoom(zoom, compWidth) { return zoom * 36 / compWidth; }

  return {
    rodrigues: rodrigues, matToRvec: matToRvec, mul: mul, transpose: transpose, axisRot: axisRot,
    project: project, projectAll: projectAll, solvePins: solvePins, solvePinsGlobal: solvePinsGlobal, orbit: orbit,
    eulerToMatrix: eulerToMatrix, matrixToEuler: matrixToEuler, detectConvention: detectConvention,
    continuousEuler: continuousEuler, unwrap: unwrap, ORDERS: ORDERS, toAEKeys: toAEKeys,
    zoomFromFocal: zoomFromFocal, focalFromZoom: focalFromZoom
  };
});
