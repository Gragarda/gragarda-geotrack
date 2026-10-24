// Tests des maths du panneau : node tests/pose.test.js  (code de sortie 0 = OK)
'use strict';
const P = require('../extension/js/pose.js');
const { execFileSync } = require('child_process');
const path = require('path');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'OK   ' : 'ECHEC') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
}
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function maxDiff(A, B) { let m = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m = Math.max(m, Math.abs(A[i][j] - B[i][j])); return m; }

// 1) Rodrigues aller-retour
{
  let worst = 0;
  for (let n = 0; n < 500; n++) {
    const r = [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3];
    const th = Math.hypot(...r); if (th > Math.PI - 0.01) continue;
    const back = P.matToRvec(P.rodrigues(r));
    worst = Math.max(worst, Math.abs(back[0] - r[0]), Math.abs(back[1] - r[1]), Math.abs(back[2] - r[2]));
  }
  check('Rodrigues aller-retour', worst < 1e-9, 'écart max ' + worst.toExponential(2));
}

// 2) même Rodrigues que OpenCV (backend Python)
try {
  const rs = [[0.3, -1.2, 0.7], [2.0, 0.1, -0.4], [0, 0, 1e-8]];
  const py = `import cv2,json,numpy as np\nprint(json.dumps([cv2.Rodrigues(np.array(r,float))[0].tolist() for r in ${JSON.stringify(rs)}]))`;
  const ref = JSON.parse(execFileSync('python3', ['-c', py]).toString());
  const d = Math.max(...rs.map((r, i) => maxDiff(P.rodrigues(r), ref[i])));
  check('Rodrigues identique à OpenCV', d < 1e-9, 'écart max ' + d.toExponential(2));
} catch (e) { console.log('(saut) OpenCV indisponible pour la comparaison : ' + e.message.split('\n')[0]); }

// 3) Euler <-> matrice pour les 48 conventions possibles
{
  let worst = 0;
  for (const order of P.ORDERS) for (let s = 0; s < 8; s++) {
    const conv = { order, signs: [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1] };
    for (let n = 0; n < 50; n++) {
      const e = [rnd() * 340 - 170, rnd() * 170 - 85, rnd() * 340 - 170];
      const M = P.eulerToMatrix(e, conv);
      const M2 = P.eulerToMatrix(P.matrixToEuler(M, conv), conv);
      worst = Math.max(worst, maxDiff(M, M2));
    }
  }
  check('Euler <-> matrice (48 conventions)', worst < 1e-9, 'écart max ' + worst.toExponential(2));
}

// 4) détection de convention à partir d'une mesure
{
  const test = [30, 40, 50];
  let ok = true;
  for (const order of P.ORDERS) for (let s = 0; s < 8; s++) {
    const conv = { order, signs: [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1] };
    const found = P.detectConvention(P.eulerToMatrix(test, conv), test);
    if (found.err > 1e-9 || maxDiff(P.eulerToMatrix([11, -22, 33], found.conv), P.eulerToMatrix([11, -22, 33], conv)) > 1e-9) ok = false;
  }
  check('Détection de la convention de rotation AE', ok);
}

// 5) pins : retrouver une pose connue
{
  const cam = { f: 1400, cx: 640, cy: 360 };
  const verts = [];
  for (let n = 0; n < 200; n++) verts.push([rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100]);
  const truthR = [0.4, -0.7, 0.2], truthT = [80, -30, 1600];
  const R = P.rodrigues(truthR);
  const idx = [3, 50, 99, 150, 180, 7];
  const pins = idx.map(i => { const p = P.project(R, truthT, verts[i], cam); return { X: verts[i], target: [p[0], p[1]] }; });
  const sol = P.solvePins(pins, [0.1, -0.2, 0], [0, 0, 1500], cam);
  const dR = maxDiff(P.rodrigues(sol.rvec), R);
  check('Pins (6) : pose retrouvée', sol.error < 0.05 && dR < 1e-3, `erreur pins ${sol.error.toFixed(4)} px, écart rotation ${dR.toExponential(2)}`);
  const one = P.solvePins([{ X: verts[3], target: [700, 300] }], [0.1, -0.2, 0], [0, 0, 1500], cam);
  const pr = P.project(P.rodrigues(one.rvec), one.tvec, verts[3], cam);
  check('Pin unique : le point suit la souris', Math.hypot(pr[0] - 700, pr[1] - 300) < 0.5 && Math.abs(one.tvec[2] - 1500) < 1,
    `écart ${Math.hypot(pr[0] - 700, pr[1] - 300).toFixed(3)} px, profondeur ${one.tvec[2].toFixed(0)}`);
}

