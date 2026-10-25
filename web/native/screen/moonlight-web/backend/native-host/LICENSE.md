# mw-native-host — licence

Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>

Ce module (`backend/native-host/`) est la **capture et l'encodage natifs** de
MoonlightWeb. Il est distribué aujourd'hui sous **GPL-3.0-or-later**, comme le
reste de MoonlightWeb, mais il est délibérément maintenu **séparable** :

- il ne lie **aucune dépendance GPL** — en particulier jamais `moonlight-common-c` ;
- il n'inclut **aucun en-tête** de `backend/src/` ni de Qt ;
- toutes ses dépendances sont sous licence permissive (BSD / MIT / Apache-2.0) ou
  sont des SDK de constructeur dont l'usage commercial est autorisé — **à une
  exception près, décidée le 08/09/2026 et bornée au chemin portail de Linux :
  voir « L'exception sd-bus » ci-dessous**.

Bruno Martin étant seul détenteur du copyright sur ce module, il peut le
relicencier — y compris sous une licence propriétaire — sans le consentement
d'un tiers. C'est la raison d'être de la frontière décrite ci-dessus, et
`tests/boundary_test.cmake` la fait respecter mécaniquement au moment du build.

Toute contribution externe à ce répertoire nécessite une cession de droits
explicite, faute de quoi la propriété ci-dessus est perdue.

## Dépendances autorisées dans ce module

| Dépendance | Licence |
|---|---|
| libopus | BSD-3-Clause |
| OpenH264 | BSD-2-Clause |
| NVIDIA Video Codec SDK (en-têtes) | Licence SDK NVIDIA, usage commercial autorisé |
| AMD AMF (en-têtes) | MIT |
| Intel oneVPL / libvpl | MIT |
| libva, libva-drm | MIT (Expat) |
| Khronos Vulkan-Headers (en-têtes, `third_party/vulkan-headers`) | Apache-2.0 OR MIT |
| libvulkan.so.1 (chargeur Khronos du système, ouvert par `dlopen`) | Apache-2.0 |
| libdrm | MIT |
| libpipewire-0.3 | MIT (Expat) — voir la note ci-dessous |
| libsystemd (sd-bus) | **LGPL-2.1+** — exception bornée, voir ci-dessous |
| ViGEmClient | BSD-3-Clause |
| WinUHid (`third_party/winuhid` : bibliothèque cliente liée, pilote construit à part dans `drivers/vhid`) | MIT |
| SDK Windows / Apple | Licence du SDK correspondant |

### Hors frontière : `tools/` (instruments de labo, jamais distribués)

`tools/scaler-bench/` est un banc de shaders D3D11 qui sert à **décider** du
filtre de réduction du host ; il n'est ni lié à `mw-native-host`, ni installé,
ni livré (option CMake `MW_BUILD_TOOLS`, OFF par défaut), et
`cmake/boundary_check.cmake` ne le scanne pas. Il embarque, à côté de leur
licence, les shaders de trois SDK constructeurs pour les comparer aux nôtres :

| Dépendance du banc | Licence |
|---|---|
| AMD FidelityFX FSR 1.0 (`ffx_a.h`, `ffx_fsr1.h`) | MIT |
| NVIDIA Image Scaling 1.0.3 (`NIS_Scaler.h`, `NIS_Config.h`) | MIT |
| Qualcomm Snapdragon GSR 1 (`sgsr1_mobile.h`) | BSD-3-Clause |

Aucun de ces fichiers ne doit entrer dans `src/` : le filtre retenu est
réécrit dans `ColorConvert.cpp` / `GlConvert.cpp` par nous, sous notre
copyright.

`libdrm.so.2`, `libva.so.2`, `libva-drm.so.2` et `libpipewire-0.3.so.0` sont les
**seules** bibliothèques système que l'hôte Linux lie — la liste est celle que
`readelf -d` donne sur le binaire installé, pas celle qu'on espère — et
**aucune n'est embarquée** dans le
`.deb` / `.rpm` : ce sont des dépendances déclarées, résolues par le système.
Le job Linux de `.github/workflows/release.yml` le vérifie : une bibliothèque de
cette liste retrouvée dans l'AppDir y fait échouer la build (« must stay the
system's »).

### ⚠️ PipeWire : ce que « Expat and LGPL-2.1+ » veut dire

