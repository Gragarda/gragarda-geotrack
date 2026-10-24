/*
 * Gragarda GeoTrack — côté After Effects (ExtendScript).
 * Toutes les fonctions renvoient une chaîne JSON : {ok:true, ...} ou {ok:false, error:"..."}.
 */

function gt_str(v) {
    // JSON.stringify minimal (ExtendScript n'a pas toujours l'objet JSON)
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") {
        return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(gt_str(v[i]));
        return "[" + a.join(",") + "]";
    }
    var o = [];
    for (var k in v) if (v.hasOwnProperty(k)) o.push(gt_str(k) + ":" + gt_str(v[k]));
    return "{" + o.join(",") + "}";
}

function gt_ok(obj) { obj = obj || {}; obj.ok = true; return gt_str(obj); }
function gt_err(msg) { return gt_str({ ok: false, error: String(msg) }); }
function gt_parse(s) { return eval("(" + s + ")"); }

function gt_comp() {
    var c = app.project.activeItem;
    return (c && c instanceof CompItem) ? c : null;
}

function gt_findCompById(id) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.id === id) return it;
    }
    return null;
}

function gt_isAnimated(prop) { return prop && prop.numKeys > 0 || (prop && prop.expressionEnabled && prop.expression !== ""); }

function gt_activeCameraZoom(comp) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (L instanceof CameraLayer && L.enabled) {
            return L.property("ADBE Camera Options Group").property("ADBE Camera Zoom").value;
        }
    }
    return null;
}

/* Infos sur le calque vidéo sélectionné, et la façon dont il est posé dans la comp. */
function gt_getFootage() {
    try {
        var comp = gt_comp();
        if (!comp) return gt_err("Ouvre une composition et sélectionne le calque vidéo à tracker.");
        if (comp.selectedLayers.length !== 1) return gt_err("Sélectionne exactement un calque : la vidéo à tracker.");
        var L = comp.selectedLayers[0];
        if (!(L instanceof AVLayer) || !(L.source instanceof FootageItem) || !L.source.file) {
            return gt_err("Le calque sélectionné doit être une vidéo importée (pas une précomp, un solide ou un texte).");
        }
        var src = L.source, warnings = [];
        if (src.mainSource.isStill) return gt_err("Le calque sélectionné est une image fixe, pas une vidéo.");
        var tr = L.property("ADBE Transform Group");
        var pos = tr.property("ADBE Position").value;
        var anc = tr.property("ADBE Anchor Point").value;
        var sc = tr.property("ADBE Scale").value;
        var rot = L.threeDLayer ? tr.property("ADBE Rotate Z").value : tr.property("ADBE Rotate Z").value;
        if (Math.abs(sc[0] - sc[1]) > 0.01) warnings.push("L'échelle X et Y du calque vidéo diffèrent : le tracking suppose une échelle uniforme.");
        if (Math.abs(rot) > 0.001) warnings.push("Le calque vidéo est tourné : remets sa rotation à 0.");
        if (L.threeDLayer) warnings.push("Le calque vidéo est en 3D : passe-le en 2D pour que la caméra GeoTrack ne le déforme pas.");
        if (gt_isAnimated(tr.property("ADBE Position")) || gt_isAnimated(tr.property("ADBE Scale"))) {
            warnings.push("La position ou l'échelle du calque vidéo est animée : seule la valeur au temps courant est utilisée.");
        }
        if (L.timeRemapEnabled) warnings.push("Le remappage temporel est actif : il n'est pas pris en compte.");
        if (Math.abs(L.stretch - 100) > 0.001) warnings.push("La durée du calque est étirée (" + L.stretch + "%) : non pris en compte.");
        if (Math.abs(src.pixelAspect - 1) > 0.001 || Math.abs(comp.pixelAspect - 1) > 0.001) {
            warnings.push("Pixels non carrés détectés : utilise des pixels carrés (1.0) pour la vidéo et la comp.");
        }
        var s = sc[0] / 100;
        var proj = app.project.file ? app.project.file.fsName : "";
        return gt_ok({
            compId: comp.id, compName: comp.name, compWidth: comp.width, compHeight: comp.height,
            compFps: comp.frameRate, compTime: comp.time, compDuration: comp.duration,
            layerName: L.name, layerIndex: L.index,
            path: src.file.fsName, srcWidth: src.width, srcHeight: src.height, srcFps: src.frameRate,
            startTime: L.startTime, inPoint: L.inPoint, outPoint: L.outPoint,
            layerScale: s, layerOffset: [pos[0] - anc[0] * s, pos[1] - anc[1] * s],
            cameraZoom: gt_activeCameraZoom(comp),
            projectPath: proj, warnings: warnings
        });
    } catch (e) { return gt_err(e.toString() + " (ligne " + e.line + ")"); }
}

