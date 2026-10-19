/**
 * GLSL sources. One source compiles for WebGL2 (GLSL ES 3.00) and WebGL1
 * (GLSL ES 1.00, with or without EXT_shader_texture_lod) through a small
 * prelude of macros. Optional features are compile-time variants.
 *
 * The optical model is adapted from liquid-glass-react's QuartzCore
 * reconstruction (MIT; see NOTICE.md): circular refraction lobes, opposing
 * spectral taps, mip blur, edge bleed, analytic ring shadow, glass grade,
 * directional and opposing highlights, and tone holding.
 * @module
 */

/**
 * @typedef {object} Variant
 * @property {boolean} underGlass   composite the layer below (layered glass)
 * @property {boolean} underText    composite a live content underlay
 * @property {0|3|7} dispersion     spectral taps at the rim
 * @property {boolean} debugFlat    sample the backdrop with no optics (tests)
 */

/**
 * @param {import('./context.js').GLCaps} caps
 * @param {'vertex'|'fragment'} stage
 * @param {Record<string, string|number|boolean>} [defines]
 */
export function prelude(caps, stage, defines = {}) {
  const lines = [];
  if (caps.webgl2) lines.push('#version 300 es');
  if (!caps.webgl2 && stage === 'fragment') {
    if (caps.lodMode === 'ext') lines.push('#extension GL_EXT_shader_texture_lod : enable');
    if (caps.derivatives) lines.push('#extension GL_OES_standard_derivatives : enable');
  }
  Object.entries(defines).forEach(([name, value]) => {
    if (value === false || value === undefined || value === null) return;
    lines.push(`#define ${name} ${value === true ? 1 : value}`);
  });
  if (stage === 'vertex') {
    lines.push('precision highp float;');
    if (caps.webgl2) lines.push('#define attribute in', '#define varying out');
  } else {
    lines.push(caps.highp ? 'precision highp float;' : 'precision mediump float;');
    if (caps.derivatives) lines.push('#define SF_HAS_DERIVATIVES 1');
    if (caps.webgl2) {
      lines.push('#define varying in', 'out vec4 sf_FragColor;', '#define gl_FragColor sf_FragColor', '#define texture2D texture',
        '#define SF_LOD(s, uv, l) textureLod(s, uv, l)');
    } else if (caps.lodMode === 'ext') {
      lines.push('#define SF_LOD(s, uv, l) texture2DLodEXT(s, uv, l)');
    } else {
      // Without explicit LOD, a bias on the implicit level approximates it:
      // a lens samples the backdrop at roughly one texel per pixel.
      lines.push('#define SF_LOD(s, uv, l) texture2D(s, uv, l)');
    }
  }
  return lines.join('\n') + '\n';
}

/** Full-screen triangle pair used by the backdrop prepare pass. */
export const FULLSCREEN_VERTEX = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

/**
 * Lens quad. The unit quad is placed over the lens rect in surface CSS
 * pixels, then optionally transformed by a CSS-space 4×4 matrix (for example
 * perspective(900px) rotateX() rotateY() about the lens centre). Writing the
 * homogeneous w keeps the lens-local varying perspective-correct, so the
 * fragment shader shades the untransformed shape exactly as the DOM element
 * is drawn by CSS.
 */
export const LENS_VERTEX = `
attribute vec2 a_position;
uniform vec4 u_lensRect;      // x, y (top), width, height in surface CSS px
uniform vec2 u_surfaceSize;   // surface CSS size
uniform mat4 u_transform;     // CSS-space transform (identity when unused)
varying vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  vec2 css = u_lensRect.xy + vec2(v_uv.x, 1.0 - v_uv.y) * u_lensRect.zw;
  vec4 p = u_transform * vec4(css, 0.0, 1.0);
  gl_Position = vec4(p.x / u_surfaceSize.x * 2.0 - p.w, p.w - p.y / u_surfaceSize.y * 2.0, 0.0, p.w);
}`;