// 5b) deux pins : l'objet tourne dans le plan sans basculer en 3D
{
  const cam = { f: 1400, cx: 640, cy: 360 };
  const A = [-100, 0, 0], B = [100, 0, 0];
  const R0 = [0, 0, 0], T0 = [0, 0, 1400];
  const two = P.solvePins([{ X: A, target: [540, 260] }, { X: B, target: [740, 460] }], R0, T0, cam);
  const R = P.rodrigues(two.rvec);
  const pa = P.project(R, two.tvec, A, cam), pb = P.project(R, two.tvec, B, cam);
  const err = Math.hypot(pa[0] - 540, pa[1] - 260) + Math.hypot(pb[0] - 740, pb[1] - 460);
  check('Deux pins : rotation dans le plan + distance', err < 0.5 && Math.abs(R[2][0]) < 1e-3 && Math.abs(R[2][1]) < 1e-3,
    `écart ${err.toFixed(3)} px, roll ${(Math.atan2(R[1][0], R[0][0]) * 180 / Math.PI).toFixed(1)}°`);
}

// 5c) 4 pins coplanaires partant d'une pose très fausse : la recherche globale trouve la bonne
{
  const cam = { f: 1400, cx: 640, cy: 360 };
  const face = [[180, -180, -180], [180, -180, 180], [180, 180, -180], [180, 180, 180]];
  const truthR = P.rodrigues([0.05, 2.05, 0.12]), truthT = [150, 40, 1800];
  const pins = face.map(X => { const p = P.project(truthR, truthT, X, cam); return { X, target: [p[0], p[1]] }; });
  const local = P.solvePins(pins, [0, 1.1, 0], [140, 40, 1800], cam, { free: true });
  const glob = P.solvePinsGlobal(pins, [0, 1.1, 0], [140, 40, 1800], cam);
  check('4 pins coplanaires : recherche globale', glob.error < 0.05,
    `local ${local.error.toFixed(2)} px -> global ${glob.error.toFixed(4)} px`);
}

// 6) angles continus sur une rotation lente (pas de saut de 360°)
{
  const conv = { order: [0, 1, 2], signs: [1, 1, 1] };
  let prev = null, maxJump = 0;
  for (let i = 0; i < 400; i++) {
    const M = P.eulerToMatrix([10 * Math.sin(i / 30), i * 2, 5], conv);
    const e = P.continuousEuler(prev, M, conv);
    if (prev) maxJump = Math.max(maxJump, ...e.map((v, k) => Math.abs(v - prev[k])));
    prev = e;
  }
  // au passage du blocage de cardan (angle du milieu à ±90°) un petit saut est inévitable avec des Euler
  check('Angles continus sur 800° de rotation', maxJump < 10, 'saut max ' + maxJump.toFixed(2) + '°');
}

// 7) conversion vers AE : géométrie exacte, et repère parent quand on frôle le blocage de cardan
{
  const conv = { order: [0, 1, 2], signs: [1, 1, 1] };
  const W = 1280, H = 720, zoom = 1400;
  const poses = [];
  for (let i = 0; i < 120; i++) poses.push({ rvec: P.matToRvec(P.eulerToMatrix([10 * Math.sin(i / 20), i * 1.5, 5], conv)), tvec: [i, -i / 2, 1600 + i] });
  const k = P.toAEKeys(poses, conv, W, H, zoom);
  const C = k.parentRotation ? P.eulerToMatrix(k.parentRotation, conv) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let worst = 0, jump = 0;
  for (let i = 0; i < poses.length; i++) {
    const Rw = P.mul(C, P.eulerToMatrix(k.rotations[i], conv));
    const pw = [0, 1, 2].map(r => C[r][0] * k.positions[i][0] + C[r][1] * k.positions[i][1] + C[r][2] * k.positions[i][2]);
    const want = poses[i].tvec;
    worst = Math.max(worst, maxDiff(Rw, P.rodrigues(poses[i].rvec)),
      Math.abs(pw[0] - W / 2 - want[0]) / 1000, Math.abs(pw[1] - H / 2 - want[1]) / 1000, Math.abs(pw[2] + zoom - want[2]) / 1000);
    if (i) jump = Math.max(jump, ...k.rotations[i].map((v, a) => Math.abs(v - k.rotations[i - 1][a])));
  }
  check('Conversion AE exacte (avec repère parent)', worst < 1e-5 && !!k.parentRotation, 'écart ' + worst.toExponential(2) + ', parent ' + JSON.stringify(k.parentRotation));
  check('Conversion AE : pas de saut malgré 180° de rotation', jump < 3, 'saut max ' + jump.toFixed(2) + '°, marge ' + k.margin.toFixed(2));
  const calm = P.toAEKeys([{ rvec: [0.1, 0.2, 0], tvec: [0, 0, 1500] }], conv, W, H, zoom);
  check('Conversion AE : pas de parent quand inutile', calm.parentRotation === null);
}

console.log(failures ? `\n${failures} test(s) en échec` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