/*
 * Mesure l'ordre et le sens des rotations X/Y/Z d'AE : on pose des angles connus sur un null
 * temporaire et on lit, via une expression toWorldVec(), où partent les 3 axes.
 */
function gt_probeRotation(ax, ay, az) {
    var tmp = null;
    app.beginUndoGroup("GeoTrack — mesure");
    try {
        tmp = app.project.items.addComp("__geotrack_probe__", 100, 100, 1, 1, 25);
        var probe = tmp.layers.addNull();
        probe.name = "gt_probe";
        probe.threeDLayer = true;
        var t = probe.property("ADBE Transform Group");
        t.property("ADBE Rotate X").setValue(ax);
        t.property("ADBE Rotate Y").setValue(ay);
        t.property("ADBE Rotate Z").setValue(az);
        var reader = tmp.layers.addNull();
        reader.threeDLayer = true;
        var p = reader.property("ADBE Transform Group").property("ADBE Position");
        var cols = [];
        var axes = ["[1,0,0]", "[0,1,0]", "[0,0,1]"];
        for (var i = 0; i < 3; i++) {
            p.expression = 'thisComp.layer("gt_probe").toWorldVec(' + axes[i] + ')';
            var v = p.valueAtTime(0, false);
            if (p.expressionError && p.expressionError !== "") throw new Error(p.expressionError);
            cols.push([v[0], v[1], v[2]]);
        }
        var M = [[cols[0][0], cols[1][0], cols[2][0]],
                 [cols[0][1], cols[1][1], cols[2][1]],
                 [cols[0][2], cols[1][2], cols[2][2]]];
        tmp.remove();
        tmp = null;
        app.endUndoGroup();
        return gt_ok({ matrix: M, angles: [ax, ay, az] });
    } catch (e) {
        try { if (tmp) tmp.remove(); } catch (e2) {}
        app.endUndoGroup();
        return gt_err("Mesure des rotations impossible : " + e.toString());
    }
}

function gt_setTime(compId, t) {
    try {
        var comp = gt_findCompById(compId);
        if (comp) comp.time = t;
        return gt_ok({});
    } catch (e) { return gt_err(e.toString()); }
}

function gt_clearKeys(prop) {
    if (prop.expressionEnabled) prop.expression = "";
    while (prop.numKeys > 0) prop.removeKey(1);
}

function gt_findLayer(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === name) return comp.layer(i);
    return null;
}

/*
 * Écrit le résultat dans la comp :
 *  - une caméra "one-node" fixe (centre de comp, Zoom = focale en px)
 *  - un null 3D dont la position/rotation suit l'objet (ancrage = centre du mesh)
 * data : {compId, zoom, cameraName, nullName, times[], positions[[x,y,z]], rotations[[x,y,z]], note}
 */
