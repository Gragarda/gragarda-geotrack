"""Vidéo de synthèse partagée par les tests : un cube texturé à trajectoire connue.

La vidéo est rendue en 1920x1080 et destinée à une comp 1280x720 (calque à 66,67 %).
pose(i) renvoie la vérité terrain (R, t) dans le repère caméra, en px de comp.
"""
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import geotrack as g  # noqa: E402

W, H, FPS, N = 1280, 720, 25, 75
VW, VH = 1920, 1080
ZOOM = 1400.0
SIDE = 100.0  # demi-côté du cube (px)
V = np.array([[x, y, z] for x in (-SIDE, SIDE) for y in (-SIDE, SIDE) for z in (-SIDE, SIDE)])
FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]


def pose(i):
    t = i / FPS
    R = g.rot_ae(20 * math.sin(t * 1.3), 40 * t, 10 * math.sin(t))
    tv = np.array([200 * math.sin(t * 0.9), 60 * math.cos(t * 1.1), ZOOM + 300 + 150 * math.sin(t * 0.5)])
    return R, tv


def project(R, t, X, zoom=ZOOM):
    pc = X @ R.T + t
    return pc[:, :2] / pc[:, 2:3] * zoom + [W / 2, H / 2]


def visible_vertices(i):
    """Indices des sommets appartenant à une face tournée vers la caméra."""
    R, t = pose(i)
    pc = V @ R.T + t
    vis = set()
    for f in FACES:
        n = np.cross(pc[f[1]] - pc[f[0]], pc[f[2]] - pc[f[0]])
        if np.dot(n, pc[f].mean(0)) < 0:
            vis.update(f)
    return sorted(vis)


def make_clip(tmp):
    with open(os.path.join(tmp, "cube.obj"), "w") as fh:
        for v in V:
            fh.write(f"v {v[0]} {-v[1]} {-v[2]}\n")  # stocké Y vers le haut comme un vrai OBJ
        for f in FACES:
            fh.write("f " + " ".join(str(i + 1) for i in f) + "\n")
    rng = np.random.default_rng(1)
    tex = [cv2.GaussianBlur((rng.random((256, 256, 3)) * 255).astype(np.uint8), (0, 0), 1.5) for _ in FACES]
    bg = cv2.GaussianBlur((rng.random((H, W, 3)) * 255).astype(np.uint8), (0, 0), 6)
    vw = cv2.VideoWriter(os.path.join(tmp, "clip.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (VW, VH))
    for i in range(N):
        R, tv = pose(i)
        pc = V @ R.T + tv
        uv = project(R, tv, V)
        img = bg.copy()
        for k in sorted(range(6), key=lambda k: -pc[FACES[k], 2].mean()):
            f = FACES[k]
            n = np.cross(pc[f[1]] - pc[f[0]], pc[f[2]] - pc[f[0]])
            if np.dot(n, pc[f].mean(0)) >= 0:
                continue
            dst = uv[f].astype(np.float32)
            M = cv2.getPerspectiveTransform(np.float32([[0, 0], [255, 0], [255, 255], [0, 255]]), dst)
            warped = cv2.warpPerspective(tex[k], M, (W, H))
            m = np.zeros((H, W), np.uint8)
            cv2.fillConvexPoly(m, dst.astype(np.int32), 255)
            img[m > 0] = warped[m > 0]
        vw.write(cv2.resize(img, (VW, VH), interpolation=cv2.INTER_CUBIC))
    vw.release()
    return {"clip": os.path.join(tmp, "clip.mp4"), "obj": os.path.join(tmp, "cube.obj")}