/**
 * Backdrop prepare pass. The provider supplies
 *   vec4 sfBackdrop(vec2 uv)
 * where uv is the backdrop rect in CSS orientation (0,0 = top-left). The
 * result is written in GL orientation and mip-mapped for the lens shader.
 * @param {string} providerSource
 */
export function prepareFragment(providerSource) {
  return `
varying vec2 v_uv;
${providerSource}
void main() {
  gl_FragColor = sfBackdrop(vec2(v_uv.x, 1.0 - v_uv.y));
}`;
}

/** Built-in provider: an image or canvas, stretched, covered or contained. */
export const IMAGE_BACKDROP = `
uniform sampler2D sf_image;
uniform vec2 sf_imageSize;
uniform vec2 sf_backdropSize;
uniform int sf_fit;            // 0 stretch, 1 cover, 2 contain
uniform bool sf_opaque;
vec4 sfBackdrop(vec2 uv) {
  vec2 fitted = uv;
  if (sf_fit != 0) {
    float viewAspect = sf_backdropSize.x / max(1.0, sf_backdropSize.y);
    float imageAspect = sf_imageSize.x / max(1.0, sf_imageSize.y);
    bool wider = viewAspect > imageAspect;
    if (sf_fit == 2) wider = !wider;
    if (wider) fitted.y = (uv.y - 0.5) * imageAspect / viewAspect + 0.5;
    else fitted.x = (uv.x - 0.5) * viewAspect / imageAspect + 0.5;
  }
  vec4 color = texture2D(sf_image, clamp(fitted, 0.0, 1.0));
  if (sf_fit == 2 && (fitted.x < 0.0 || fitted.y < 0.0 || fitted.x > 1.0 || fitted.y > 1.0)) color = vec4(0.0);
  return sf_opaque ? vec4(color.rgb * color.a, 1.0) : color;
}`;

