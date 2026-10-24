#!/usr/bin/env python3
"""
Gragarda GeoTrack — moteur de tracking d'objet rigide (mesh) pour After Effects.

Principe (même famille que KeenTools GeoTracker) :
  1. Aux keyframes, l'utilisateur aligne le mesh sur l'objet avec des pins (dans le panneau AE).
  2. On détecte des points d'intérêt sur l'objet et on les "colle" sur la surface du mesh
     grâce à la pose connue -> correspondances 2D/3D.
  3. Image par image : flux optique Lucas-Kanade (vérif aller-retour) + ancrages SIFT
     recherchés dans les images des keyframes (3D exacte, donc sans dérive).
     Pose résolue par PnP RANSAC puis raffinée (Levenberg-Marquardt).
  4. Entre deux keyframes on tracke en avant ET en arrière, puis on mélange (slerp).

Conventions (identiques à AE) : x vers la droite, y vers le bas, z qui s'éloigne de la caméra,
unités = pixels de comp. Les poses sont exprimées dans le repère caméra :
  point_camera = R(rvec) @ point_mesh + tvec
avec une caméra AE "one-node" non tournée, focale (px) = Zoom, centre optique = centre de comp.

Deux modes :
  python3 geotrack.py serve          -> serveur JSON-lines sur stdin/stdout (utilisé par le panneau)
  python3 geotrack.py track --job job.json --out out.json   -> une passe en ligne de commande

Dépendances : numpy, opencv-python (>= 4.5, SIFT inclus).
"""
import argparse
import json
import math
import os
import sys
import tempfile
import traceback

import cv2
import numpy as np

_PROGRESS_ID = None


