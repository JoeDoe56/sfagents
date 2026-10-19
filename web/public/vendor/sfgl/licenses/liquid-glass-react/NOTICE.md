# Liquid Glass optical material

DebriPod's optical functions in `static/liquidGL.js` are adapted from
[medfa12/liquid-glass-react](https://github.com/medfa12/liquid-glass-react),
revision `a7d3c5ebd04b7efdf264a901cc521f77878744d1`:

- `src/shader.ts`: circular refraction lobes, opposing spectral sampling,
  mip-based blur, edge bleed, analytic shadow falloff, ring shadow, blur fill,
  key fill, directional highlights, diffusion curves and tone holding.
- `src/glass.ts`: regular/light and dark face color matrices.
- `src/ui.generated.ts`: press highlight and blur response.

Copyright (c) 2026 liquid-glass contributors. MIT license: [LICENSE](LICENSE).
The existing NaughtyDuk attribution in `liquidGL.js` remains applicable to
DebriPod's original renderer. No newer NaughtyDuk implementation was imported.

[AlexStrNik/ShatteredGlass](https://github.com/AlexStrNik/ShatteredGlass),
revision `0ce6e0db3683f6804d3f56a4c39d4e0c7f4f9c8c`, was consulted as an architectural
reference: a backdrop material and opposing highlights use the same SDF shape,
and highlights are composited independently of the body's color treatment.
No Swift, private Apple framework code, or assets from that repository are
included. Its native Core Animation APIs cannot run in a browser.

## DebriPod adaptations

This is an adapted material, not an unmodified upstream renderer or a claim of
pixel equivalence to iOS. Upstream itself distinguishes measured, decoded and
modeled effects. DebriPod keeps its DOM-aligned circular/rounded shapes, hollow
wheel, nested optical depths, selected-row text refraction, geometry animations,
existing text settings, and signed dark/clear/light material control. It does not
merge unrelated controls into one superellipse or replace the app's gestures.

The two opposing highlight layers are evaluated in the existing lens draw.
Specular rim lighting retains DebriPod's `codex/testing3` 3D normal/light response
so device tilt crosses a neutral direction smoothly; touch glow is retained.
The broad face highlight uses a radial surface normal and the same 3D light's
planar projection, without renormalizing that projection at neutral tilt.
Outer drop shadows stay on the DOM element; the ring shadow is analytic in the
shader. The clear-to-regular transition maps to magnitude 0–0.52 of the existing
slider; magnitude 0.52–1 advances to the dark/light endpoint. At zero, the body
has no material tint or frost, while refraction and highlights remain.

The mip source is generated entirely on the GPU once per changed backdrop in
each of the two shared contexts, from the cached artwork and reactive uniforms.
It is capped at 1024 pixels per dimension. No DOM capture, per-control texture
upload, readback, React runtime, or per-control WebGL context was added. An
`EXT_shader_texture_lod`-free path retains a bounded frost kernel with a real
loop exit; secondary optical taps use sharp samples on that fallback. The
existing Frost samples setting controls this kernel (zero disables face frost
on both paths); render scale and scheduler settings remain unchanged.