/** Lens fragment shader. */
export const LENS_FRAGMENT = `
varying vec2 v_uv;
uniform sampler2D u_backdrop;       // prepared, mip-mapped backdrop (GL orientation)
uniform vec2 u_backdropTexSize;     // texels
uniform vec2 u_backdropCssSize;     // CSS px covered by the backdrop
uniform vec4 u_backdropToSurface;   // backdrop UV -> surface UV (scale.xy, offset.zw)
#ifdef SF_UNDER_GLASS
uniform sampler2D u_underGlass;     // copy of the layers already drawn (GL orientation)
#endif
#ifdef SF_UNDER_TEXT
uniform sampler2D u_underText;      // premultiplied content layer
uniform vec4 u_underTextBounds;     // in backdrop UV
#endif
uniform vec2  u_resolution;         // lens size in device px
uniform vec2  u_lensCssSize;
uniform float u_devicePixelRatio;
uniform vec4  u_bounds;             // lens rect in backdrop UV
uniform mat4  u_fragTransform;     // same matrix as the vertex stage
uniform bool  u_hasTransform;
uniform vec2  u_surfaceCssSize;
uniform float u_refraction;
uniform float u_frost;
uniform float u_frostEnabled;
uniform float u_radius;
uniform float u_cornerPower;
uniform bool  u_specular;
uniform float u_revealProgress;
uniform int   u_revealType;
uniform float u_tiltX;
uniform float u_tiltY;
uniform float u_magnify;
uniform float u_hollowInset;
uniform bool  u_hollowMaskContent;
uniform float u_materialDensity;
uniform float u_materialSign;
uniform vec3  u_materialTone;
uniform float u_specularPrimary;
uniform float u_specularSecondary;
uniform float u_toneAmount;         // how much of u_materialTone replaces the body
uniform float u_rim;                // hairline edge highlight strength
uniform float u_rimTint;            // how much the rim takes the colour around the edge
uniform float u_dispersionAmount;   // 0..1 scale of the spectral split
uniform vec2  u_globalLight;
uniform float u_globalLightIntensity;
uniform vec4  u_contact;
uniform float u_scrollEdge;
uniform float u_opacity;

float udRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  vec2 outside = max(q, 0.0);
  // A superellipse above L2 has zero curvature at the straight-edge join.
  float power = max(2.0, u_cornerPower);
  vec2 unit = outside / max(r, 1.0);
  float corner = power > 2.01
    ? pow(pow(unit.x, power) + pow(unit.y, power), 1.0 / power) * max(r, 1.0)
    : length(outside);
  return corner + min(max(q.x, q.y), 0.0) - r;
}

float hollowInnerShapeAtTextureUV(vec2 textureUV) {
  vec2 flippedUV = (textureUV - u_bounds.xy) / u_bounds.zw;
  vec2 localUV = vec2(flippedUV.x, 1.0 - flippedUV.y);
  vec2 p_px = (localUV - 0.5) * u_resolution;
  vec2 b_px = 0.5 * u_resolution;
  vec2 innerB = max(vec2(0.0), b_px - vec2(u_hollowInset));
  float innerRadius = max(0.0, u_radius - u_hollowInset);
  float innerD = udRoundBox(p_px, innerB, innerRadius);
  float fallbackAA = max(0.75, 1.0 / max(1.0, u_devicePixelRatio));
#ifdef SF_HAS_DERIVATIVES
  float aa = max(fwidth(innerD), fallbackAA);
#else
  float aa = fallbackAA;
#endif
  return 1.0 - smoothstep(-aa, aa, innerD);
}

float lensCurve(float t) {
  t = clamp(t, 0.0, 1.0);
  return sqrt(max(0.0, (2.0 - t) * t));
}
float refractLobe(float dist, float amount, float height) {
  return amount * (1.0 - lensCurve(-dist / max(height, 0.001)));
}
float shadowFalloff(float d, float invRadius) {
  float x = 4.0 * clamp(0.25 * d * invRadius + 0.5, 0.0, 1.0) - 2.0;
  float x2 = x * x;
  return (((0.002954 * x2 - 0.034460) * x2 + 0.168210) * x2 - 0.560550) * x + 0.5;
}
vec2 shapeNormal(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  vec2 outside = max(q, 0.0);
  if (dot(outside, outside) > 0.00001) {
    vec2 gradient = u_cornerPower > 2.01 ? pow(outside / max(r, 1.0), vec2(u_cornerPower - 1.0)) : outside;
    return gradient / max(length(gradient), 0.0001) * sign(p);
  }
  // The nearest-edge normal jumps by 90 degrees on the medial diagonals.
  // Blend only the interior gradients, reaching the exact edge normal at the
  // corner/straight-edge boundary.
  float band = max(0.001, min(max(r, 1.0), max(-q.x, -q.y)));
  float weight = smoothstep(-band, band, q.x - q.y);
  vec2 gradient = vec2(sign(p.x) * weight, sign(p.y) * (1.0 - weight));
  return gradient / max(length(gradient), 0.0001);
}
// Map an untransformed point of the lens plane (backdrop UV) to where the
// transform puts it on screen, so the backdrop behind a tilted lens lines up.
vec2 projectBackdrop(vec2 sourceUV) {
  if (!u_hasTransform) return sourceUV;
  vec2 surfaceUV = sourceUV * u_backdropToSurface.xy + u_backdropToSurface.zw;
  vec4 p = u_fragTransform * vec4(surfaceUV * u_surfaceCssSize, 0.0, 1.0);
  vec2 projected = (p.xy / max(p.w, 0.1)) / u_surfaceCssSize;
  return (projected - u_backdropToSurface.zw) / u_backdropToSurface.xy;
}
vec4 compositeOpticalLayers(vec4 base, vec2 uv) {
#ifdef SF_UNDER_GLASS
  vec2 surfaceUV = uv * u_backdropToSurface.xy + u_backdropToSurface.zw;
  vec4 under = texture2D(u_underGlass, vec2(clamp(surfaceUV.x, 0.0, 1.0), 1.0 - clamp(surfaceUV.y, 0.0, 1.0)));
  base = vec4(under.rgb + base.rgb * (1.0 - under.a), under.a + base.a * (1.0 - under.a));
#endif
#ifdef SF_UNDER_TEXT
  vec2 textUV = (uv - u_underTextBounds.xy) / u_underTextBounds.zw;
  if (textUV.x >= 0.0 && textUV.y >= 0.0 && textUV.x <= 1.0 && textUV.y <= 1.0) {
    vec4 text = texture2D(u_underText, textUV);
    base = vec4(text.rgb + base.rgb * (1.0 - text.a), text.a + base.a * (1.0 - text.a));
  }
#endif
  return base;
}
vec4 opticalSample(vec2 uv, float radiusCss) {
  float radius = radiusCss * min(u_backdropTexSize.x / u_backdropCssSize.x, u_backdropTexSize.y / u_backdropCssSize.y);
  float lod = max(0.0, log2(max(1.0, radius < 2.0 ? radius * 0.5 + 1.0 : radius)));
  vec4 base = SF_LOD(u_backdrop, clamp(vec2(uv.x, 1.0 - uv.y), 0.0, 1.0), lod);
  return compositeOpticalLayers(base, uv);
}
// The colour a rim takes from the content around it. Liquid Glass rims are
// lit by what is near the edge: a vivid colour next to the glass adds its
// hue to that stretch of the rim (measured on iOS: a dark blue bubble beside
// the edge leaves the rim's red where it was and nearly doubles its blue),
// while dark, grey or white surroundings leave it white. Dim colours add
// less.
vec3 rimLight(vec3 around) {
  float hi = max(around.r, max(around.g, around.b));
  float lo = min(around.r, min(around.g, around.b));
  float saturation = (hi - lo) / max(hi, 0.0001);
  vec3 hue = around / max(hi, 0.0001);
  float amount = 1.3 * u_rimTint * saturation * (1.0 - exp(-hi / 0.3));
  return vec3(1.0) + amount * hue;
}
vec3 gradeGlass(vec3 rgb) {
  // GLASS_RECIPE / GLASS_RECIPE_DARK from upstream glass.ts, interpolated
  // from identity so the signed material's zero stays clear.
  float bias = u_materialSign < 0.0 ? 0.0813 : 0.235;
  vec3 grade = vec3(dot(rgb, vec3(0.921, -0.265, -0.027)),
                    dot(rgb, vec3(-0.079, 0.735, -0.027)),
                    dot(rgb, vec3(-0.079, -0.265, 0.973))) + bias;
  float recipe = smoothstep(0.0, 0.52, u_materialDensity);
  return mix(rgb, grade, recipe);
}
void main() {
  vec2 localUV = (v_uv - 0.5) / u_magnify + 0.5;
  vec2 localMapped = u_bounds.xy + vec2(localUV.x, 1.0 - localUV.y) * u_bounds.zw;
  vec2 mapped = projectBackdrop(localMapped);
#ifdef SF_DEBUG_FLAT
  gl_FragColor = SF_LOD(u_backdrop, clamp(vec2(mapped.x, 1.0 - mapped.y), 0.0, 1.0), 0.0);
  return;
#endif
  // Reject outside/hollow pixels before any optical sampling.
  vec2 p_px = (v_uv - 0.5) * u_resolution;
  vec2 b_px = 0.5 * u_resolution;
  float dmask = udRoundBox(p_px, b_px, u_radius);
  vec2 normal = shapeNormal(p_px, b_px, u_radius);
  float fallbackAA = max(0.75, 1.0 / max(1.0, u_devicePixelRatio));
#ifdef SF_HAS_DERIVATIVES
  float edgeAA = max(fwidth(dmask), fallbackAA);
#else
  float edgeAA = fallbackAA;
#endif
  float inShape = 1.0 - smoothstep(-edgeAA, edgeAA, dmask);
  float opticalDistance = dmask;
  if (u_hollowInset > 0.0) {
    vec2 innerB = max(vec2(0.0), b_px - vec2(u_hollowInset));
    float innerRadius = max(0.0, u_radius - u_hollowInset);
    float innerD = udRoundBox(p_px, innerB, innerRadius);
    float innerShape = 1.0 - smoothstep(-edgeAA, edgeAA, innerD);
    inShape *= 1.0 - innerShape;
    if (-innerD > opticalDistance) {
      opticalDistance = -innerD;
      normal = -shapeNormal(p_px, innerB, innerRadius);
    }
  }
  if (inShape <= 0.0001) discard;
  float d = opticalDistance / max(0.5, u_devicePixelRatio);
  float insideCss = max(0.0, -d);
  float diffusion = u_revealType == 1 ? clamp(u_revealProgress, 0.0, 1.0) : 1.0;
  float dRefract = pow(diffusion, 0.55);
  float dBlur = pow(diffusion, 1.30);
  float dBody = pow(diffusion, 1.60);
  float press = u_contact.z;
  float scale = clamp(min(u_lensCssSize.x, u_lensCssSize.y) / 150.0, 0.35, 1.5);
  vec2 cssToUV = 1.0 / u_backdropCssSize;
  vec2 direction = vec2(normal.x, -normal.y);
  float opticalStrength = clamp(u_refraction / 0.045, 0.0, 2.5);
  float inner = refractLobe(d, 4.0 * scale, 18.0 * scale) * opticalStrength * dRefract;
  float outer = refractLobe(d, -13.0 * scale, 10.0 * scale) * opticalStrength * dRefract;
  vec2 innerUV = projectBackdrop(localMapped + direction * inner * cssToUV);
  vec2 outerUV = projectBackdrop(localMapped + direction * outer * cssToUV);
  if (u_hollowInset > 0.0 && u_hollowMaskContent) {
    innerUV = mix(innerUV, mapped, smoothstep(0.01, 0.30, hollowInnerShapeAtTextureUV(innerUV)));
    outerUV = mix(outerUV, mapped, smoothstep(0.01, 0.30, hollowInnerShapeAtTextureUV(outerUV)));
  }
  // Blur rises into the body; the bevel stays optically sharp.
  float blur = u_frost * dBlur * (1.0 + 0.20 * press) * mix(0.18, 1.0, smoothstep(0.0, 20.0 * scale, insideCss));
  float edgeMask = u_scrollEdge * (1.0 - smoothstep(0.0, 22.0, min(v_uv.y, 1.0 - v_uv.y) * u_lensCssSize.y));
  blur = max(blur, edgeMask * u_frost * 1.4);
  if (u_frostEnabled < 0.5) blur = 0.0;
  vec4 face = opticalSample(innerUV, blur);
  // Interior fast path: the crossover, spectral and bleed terms are exactly
  // zero away from the rim, so their texture taps are skipped there.
  if (insideCss < 30.0 * scale) {
    float crossover = clamp((d + 30.0 * scale) / (30.0 * scale), 0.0, 1.0) * 0.65;
    face = mix(face, opticalSample(outerUV, blur), crossover);
  }
  float rimBand = 14.0 * scale;
#if SF_DISPERSION > 0
  if (insideCss < rimBand) {
    // Opposing spectral taps concentrate dispersion at the bevel.
    float dispersion = refractLobe(d, 3.0 * scale, 14.0 * scale) * dRefract * u_dispersionAmount;
    if (dispersion > 0.02) {
      vec2 chroma = direction * dispersion * cssToUV;
#if SF_DISPERSION >= 7
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 3; ++i) {
        float w = 1.0 - float(i) / 3.0;
        vec3 tap = opticalSample(innerUV + chroma * w, blur).rgb;
        acc.r += tap.r * w;
        acc.g += tap.g * (1.0 - w);
      }
      for (int i = 0; i < 4; ++i) {
        float w = float(i) / 3.0;
        vec3 tap = opticalSample(innerUV - chroma * w, blur).rgb;
        acc.g += tap.g * (1.0 - w);
        acc.b += tap.b * w;
      }
      face.rgb = mix(face.rgb, acc * vec3(0.5, 1.0 / 3.0, 0.5), 0.75);
#else
      vec3 acc = vec3(opticalSample(innerUV + chroma, blur).r, face.g, opticalSample(innerUV - chroma, blur).b);
      face.rgb = mix(face.rgb, acc, 0.75);
#endif
    }
  }
#endif
  vec3 rgb = face.rgb;
  if (insideCss < rimBand) {
    float bleedBand = 1.0 - smoothstep(0.0, rimBand, insideCss);
    float bleedMag = refractLobe(d, 24.0 * scale, 12.0 * scale);
    vec3 bleed = opticalSample(mapped + direction * bleedMag * cssToUV, max(blur, u_frost * 1.3)).rgb * 0.92;
    rgb = mix(face.rgb, bleed, bleedBand * mix(0.08, 0.15, u_materialDensity));
  }
  // Ring shadow uses the difference of two analytic soft edges.
  float ring = shadowFalloff(insideCss * 0.70710678, 1.0 / (30.0 * scale))
             - shadowFalloff((insideCss + 9.0 * scale) * 0.70710678, 1.0 / (30.0 * scale));
  rgb *= 1.0 - max(0.0, ring) * 0.30;
  rgb = gradeGlass(rgb);
  // Independent blur fill, with lighten/darken/normal contributions.
  if (u_materialDensity > 0.005 && u_frostEnabled > 0.5) {
    vec3 fill = gradeGlass(opticalSample(mapped, u_frost * 1.7).rgb);
    vec3 mixed = 0.30 * max(rgb, fill) + 0.22 * min(rgb, fill) + 0.48 * rgb;
    rgb = mix(rgb, mix(mixed, fill, 0.15), min(1.0, u_materialDensity / 0.52));
  }
  // Local adaptive tone from the smallest mip of the backdrop.
  if (u_materialDensity > 0.005) {
    vec3 average = SF_LOD(u_backdrop, vec2(0.5), log2(max(u_backdropTexSize.x, u_backdropTexSize.y))).rgb;
    float luma = dot(average, vec3(0.212646, 0.715332, 0.072205));
    float chameleon = 1.0 / (1.0 + exp(-10.25 * (luma - 0.5)));
    rgb += (0.5 - chameleon) * 0.04 * min(1.0, u_materialDensity / 0.52);
  }
  // Preserve the signed slider's endpoints and its clear zero.
  rgb = mix(rgb, u_materialTone, u_toneAmount * dBody);
  if (u_specular) {
    // 3D light response: the positive Z components stay defined as a planar
    // light crosses zero, so opposite rims fade through neutral.
    float outerPeak = 1.0 - smoothstep(0.0, 1.15, insideCss);
    float innerRim = 1.0 - smoothstep(0.5, 4.5, insideCss);
    float rimSlope = mix(0.58, 1.35, outerPeak);
    vec3 N = normalize(vec3(normal * rimSlope, 0.62));
    vec2 tiltNormal = vec2(sin(radians(u_tiltY)), -sin(radians(u_tiltX))) * 0.34;
    N = normalize(vec3(N.xy + tiltNormal, N.z));
    vec2 globalLight = mix(vec2(-0.48, 0.76), vec2(u_globalLight.x, -u_globalLight.y) * 1.4, u_globalLightIntensity);
    vec3 primaryLight = normalize(vec3(globalLight, 0.52));
    vec3 secondaryLight = normalize(vec3(-globalLight, 0.46));
    float primaryFacing = max(dot(N, primaryLight), 0.0);
    float secondaryFacing = max(dot(N, secondaryLight), 0.0);
    // Hairline rim, as on Apple's Liquid Glass (measured against iOS at 3x):
    // about one CSS pixel wide, brightest on the outermost backing pixel and
    // fading linearly inward, so it reads as a crisp line. It is brightest
    // where the edge faces the light and toward the middle of that edge,
    // falls off steeply around the corners, and all but vanishes on edges
    // side-on to the light, with a weaker reflection on the opposite edge.
    float insideBacking = max(0.0, -opticalDistance);
    float hairWidth = max(1.0, 0.95 * u_devicePixelRatio);
    float hairline = clamp(1.0 - (insideBacking - 0.5) / hairWidth, 0.0, 1.0);
    vec2 edgeNormal = normal / max(length(normal), 0.0001);
    vec2 lightDir2 = normalize(primaryLight.xy + vec2(0.0001));
    float litEdge = max(dot(edgeNormal, lightDir2), 0.0);
    float backEdge = max(dot(edgeNormal, -lightDir2), 0.0);
    vec2 facePosition = p_px / max(b_px, vec2(1.0));
    facePosition /= max(length(facePosition), 0.0001);
    float along = max(dot(facePosition, lightDir2), 0.0);
    float alongBack = max(dot(facePosition, -lightDir2), 0.0);
    float sharp = hairline * u_rim * (0.04 +
      pow(litEdge, 3.0) * (0.25 + 0.75 * pow(along, 2.5)) +
      0.5 * pow(backEdge, 3.0) * (0.25 + 0.75 * pow(alongBack, 2.5)));
    float soft = innerRim * pow(primaryFacing, 2.2) * u_specularPrimary * 0.35;
    float opposite = innerRim * 0.3 * pow(secondaryFacing, 2.8) * u_specularSecondary;
    // Light from the content around this stretch of the edge, a few pixels
    // outside it, blurred so the colour moves smoothly along the rim.
    vec3 rimColor = vec3(1.0);
    if (insideCss < 6.0 && u_rimTint > 0.001) {
      vec2 aroundUV = projectBackdrop(localMapped + direction * 6.0 * cssToUV);
      rimColor = rimLight(opticalSample(aroundUV, 8.0).rgb);
    }
    vec3 softRimColor = rimColor * mix(vec3(1.0), face.rgb, 0.08);
    float heightMask = 1.0 - smoothstep(0.0, 70.0 * scale, insideCss);
    // A radial face normal avoids the panel's medial diagonals; the 3D
    // light's XY projection fades smoothly through neutral.
    vec2 faceGradient = p_px / max(b_px, vec2(1.0));
    vec2 faceNormal = faceGradient / max(length(faceGradient), 0.0001);
    vec2 faceFacing = vec2(dot(faceNormal, primaryLight.xy), dot(faceNormal, secondaryLight.xy));
    vec2 lobes = clamp((faceFacing - 0.55) / 0.45, 0.0, 1.0) * heightMask;
    vec2 key = lobes / (0.7 * (1.0 - lobes) + 1.0);
    vec2 contactPx = (v_uv - u_contact.xy) * u_lensCssSize;
    float contactLight = exp(-dot(contactPx, contactPx) / 3200.0) * press * 0.065;
    rgb += (sharp * rimColor + (soft + opposite) * softRimColor) * (1.0 + 0.45 * press) +
      vec3((key.x + key.y) * 0.035 + contactLight);
  }
  // SDR holding tone preserves hue at luminous rims.
  rgb = max(rgb, vec3(0.0));
  rgb /= max(1.0, max(rgb.r, max(rgb.g, rgb.b)));
  vec4 final = vec4(rgb, face.a * dBody * u_opacity);
  final.rgb *= final.a;
  final.rgb *= inShape;
  final.a *= inShape;
  gl_FragColor = final;
}`;