function gt_apply(json) {
    var data;
    try { data = gt_parse(json); } catch (e) { return gt_err("Données illisibles : " + e.toString()); }
    var comp = gt_findCompById(data.compId);
    if (!comp) return gt_err("Composition introuvable (a-t-elle été supprimée ?)");
    app.beginUndoGroup("GeoTrack — appliquer le tracking");
    try {
        var W = comp.width, H = comp.height;
        // caméra
        var cam = gt_findLayer(comp, data.cameraName);
        if (!cam || !(cam instanceof CameraLayer)) {
            cam = comp.layers.addCamera(data.cameraName, [W / 2, H / 2]);
        }
        cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
        var ct = cam.property("ADBE Transform Group");
        var cpos = ct.property("ADBE Position");
        gt_clearKeys(cpos);
        cpos.setValue([W / 2, H / 2, -data.zoom]);
        var names = ["ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z"];
        for (var n = 0; n < names.length; n++) {
            var pr = ct.property(names[n]);
            gt_clearKeys(pr);
            pr.setValue(names[n] === "ADBE Orientation" ? [0, 0, 0] : 0);
        }
        var zoomProp = cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom");
        gt_clearKeys(zoomProp);
        zoomProp.setValue(data.zoom);
        cam.moveToBeginning();

        // null qui suit l'objet
        var nl = gt_findLayer(comp, data.nullName);
        if (!nl) {
            nl = comp.layers.addNull();
            nl.name = data.nullName;
        }
        nl.threeDLayer = true;
        nl.label = 9; // vert

        // repère parent (rotation fixe à angles droits) : seulement si le panneau l'a demandé pour
        // éviter le blocage de cardan des rotations X/Y/Z. On parente AVANT de réécrire les valeurs
        // du null : la compensation automatique d'AE au moment du parentage est ainsi écrasée.
        var parent = gt_findLayer(comp, data.parentName);
        if (data.parentRotation) {
            if (!parent) {
                parent = comp.layers.addNull();
                parent.name = data.parentName;
            }
            parent.threeDLayer = true;
            parent.label = 9;
            var ptr = parent.property("ADBE Transform Group");
            var pprops = [["ADBE Anchor Point", [0, 0, 0]], ["ADBE Position", [0, 0, 0]], ["ADBE Scale", [100, 100, 100]],
                          ["ADBE Orientation", [0, 0, 0]], ["ADBE Rotate X", data.parentRotation[0]],
                          ["ADBE Rotate Y", data.parentRotation[1]], ["ADBE Rotate Z", data.parentRotation[2]]];
            for (var q = 0; q < pprops.length; q++) {
                var pp0 = ptr.property(pprops[q][0]);
                if (pprops[q][0] === "ADBE Position" && pp0.dimensionsSeparated) pp0.dimensionsSeparated = false;
                gt_clearKeys(pp0);
                pp0.setValue(pprops[q][1]);
            }
            parent.comment = "Gragarda GeoTrack — repère fixe (évite le blocage de cardan). Ne pas modifier.";
            nl.parent = parent;
        } else {
            nl.parent = null;
            if (parent) parent.remove();
        }
        var tr = nl.property("ADBE Transform Group");
        var anc = tr.property("ADBE Anchor Point");
        gt_clearKeys(anc);
        anc.setValue([0, 0, 0]);
        var sc = tr.property("ADBE Scale");
        gt_clearKeys(sc);
        sc.setValue([100, 100, 100]);
        var ori = tr.property("ADBE Orientation");
        gt_clearKeys(ori);
        ori.setValue([0, 0, 0]);
        var pos = tr.property("ADBE Position");
        if (pos.dimensionsSeparated) pos.dimensionsSeparated = false;
        gt_clearKeys(pos);
        var rx = tr.property("ADBE Rotate X"), ry = tr.property("ADBE Rotate Y"), rz = tr.property("ADBE Rotate Z");
        gt_clearKeys(rx); gt_clearKeys(ry); gt_clearKeys(rz);

        var times = data.times, P = data.positions, R = data.rotations;
        var vx = [], vy = [], vz = [];
        for (var i = 0; i < R.length; i++) { vx.push(R[i][0]); vy.push(R[i][1]); vz.push(R[i][2]); }
        pos.setValuesAtTimes(times, P);
        rx.setValuesAtTimes(times, vx);
        ry.setValuesAtTimes(times, vy);
        rz.setValuesAtTimes(times, vz);
        // interpolation linéaire partout : pas de dépassement entre deux frames (flou de bouger propre)
        var props = [pos, rx, ry, rz];
        for (var p = 0; p < props.length; p++) {
            var pp = props[p];
            for (var k = 1; k <= pp.numKeys; k++) {
                pp.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            }
        }
        for (var k2 = 1; k2 <= pos.numKeys; k2++) {
            pos.setSpatialTangentsAtKey(k2, [0, 0, 0], [0, 0, 0]);
        }
        if (data.note) nl.comment = data.note;
        nl.moveAfter(cam);
        if (data.parentRotation) gt_findLayer(comp, data.parentName).moveAfter(nl);
        app.endUndoGroup();
        return gt_ok({ keys: times.length, nullName: nl.name, cameraName: cam.name, parent: !!data.parentRotation });
    } catch (e) {
        app.endUndoGroup();
        return gt_err(e.toString() + " (ligne " + e.line + ")");
    }
}
