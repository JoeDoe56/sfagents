# Notices

sfgl is released under the MIT License (see `LICENSE`). It includes and adapts
work from the following projects, each also under the MIT License:

- **liquidGL** by NaughtyDuk (https://liquidgl.naughtyduk.com). sfgl's renderer
  began as DebriPod's adaptation of liquidGL; the original attribution is kept
  in the renderer sources.
- **liquid-glass-react** (https://github.com/medfa12/liquid-glass-react),
  revision `a7d3c5ebd04b7efdf264a901cc521f77878744d1`: circular refraction
  lobes, opposing spectral sampling, mip-based blur, edge bleed, analytic
  shadow falloff, glass colour matrices and press response. Copyright (c) 2026
  liquid-glass contributors. See `licenses/liquid-glass-react/`.

**Host Grotesk** (https://github.com/Element-Type/HostGrotesk), copyright 2023
The Host Grotesk Project Authors, is bundled in `fonts/host-grotesk/` under the
SIL Open Font License 1.1 (not MIT). The files are the unmodified `woff2`
builds from `@fontsource-variable/host-grotesk` 5.3.0. The license text is in
`fonts/host-grotesk/OFL.txt`.

**SF Symbols.** `symbols/glyphs/` holds Apple's SF Symbols as PNG bitmaps,
copied from the `wan-kong/sf-symbols-online` mirror. They are Apple's artwork
and are *not* covered by sfgl's MIT License; Apple's own terms apply to them.
See `symbols/PROVENANCE.md` before using or redistributing them.

[AlexStrNik/ShatteredGlass](https://github.com/AlexStrNik/ShatteredGlass) was
consulted as an architectural reference only; no code from it is included.

sfgl's history before this repository existed comes from DebriPod
(https://github.com/JoeDoe56/Debripod), where the glass was developed.
