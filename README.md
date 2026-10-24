# Gragarda GeoTrack

Plugin After Effects (macOS) pour **tracker un objet rigide à partir de son modèle 3D**, dans l'esprit de KeenTools GeoTracker, mais en open source.

Tu donnes au plugin une vidéo et le mesh `.obj` de l'objet filmé (une manette, une boîte, un casque, une voiture…). Tu cales le mesh sur l'objet avec des pins sur une ou deux frames. Le plugin calcule ensuite la position et l'orientation 3D de l'objet sur toutes les autres frames, et crée dans ta comp :

- une **caméra** « GeoTrack Cam » fixe, réglée sur ta focale ;
- un **null 3D** « GeoTrack — *nom du mesh* » qui suit l'objet image par image.

Tout ce que tu parentes à ce null (texte 3D, modèle 3D, particules, calque d'effet…) colle à l'objet.

---

## Installation

1. Ouvre l'onglet **Releases** du repo et télécharge le `.pkg` qui correspond à ton Mac (voir pré-requis).
2. Double-clique sur le `.pkg`. L'installeur n'est pas signé chez Apple, donc la première fois macOS affiche « impossible de vérifier le développeur ». Ferme ce message, puis va dans **Réglages Système → Confidentialité et sécurité**. En bas de la page, une ligne mentionne le `.pkg` bloqué : clique sur **Ouvrir quand même**.
3. Redémarre After Effects, puis **Fenêtre → Extensions → Gragarda GeoTrack**.

L'installeur copie le panneau dans `/Library/Application Support/Adobe/CEP/extensions/com.gragarda.geotrack`. Il active aussi le réglage d'AE qui autorise les extensions non signées par Adobe (`PlayerDebugMode`).

**Pré-requis :** After Effects 2022 ou plus récent. Prends `…-apple-silicon.pkg` pour un Mac M1 à M4, `…-intel.pkg` pour un Mac Intel (menu  → À propos de ce Mac : « Puce Apple » ou « Processeur Intel »). Python n'est pas nécessaire, le moteur est compilé dans l'installeur.

**Désinstaller :** `sudo bash scripts/uninstall.sh`

---

## Ce que tu vois dans le panneau

- **En haut**, de gauche à droite :
  - le bouton 🎞 **Calque vidéo** et le nom du calque chargé ;
  - le bouton ◆ **Mesh .obj** et le nom du fichier avec son nombre de faces ;
  - le champ **Focale** en mm, suivi en gris de l'équivalent en Zoom AE (« = Zoom 924.4 px ») ;
  - tout à droite, la case **suivre dans AE** et le bouton **?**.
- **Au centre**, l'image de la vidéo sur fond noir. Le mesh est dessiné par-dessus en **fil de fer** :
  - **vert** sur une keyframe, c'est-à-dire une pose que tu as calée toi-même ;
  - **cyan** sur une frame calculée par le tracking ;
  - **orange pointillé** quand il n'y a encore aucune pose sur cette frame.

  Les traits de l'avant de l'objet sont nets, ceux de l'arrière très pâles, ce qui aide à voir quelle face est devant. Dans le coin haut gauche, un cartouche noir indique le numéro de frame, le timecode, l'état de la pose, et sur une frame trackée sa fiabilité en %.
- **Les pins** sont des petits **anneaux jaunes**. Si le point du mesh n'est pas encore exactement sous son pin, un **trait rouge** relie l'anneau à l'endroit où se trouve le point du mesh. Plus le trait est long, plus l'écart est grand.
- **La timeline** sous l'image :
  - un **trait bleu vertical** marque la frame courante ;
  - des **losanges verts** marquent les keyframes ;
  - une **bande de couleur** en bas indique l'état de chaque frame : vert = tracking fiable, orange = moyen, rouge = douteux, gris = pas encore tracké.

---

## Mode d'emploi

### 1. Préparer la comp
- La vidéo doit être un calque **2D**, sans rotation, avec une **échelle identique en X et en Y**. Elle peut être plus grande que la comp, par exemple une vidéo 4K à 50 % dans une comp 1080p : c'est géré.
- Pas de remappage temporel ni d'étirement de durée sur ce calque.

### 2. Charger la vidéo et le mesh
1. Dans la timeline d'AE, clique sur le calque vidéo, puis sur 🎞 **Calque vidéo** dans le panneau.
2. Clique sur ◆ **Mesh .obj** et choisis le modèle. Le mesh apparaît au centre de l'image, en orange pointillé, face à la caméra.
3. Règle la **focale** :
   - **téléphone**, caméra principale : 24 à 26 mm (ultra grand-angle ≈ 13 mm, téléobjectif 48 à 77 mm selon le modèle) ;
   - **appareil photo** : la focale de l'objectif multipliée par le coefficient du capteur (×1,5 en APS-C, ×2 en Micro 4/3) ;
   - si la comp contient déjà une caméra AE, le bouton **caméra de la comp** reprend son Zoom.

   Une focale fausse se voit tout de suite : impossible de caler à la fois l'avant et l'arrière de l'objet, l'un des deux a l'air trop grand ou trop petit.

### 3. Caler le mesh sur une frame (keyframe)
Va sur une frame où l'objet est **net** et bien visible.
1. **Clique sur un point du mesh**, par exemple un coin, et **glisse-le** sur le même point de l'objet dans l'image.
   - **1 pin** : le mesh glisse sans tourner.
   - **2 pins** : il tourne dans le plan de l'image et grossit ou rétrécit.
   - **3 pins et plus** : il tourne en 3D.
2. Pose **4 à 6 pins** sur des points **éloignés les uns des autres**, si possible sur **plusieurs faces** de l'objet. Quand tu relâches un pin, le plugin cherche automatiquement la meilleure orientation globale, ce qui évite les poses « en miroir ».
3. Le cartouche affiche l'« écart moyen » des pins. En dessous de 1 à 2 px, c'est bon. La frame devient une keyframe, avec un losange vert dans la timeline.

Pour dégrossir avant de poser les pins : glisser dans le vide fait tourner le mesh, Maj+glisser le déplace, la molette le rapproche ou l'éloigne.

### 4. Tracker
Choisis la plage (**Tout le calque** par défaut), puis clique sur **▶ Tracker**, ou appuie sur `T`. La barre de progression avance en bas, puis la bande sous la timeline se colore.

Là où la bande devient **orange ou rouge**, ou là où le fil de fer cyan décroche de l'objet, va sur la frame, recale avec des pins (ça crée une nouvelle keyframe) et relance **▶ Tracker**. Entre deux keyframes, le plugin tracke dans les deux sens et mélange les résultats, donc chaque keyframe ajoutée améliore toute la zone autour.

### 5. Envoyer vers After Effects
Clique sur **→ Envoyer vers AE**. Dans ta comp apparaissent :
- **GeoTrack Cam** : caméra fixe, placée en haut de la pile de calques ;
- **GeoTrack — *mesh*** : null 3D vert, avec une keyframe de position et de rotation par frame. Son point d'ancrage est au **centre** du mesh ;
- parfois **GeoTrack — repère** : un null parent avec une rotation fixe à angles droits. Il n'apparaît que si l'objet tourne beaucoup (plus de ~70° autour d'un axe). Il évite que les rotations X/Y/Z d'AE se bloquent (« blocage de cardan »), ce qui ferait mal interpoler AE entre deux frames. N'y touche pas.

Pour accrocher quelque chose à l'objet : passe le calque en 3D, choisis le null GeoTrack dans sa colonne **Parent**, puis mets sa **Position à 0,0,0**. Il se place au centre de l'objet. Les unités du null sont en pixels : la plus grande dimension du mesh fait la moitié de la hauteur de la comp. Le commentaire du null (colonne Commentaires) donne la correspondance exacte « 1 unité OBJ = N px ».

Tu peux relancer **Envoyer vers AE** autant de fois que tu veux : la caméra et le null sont mis à jour, pas dupliqués.

### Où est enregistré ton travail ?
Les keyframes, les pins et le tracking sont sauvegardés automatiquement dans un dossier `GeoTrack/` à côté de ton projet `.aep`. Si le projet n'est pas encore enregistré, ils vont dans `~/Documents/Gragarda GeoTrack/`. Quand tu recharges le même calque, tout revient.

### Raccourcis (panneau actif)
| Touche | Action |
|---|---|
| ← → | frame précédente / suivante |
| Maj+← → | keyframe précédente / suivante |
| K | keyframe sur la frame courante |
| Suppr | supprimer la keyframe courante |
| P | retirer les pins de la frame |
| R | remettre la pose de départ |
| T | tracker |
| Cmd+molette, Espace+glisser, F | zoomer, déplacer, recadrer la vue |
| Double-clic sur un pin | supprimer ce pin |

---

## Limites actuelles
- **Objets rigides** uniquement : pas de visage qui parle, ni de tissu.
- La **focale** se règle à la main. Elle n'est pas estimée automatiquement, et la distorsion d'objectif n'est pas corrigée (à éviter avec les ultra grand-angles).
- La **caméra est supposée fixe** : on calcule le mouvement de l'objet par rapport à la caméra. Si c'est la caméra qui bouge autour d'un objet immobile, le résultat est le même à l'écran, mais c'est le null qui bouge, pas la caméra.
- Une main qui passe devant l'objet, ou un gros flou de bouger, peut faire décrocher le tracking. Ajoute une keyframe juste après.
- Le moteur garde les images de la plage en mémoire, en niveaux de gris. Pour les plans très longs, la résolution de travail baisse automatiquement. Tu peux aussi tracker par morceaux (plages « vers la fin » / « vers le début »).
- Installeurs compilés pour Apple Silicon et pour Intel.

---

## Installation développeur
Depuis un clone du repo, avec Python 3 installé (par exemple avec Homebrew) :
```bash
bash scripts/install_dev.sh
```
Le script relie le dossier `extension/` du repo directement dans les extensions d'AE et crée un environnement Python dédié (`~/.gragarda-geotrack/venv`) avec numpy et OpenCV. Une modification du code est prise en compte en fermant et rouvrant le panneau.

## Comment ça marche
```
Panneau AE (HTML/JS, CEP)  ──JSON par ligne──►  Moteur Python persistant (OpenCV)
  pins, affichage, timeline                       lecture vidéo, tracking
  conversion vers AE                              ──► poses (rotation + translation) par frame
        │
        └── ExtendScript (jsx/host.jsx) : lit le calque, mesure les rotations d'AE, crée caméra + null
```
1. Sur chaque keyframe, des points d'intérêt sont détectés sur l'objet et « collés » sur la surface du mesh grâce à la pose calée : on connaît alors leur position 3D.
2. Image par image, ces points sont suivis par **flux optique** (Lucas-Kanade, avec vérification aller-retour). En plus, des **points SIFT** sont recherchés directement dans les images des keyframes. Leur 3D est exacte, ce qui empêche la dérive.
3. La pose est résolue par **PnP RANSAC** (les points aberrants sont écartés), puis affinée par Levenberg-Marquardt.
4. Entre deux keyframes, on tracke vers l'avant et vers l'arrière, puis on mélange les deux (interpolation sphérique des rotations).
5. Côté AE, le panneau **mesure** l'ordre et le sens réels des rotations X/Y/Z sur un null temporaire, au lieu de les supposer, puis convertit chaque pose.

## Tests
```bash
node tests/pose.test.js          # maths du panneau : pins, rotations AE, conversion
python3 tests/synthetic_test.py  # moteur : cube de synthèse à trajectoire connue
python3 tests/ui_test.py         # panneau complet dans Chromium, AE simulé (pip install playwright)
```
`ui_test.py` rejoue un utilisateur :
- il pose des pins à la souris sur la frame 0 et tracke ;
- il corrige la dernière frame et retracke ;
- il envoie vers AE et vérifie que le null retombe sur le cube.

Résultat actuel : **1,6 px d'écart moyen** dans une comp 1280×720.

## Publier une nouvelle version
- **Onglet Actions → Release macOS → Run workflow**, en indiquant le numéro de version ;
- ou pousser un tag : `git tag v0.2.0 && git push --tags`.

Un Mac de GitHub compile alors le moteur, le teste sur la vidéo de synthèse, fabrique le `.pkg` et le publie dans les Releases. Les tests Linux tournent eux à chaque push.

Côté minutes GitHub Actions : la compilation Mac prend quelques minutes, et une minute de Mac coûte environ 8 fois plus qu'une minute de Linux dans le quota gratuit. C'est pour ça qu'elle ne tourne qu'à la publication d'une version.