def progress(p, msg=""):
    if _PROGRESS_ID is not None:
        emit({"id": _PROGRESS_ID, "progress": round(float(p), 4), "msg": msg})
    else:
        print(f"PROGRESS {p:.3f} {msg}", file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# ---------- rotations ----------
def rot_ae(xdeg, ydeg, zdeg):
    """R = Rz @ Ry @ Rx (utilisé par les tests ; le panneau détecte la vraie convention d'AE)."""
    x, y, z = map(math.radians, (xdeg, ydeg, zdeg))
    Rx = np.array([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    Rz = np.array([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def mat_to_quat(R):
    q = np.empty(4)
    t = np.trace(R)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q[:] = [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    else:
        i = int(np.argmax(np.diag(R)))
        if i == 0:
            s = math.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
            q[:] = [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
        elif i == 1:
            s = math.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
            q[:] = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
        else:
            s = math.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
            q[:] = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
    return q / np.linalg.norm(q)


def quat_to_mat(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def slerp(q0, q1, w):
    d = float(np.dot(q0, q1))
    if d < 0:
        q1, d = -q1, -d
    if d > 0.9995:
        q = q0 + w * (q1 - q0)
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - w) * th) * q0 + math.sin(w * th) * q1) / math.sin(th)


def rt_to_R(rvec):
    R, _ = cv2.Rodrigues(np.asarray(rvec, np.float64).reshape(3, 1))
    return R


def R_to_rvec(R):
    r, _ = cv2.Rodrigues(np.asarray(R, np.float64))
    return r.reshape(3, 1)


# ---------- vidéo ----------
class Footage:
    """Lit la vidéo source et la replace dans l'espace de la comp (échelle + décalage du calque AE)."""

    def __init__(self, spec, max_width=1280):
        self.path = spec["path"]
        self.comp_w, self.comp_h = spec["compWidth"], spec["compHeight"]
        self.ds = min(1.0, max_width / self.comp_w)
        # transformation footage(px source) -> comp(px) : comp = s * src + offset
        self.s = float(spec.get("layerScale", 1.0))
        self.ox, self.oy = spec.get("layerOffset", [0.0, 0.0])
        self.size = (int(round(self.comp_w * self.ds)), int(round(self.comp_h * self.ds)))
        self.M = np.array([[self.s * self.ds, 0, self.ox * self.ds],
                           [0, self.s * self.ds, self.oy * self.ds]], np.float64)
        self.cap = cv2.VideoCapture(self.path)
        if not self.cap.isOpened():
            raise RuntimeError(f"Impossible d'ouvrir la vidéo : {self.path}")
        self.count = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self._pos = 0

    def K(self, zoom):
        d = self.ds
        return np.array([[zoom * d, 0, self.comp_w * d / 2], [0, zoom * d, self.comp_h * d / 2], [0, 0, 1]],
                        np.float64)

    def _to_comp(self, img):
        return cv2.warpAffine(img, self.M, self.size, flags=cv2.INTER_AREA, borderMode=cv2.BORDER_CONSTANT)

    def read(self, i):
        if i != self._pos:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, img = self.cap.read()
        self._pos = i + 1 if ok else -1
        if not ok:
            return None
        return self._to_comp(img)

    def read_range(self, f0, f1, p0=0.0, p1=0.05):
        frames = {}
        f1 = min(f1, self.count - 1) if self.count > 0 else f1
        n = max(1, f1 - f0)
        for i in range(f0, f1 + 1):
            img = self.read(i)
            if img is None:
                break
            frames[i] = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            if (i - f0) % 25 == 0:
                progress(p0 + (p1 - p0) * (i - f0) / n, "lecture de la vidéo")
        return frames

    def close(self):
        self.cap.release()


# ---------- mesh ----------
def read_obj(path):
    V, F = [], []
    with open(path, "r", errors="ignore") as fh:
        for line in fh:
            if line.startswith("v "):
                V.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("f "):
                idx = [int(tok.split("/")[0]) for tok in line.split()[1:]]
                idx = [i - 1 if i > 0 else len(V) + i for i in idx]
                for k in range(1, len(idx) - 1):  # triangulation en éventail
                    F.append([idx[0], idx[k], idx[k + 1]])
    if not V or not F:
        raise RuntimeError("Mesh vide ou illisible (format accepté : .obj avec des faces)")
    return np.array(V, np.float64), np.array(F, np.int64)


def sample_surface(V, F, n, seed=0):
    rng = np.random.default_rng(seed)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    if area.sum() <= 0:
        return V.copy()
    tri = rng.choice(len(F), n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    return a[tri] + u[:, None] * (b[tri] - a[tri]) + v[:, None] * (c[tri] - a[tri])


def mesh_transform(V, spec):
    """OBJ (Y vers le haut, en général) -> espace AE (Y vers le bas), recentré et mis à l'échelle en px."""
    A = np.diag([1.0, -1.0, -1.0]) if spec.get("flipYZ", True) else np.eye(3)
    center = np.asarray(spec["center"], np.float64)
    return ((V - center) @ A.T) * float(spec["scale"])


def mesh_info(path, target_size, flip_yz=True, max_edges=12000, n_pick=30000):
    """Prépare le mesh pour le panneau : échelle auto (plus grande dimension = target_size px),
    sommets + arêtes allégées pour le fil de fer, et points répartis sur la surface pour poser des pins."""
    V, F = read_obj(path)
    lo, hi = V.min(0), V.max(0)
    center = (lo + hi) / 2
    extent = float(np.max(hi - lo)) or 1.0
    spec = {"path": path, "center": center.tolist(), "scale": target_size / extent, "flipYZ": flip_yz}
    Vt = mesh_transform(V, spec)
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    edges = np.unique(np.sort(e, axis=1), axis=0)
    rng = np.random.default_rng(0)
    if len(edges) > max_edges:
        edges = edges[rng.choice(len(edges), max_edges, replace=False)]
    used = np.unique(edges.ravel())
    remap = -np.ones(len(Vt), np.int64)
    remap[used] = np.arange(len(used))
    # points de pin : sommets (coins, arêtes vives) + échantillons uniformes sur les faces
    n_v = min(len(Vt), n_pick // 2)
    pv = Vt if len(Vt) == n_v else Vt[rng.choice(len(Vt), n_v, replace=False)]
    ps = mesh_transform(sample_surface(V, F, n_pick - n_v, seed=3), spec)
    return {
        "spec": spec,
        "vertices": np.round(Vt[used], 3).tolist(),
        "edges": remap[edges].tolist(),
        "pickPoints": np.round(np.vstack([pv, ps]), 3).tolist(),
        "nVerts": int(len(V)), "nFaces": int(len(F)),
    }


def load_mesh_points(spec, n_samples=80000, max_pts=150000):
    V, F = read_obj(spec["path"])
    Vt = mesh_transform(V, spec)
    S = mesh_transform(sample_surface(V, F, n_samples), spec)
    pts = np.vstack([Vt, S])
    if len(pts) > max_pts:
        pts = pts[np.random.default_rng(1).choice(len(pts), max_pts, replace=False)]
    hull = Vt if len(Vt) <= 20000 else Vt[np.random.default_rng(2).choice(len(Vt), 20000, replace=False)]
    return pts.astype(np.float64), hull


# ---------- correspondances 2D/3D ----------
def visible_points(pts3, rvec, tvec, K, size, cell=3):
    W, H = size
    R = rt_to_R(rvec)
    pc = pts3 @ R.T + np.asarray(tvec).ravel()
    z = pc[:, 2]
    front = z > 1e-3
    uv = (pc[:, :2] / np.maximum(z, 1e-3)[:, None]) * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]
    inside = front & (uv[:, 0] >= 0) & (uv[:, 0] < W) & (uv[:, 1] >= 0) & (uv[:, 1] < H)
    idx = np.nonzero(inside)[0]
    if len(idx) == 0:
        return np.empty((0, 2)), np.empty((0, 3))
    gx = (uv[idx, 0] // cell).astype(np.int64)
    gy = (uv[idx, 1] // cell).astype(np.int64)
    key = gy * (W // cell + 2) + gx
    zi = z[idx]
    # z-buffer vectorisé : profondeur minimale par cellule
    order = np.lexsort((zi, key))
    k_sorted = key[order]
    first = np.ones(len(order), bool)
    first[1:] = k_sorted[1:] != k_sorted[:-1]
    cells, cell_start = k_sorted[first], np.nonzero(first)[0]
    zmin_sorted = zi[order][cell_start]
    pos = np.searchsorted(cells, key)
    zmin = zmin_sorted[pos]
    vis = zi <= zmin * 1.02 + 2.0
    sel = idx[vis]
    return uv[sel], pts3[sel]


def _nearest_surface(feats, uv, p3, tol=2.0):
    out2, out3, keep = [], [], []
    for chunk_i in np.array_split(np.arange(len(feats)), max(1, len(feats) // 100)):
        d = np.linalg.norm(feats[chunk_i, None, :] - uv[None, :, :], axis=2)
        j = np.argmin(d, axis=1)
        ok = d[np.arange(len(chunk_i)), j] < tol
        out2.append(feats[chunk_i][ok])
        out3.append(p3[j[ok]])
        keep.extend(chunk_i[ok])
    if not keep:
        return np.empty((0, 2)), np.empty((0, 3)), np.array([], int)
    return np.vstack(out2), np.vstack(out3), np.array(keep, int)


def object_mask(gray, uv):
    mask = np.zeros(gray.shape, np.uint8)
    for u, v in uv.astype(int)[::3]:
        cv2.circle(mask, (int(u), int(v)), 3, 255, -1)
    return cv2.erode(mask, np.ones((5, 5), np.uint8))  # évite les bords (fond)


def seed(gray, rvec, tvec, K, size, pts3, max_pts=900):
    uv, p3 = visible_points(pts3, rvec, tvec, K, size)
    if len(uv) < 10:
        return np.empty((0, 1, 2), np.float32), np.empty((0, 3))
    feats = cv2.goodFeaturesToTrack(gray, max_pts, 0.005, 6, mask=object_mask(gray, uv))
    if feats is None:
        return np.empty((0, 1, 2), np.float32), np.empty((0, 3))
    p2, p3s, _ = _nearest_surface(feats.reshape(-1, 2), uv, p3)
    return p2.astype(np.float32).reshape(-1, 1, 2), p3s


LK = dict(winSize=(21, 21), maxLevel=4,
          criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))

_SIFT = cv2.SIFT_create(nfeatures=3000)
_BF = cv2.BFMatcher(cv2.NORM_L2)


def object_roi(rvec, tvec, K, size, hull, margin=0.25):
    W, H = size
    pv, _ = cv2.projectPoints(hull, rvec, tvec, K, None)
    pv = pv.reshape(-1, 2)
    pv = pv[np.isfinite(pv).all(1)]
    m = np.zeros((H, W), np.uint8)
    if len(pv) == 0:
        return m
    x0, y0 = pv.min(0)
    x1, y1 = pv.max(0)
    mx, my = (x1 - x0) * margin + 10, (y1 - y0) * margin + 10
    x0, x1 = int(max(0, x0 - mx)), int(min(W, x1 + mx))
    y0, y1 = int(max(0, y0 - my)), int(min(H, y1 + my))
    if x1 > x0 and y1 > y0:
        m[y0:y1, x0:x1] = 255
    return m


def build_anchor(gray, rvec, tvec, K, size, pts3):
    """Points SIFT d'une keyframe, rattachés à la surface du mesh (3D exacte, sans dérive)."""
    uv, p3 = visible_points(pts3, rvec, tvec, K, size)
    if len(uv) < 10:
        return None
    kps, desc = _SIFT.detectAndCompute(gray, object_mask(gray, uv))
    if desc is None or len(kps) < 8:
        return None
    k2 = np.array([kp.pt for kp in kps], np.float64)
    _, k3, keep = _nearest_surface(k2, uv, p3)
    if len(keep) < 8:
        return None
    return {"desc": desc[keep], "p3": k3}


def anchor_matches(gray, roi, anchors):
    empty = (np.empty((0, 2), np.float32), np.empty((0, 3)))
    if not anchors:
        return empty
    kps, desc = _SIFT.detectAndCompute(gray, roi)
    if desc is None or len(kps) < 8:
        return empty
    pts = np.array([kp.pt for kp in kps], np.float32)
    o2, o3 = [], []
    for an in anchors:
        for m in _BF.knnMatch(desc, an["desc"], k=2):
            if len(m) == 2 and m[0].distance < 0.75 * m[1].distance:
                o2.append(pts[m[0].queryIdx])
                o3.append(an["p3"][m[0].trainIdx])
    if not o2:
        return empty
    return np.array(o2, np.float32), np.array(o3, np.float64)


def merge_points(p2, p3, n2, n3, min_dist=5.0, cap=1200):
    """Garde les points suivis existants et ajoute les nouveaux qui ne les doublonnent pas."""
    if len(p2) == 0:
        return n2, n3
    if len(n2) == 0:
        return p2, p3
    a, b = p2.reshape(-1, 2), n2.reshape(-1, 2)
    keep = []
    for chunk_i in np.array_split(np.arange(len(b)), max(1, len(b) // 200)):
        d = np.linalg.norm(b[chunk_i, None, :] - a[None, :, :], axis=2).min(1)
        keep.extend(chunk_i[d > min_dist])
    keep = np.array(keep, int)
    p2 = np.vstack([a, b[keep]])[:cap].astype(np.float32).reshape(-1, 1, 2)
    p3 = np.vstack([p3, n3[keep]])[:cap]
    return p2, p3


def track(seq, frames, rvec, tvec, K, size, pts3, hull, anchors=None,
          reseed_every=6, min_pts=60):
    """Tracke de seq[0] (pose connue) vers les frames suivantes de seq. Retourne {frame: (rvec, tvec, qualité)}."""
    rvec = np.asarray(rvec, np.float64).reshape(3, 1)
    tvec = np.asarray(tvec, np.float64).reshape(3, 1)
    out = {seq[0]: (rvec.copy(), tvec.copy(), 1.0)}
    prev = frames[seq[0]]
    p2, p3 = seed(prev, rvec, tvec, K, size, pts3)
    vel_r = np.zeros((3, 1))
    vel_t = np.zeros((3, 1))
    for step, i in enumerate(seq[1:], 1):
        cur = frames.get(i)
        if cur is None:
            break
        # 1) points suivis par flux optique (vérification aller-retour)
        if len(p2):
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, p2, None, **LK)
            back, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, nxt, None, **LK)
            fb = np.linalg.norm((p2 - back).reshape(-1, 2), axis=1)
            good = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < 1.0)
            f2, f3 = nxt[good].reshape(-1, 2), p3[good]
        else:
            f2, f3 = np.empty((0, 2), np.float32), np.empty((0, 3))
        # 2) ancrages SIFT vers les keyframes (3D exacte -> pas de dérive)
        guess_r, guess_t = rvec + vel_r, tvec + vel_t
        a2, a3 = (np.empty((0, 2), np.float32), np.empty((0, 3)))
        if anchors:
            a2, a3 = anchor_matches(cur, object_roi(guess_r, guess_t, K, size, hull), anchors)
        all2 = np.vstack([f2, a2]).astype(np.float32)
        all3 = np.vstack([f3, a3])
        if len(all2) < 8:
            break
        ok, r, t, inl = cv2.solvePnPRansac(
            all3, all2, K, None, guess_r.copy(), guess_t.copy(), True, 400, 2.5, 0.999,
            flags=cv2.SOLVEPNP_ITERATIVE)
        if not ok or inl is None or len(inl) < 8:
            break
        inl = inl.ravel()
        r, t = cv2.solvePnPRefineLM(all3[inl], all2[inl], K, None, r, t)
        if np.linalg.norm(r - rvec) > 0.6:  # saut aberrant : on s'arrête plutôt que d'inventer
            break
        vel_r, vel_t = r - rvec, t - tvec
        rvec, tvec = r, t
        n_flow = len(f2)
        inl_flow = inl[inl < n_flow]
        out[i] = (rvec.copy(), tvec.copy(), len(inl) / len(all2))
        p2 = f2[inl_flow].reshape(-1, 1, 2).astype(np.float32)
        p3 = f3[inl_flow]
        prev = cur
        if len(p2) < min_pts or step % reseed_every == 0:
            n2, n3 = seed(cur, rvec, tvec, K, size, pts3)
            p2, p3 = merge_points(p2, p3, n2, n3)
    return out


def blend(a_, b_, w):
    q = slerp(mat_to_quat(rt_to_R(a_[0])), mat_to_quat(rt_to_R(b_[0])), w)
    t = (1 - w) * a_[1] + w * b_[1]
    return R_to_rvec(quat_to_mat(q)), t, min(a_[2], b_[2])


def run_track(job, footage=None):
    """job : {footage:{...}, zoom, mesh:{path,center,scale,flipYZ}, keyframes:[{frame,rvec,tvec}],
              range:[f0,f1], maxWidth}. Les tvec sont en px de comp (pleine résolution)."""
    own = footage is None
    if own:
        footage = Footage(job["footage"], job.get("maxWidth", 1280))
    try:
        K = footage.K(job["zoom"])
        size = footage.size
        kfs = sorted(job["keyframes"], key=lambda k: k["frame"])
        if not kfs:
            raise RuntimeError("Il faut au moins une keyframe alignée.")
        kf_frames = [int(k["frame"]) for k in kfs]
        poses = [(np.array(k["rvec"], np.float64).reshape(3, 1),
                  np.array(k["tvec"], np.float64).reshape(3, 1) * footage.ds) for k in kfs]
        f_lo, f_hi = job.get("range", [kf_frames[0], kf_frames[-1]])
        f_lo, f_hi = int(min(f_lo, kf_frames[0])), int(max(f_hi, kf_frames[-1]))
        progress(0.0, "chargement du mesh")
        pts3, hull = load_mesh_points(job["mesh"])
        pts3 = pts3 * footage.ds  # le mesh est en px de comp ; on travaille à la résolution réduite
        hull = hull * footage.ds
        frames = footage.read_range(f_lo, f_hi)
        if not frames:
            raise RuntimeError("Aucune image lisible dans la plage demandée.")
        f_hi = max(frames)
        anchors = []
        for f, (r, t) in zip(kf_frames, poses):
            if f in frames:
                an = build_anchor(frames[f], r, t, K, size, pts3)
                if an is not None:
                    anchors.append(an)
        progress(0.06, f"{len(anchors)} keyframe(s) d'ancrage")

        result = {}
        n_seg, seg = len(kfs) + 1, 0

        def step_done(label):
            nonlocal seg
            seg += 1
            progress(0.06 + 0.92 * seg / n_seg, label)

        if kf_frames[0] > f_lo:
            for f, v in track(list(range(kf_frames[0], f_lo - 1, -1)), frames, *poses[0], K, size,
                              pts3, hull, anchors).items():
                result[f] = v
        step_done("tracking avant la 1re keyframe")

        for j in range(len(kfs) - 1):
            fa, fb = kf_frames[j], kf_frames[j + 1]
            if fa not in frames or fb not in frames:
                continue
            fwd = track(list(range(fa, fb + 1)), frames, *poses[j], K, size, pts3, hull, anchors)
            bwd = track(list(range(fb, fa - 1, -1)), frames, *poses[j + 1], K, size, pts3, hull, anchors)
            for f in range(fa, fb + 1):
                w = (f - fa) / max(1, fb - fa)
                a_, b_ = fwd.get(f), bwd.get(f)
                if a_ and b_:
                    result[f] = blend(a_, b_, w)
                elif a_ or b_:
                    p = a_ or b_
                    result[f] = (p[0], p[1], p[2] * 0.5)
            step_done(f"segment {j + 1}/{len(kfs) - 1}")

        if kf_frames[-1] < f_hi:
            for f, v in track(list(range(kf_frames[-1], f_hi + 1)), frames, *poses[-1], K, size,
                              pts3, hull, anchors).items():
                result[f] = v
        for f, (r, t) in zip(kf_frames, poses):  # les keyframes restent exactement là où on les a mises
            if f in frames:
                result[f] = (r, t, 1.0)

        out = [{"frame": int(f), "rvec": result[f][0].ravel().tolist(),
                "tvec": (result[f][1].ravel() / footage.ds).tolist(),
                "quality": round(float(result[f][2]), 3)} for f in sorted(result)]
        lost = [int(f) for f in sorted(frames) if f not in result]
        progress(1.0, "terminé")
        return {"frames": out, "lost": lost}
    finally:
        if own:
            footage.close()


# ---------- serveur pour le panneau ----------
def serve():
    global _PROGRESS_ID
    tmpdir = tempfile.mkdtemp(prefix="geotrack_")
    footage, footage_key = None, None
    emit({"ready": True, "opencv": cv2.__version__, "python": sys.version.split()[0]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        _PROGRESS_ID = rid
        try:
            cmd = req["cmd"]
            if cmd in ("frame", "track", "info"):
                spec = req["footage"]
                key = json.dumps(spec, sort_keys=True) + str(req.get("maxWidth", 1280))
                if key != footage_key:
                    if footage:
                        footage.close()
                    footage, footage_key = Footage(spec, req.get("maxWidth", 1280)), key
            if cmd == "ping":
                res = {"pong": True}
            elif cmd == "info":
                res = {"frameCount": footage.count, "size": footage.size, "ds": footage.ds}
            elif cmd == "frame":
                img = footage.read(int(req["frame"]))
                if img is None:
                    raise RuntimeError(f"Frame {req['frame']} illisible")
                slot = rid % 4 if isinstance(rid, int) else 0  # rotation de fichiers : pas de cache navigateur périmé
                path = os.path.join(tmpdir, f"frame_{slot}.jpg")
                cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 88])
                res = {"path": path, "width": img.shape[1], "height": img.shape[0], "ds": footage.ds}
            elif cmd == "mesh":
                res = mesh_info(req["path"], float(req["targetSize"]), req.get("flipYZ", True))
            elif cmd == "track":
                res = run_track(req, footage)
            elif cmd == "quit":
                emit({"id": rid, "ok": True, "result": {}})
                break
            else:
                raise RuntimeError(f"commande inconnue : {cmd}")
            emit({"id": rid, "ok": True, "result": res})
        except Exception as e:  # on renvoie l'erreur au panneau au lieu de mourir
            emit({"id": rid, "ok": False, "error": str(e), "trace": traceback.format_exc()[-1500:]})
        finally:
            _PROGRESS_ID = None
    if footage:
        footage.close()


def main():
    ap = argparse.ArgumentParser(description="Gragarda GeoTrack backend")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    t = sub.add_parser("track")
    t.add_argument("--job", required=True)
    t.add_argument("--out", required=True)
    m = sub.add_parser("mesh")
    m.add_argument("--obj", required=True)
    m.add_argument("--size", type=float, default=540)
    a = ap.parse_args()
    if a.cmd == "serve":
        serve()
    elif a.cmd == "track":
        res = run_track(json.load(open(a.job)))
        json.dump(res, open(a.out, "w"))
        print("DONE", flush=True)
    elif a.cmd == "mesh":
        info = mesh_info(a.obj, a.size)
        print(json.dumps({k: info[k] for k in ("spec", "nVerts", "nFaces")}))


if __name__ == "__main__":
    main()