Le fichier de copyright Debian de `libpipewire-0.3-0` annonce « Expat **and**
LGPL-2.1+ », ce qui se lit mal au premier regard. Le partage est par fichier, et
il tombe du bon côté (vérifié le 08/09/2026 sur le banc) :

| Fichiers | Licence | Lié par ce module ? |
|---|---|---|
| `Files: *`, dont `src/pipewire/*` — la bibliothèque **cliente** | Expat (MIT) | ✅ c'est ce qu'on lie |
| `spa/plugins/bluez5/*` | LGPL-2.1+ | ❌ plugin du **démon** |
| `src/modules/module-client-node/v0/*` | LGPL-2+ | ❌ module de compat du **démon** |
| `spa/plugins/alsa/90-pipewire-alsa.rules` | LGPL-2.1+ | ❌ fichier de règles udev |

Les parties copyleft sont côté **démon** — un logiciel séparé, déjà présent sur
la machine, que ce module ne lie ni ne distribue. C'est `libpulse` qui est
LGPL-2.1+ en entier, et c'est pour ça qu'elle est refusée (§19.7 du design).

Le refus des dépendances copyleft ici ne vient pas d'un risque de contamination :
une LGPL est compatible avec la GPL-3 sous laquelle MoonlightWeb est distribué,
et son copyleft ne porte que sur ses propres fichiers. Il vient de la
**séparabilité** décrite en tête de ce document — une dépendance LGPL mettrait une
condition durable sur le relicenciement du module, y compris propriétaire.

### L'exception sd-bus (décidée le 08/09/2026)

**`libsystemd` (sd-bus), LGPL-2.1+, liée uniquement par le chemin portail de
Linux** — `#if defined(MW_NATIVE_LINUX_PORTAL)`. Trois fichiers l'appellent :
`PortalScreenCast.cpp` (le portail) et, depuis le 01/10/2026,
`MutterDisplayConfig.cpp` (la disposition des écrans de GNOME autour de l'écran
virtuel) et `MutterScreenCast.cpp` (l'écran virtuel demandé à Mutter lui-même,
sans fenêtre de partage). Même bibliothèque, même drapeau : le coût ci-dessous
ne change pas.

Pourquoi il a fallu choisir : le portail **ScreenCast** de xdg-desktop-portal est
la seule route de capture d'une **AppImage** (qui ne peut porter aucune capacité,
§19.8 du design), et ce portail n'existe **que par D-Bus**. Or les trois façons de
parler D-Bus en C sont toutes copyleft ou pire : `libdbus` est `GPL-2+ ou
AFL-2.1` — l'arm GPL tuerait la séparabilité, l'arm AFL est incompatible GPL donc
indéfendable dans un binaire GPL-3 — et `GDBus`/`GLib` comme `sd-bus` sont LGPL.
La seule autre route était d'écrire le client D-Bus nous-mêmes : de l'ordre de
600 à 1000 lignes de protocole (SASL, marshalling, `SCM_RIGHTS`, le motif
Request/Response), non vérifiables sur les bancs actuels.

Ce que l'exception coûte exactement, et ce qu'elle ne coûte pas :

- **Rien** pour la distribution d'aujourd'hui : la LGPL est compatible avec la
  GPL-3, le lien est dynamique, la bibliothèque n'est pas embarquée.
- **Rien** pour Windows et macOS : la dépendance est enfermée derrière le drapeau
  de compilation ci-dessus. Un module relicencié garderait ces deux plateformes
  entièrement permissives.
- **Sur Linux seulement**, un relicenciement propriétaire aurait à choisir entre
  se passer du portail (donc de la capture en AppImage) et respecter la
  LGPL — lien dynamique, droit de relier, avis de licence. C'est une condition,
  pas un interdit.

`sd-bus` plutôt que `GDBus` parce que c'est **une** bibliothèque déjà chargée dans
presque tous les processus d'une machine systemd, là où GLib traîne `libglib`,
`libgobject` et `libgio` et son modèle d'objets.

## Dépendances interdites

`moonlight-common-c` (GPL-3.0), FFmpeg / libavcodec (LGPL-2.1+, GPL avec
x264/x265), x264 (GPL-2.0), x265 (GPL-2.0), **libpulse (LGPL-2.1+)** — écartée
au profit de libpipewire pour le son Linux, voir la note ci-dessus —,
**libdbus** (`GPL-2+ ou AFL-2.1`, les deux arms inutilisables ici : voir
l'exception sd-bus) et tout en-tête Qt.
