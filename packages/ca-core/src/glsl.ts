export const VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
	v_uv = a_pos * 0.5 + 0.5;
	gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/**
 * Shared GLSL. `fetchAt` clamps out-of-bounds to SUBSTRATE so growth stops at
 * the canvas border instead of wrapping.
 */
export const COMMON = `
float hash21(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise. Unlike hash21 (per-cell white noise = roughness), this is
// coherent over ~1 unit, so perturbing a growth normal by it bends a spike
// smoothly (lean -> snake) instead of roughening its edge.
float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash21(i);
	float b = hash21(i + vec2(1.0, 0.0));
	float c = hash21(i + vec2(0.0, 1.0));
	float d = hash21(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec4 fetchAt(sampler2D s, ivec2 c) {
	ivec2 sz = textureSize(s, 0);
	if (c.x < 0 || c.y < 0 || c.x >= sz.x || c.y >= sz.y) {
		return vec4(1.0, 0.0, 0.0, 0.0);
	}
	return texelFetch(s, c, 0);
}
`;

export const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_filter;
in vec2 v_uv;
out vec4 outColor;

// Catmull-Rom cubic kernel (4 taps/axis). Sharper than bilinear, mild ringing.
float catmull(float x) {
	x = abs(x);
	if (x < 1.0) return 1.5 * x * x * x - 2.5 * x * x + 1.0;
	if (x < 2.0) return -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0;
	return 0.0;
}

// Lanczos-3 kernel (6 taps/axis). Sharpest, more ringing.
float lanczos(float x) {
	x = abs(x);
	if (x < 1e-5) return 1.0;
	if (x >= 3.0) return 0.0;
	float px = 3.141592653589793 * x;
	return (sin(px) / px) * (sin(px / 3.0) / (px / 3.0));
}

vec4 fetchClamp(sampler2D t, ivec2 c) {
	ivec2 size = textureSize(t, 0);
	return texelFetch(t, clamp(c, ivec2(0), size - 1), 0);
}

// Separable reconstruction: gather (2r)^2 texels around the sample point. mode
// 2 = Catmull-Rom (r=2), else Lanczos-3 (r=3).
vec4 reconstruct(sampler2D t, vec2 uv, int radius, int mode) {
	vec2 size = vec2(textureSize(t, 0));
	vec2 texel = uv * size - 0.5;         // continuous texel coordinate
	ivec2 base = ivec2(floor(texel));
	vec2 f = texel - vec2(base);
	vec4 sum = vec4(0.0);
	float wsum = 0.0;
	for (int j = 1 - radius; j <= radius; j++) {
		float wy = mode == 2 ? catmull(float(j) - f.y) : lanczos(float(j) - f.y);
		for (int i = 1 - radius; i <= radius; i++) {
			float wx = mode == 2 ? catmull(float(i) - f.x) : lanczos(float(i) - f.x);
			float w = wx * wy;
			sum += fetchClamp(t, base + ivec2(i, j)) * w;
			wsum += w;
		}
	}
	return sum / max(wsum, 1e-5);
}

void main() {
	vec4 s;
	if (u_filter == 0) {                  // linear (hardware, smooth)
		s = texture(u_tex, v_uv);
	} else if (u_filter == 1) {           // nearest (hardware, grid pixels)
		s = fetchClamp(u_tex, ivec2(v_uv * vec2(textureSize(u_tex, 0))));
	} else if (u_filter == 2) {           // bicubic / Catmull-Rom
		s = reconstruct(u_tex, v_uv, 2, 2);
	} else {                              // lanczos-3
		s = reconstruct(u_tex, v_uv, 3, 3);
	}
	// R is a signed coverage field; GBA is colour. Reconstruction of R across the
	// boundary is what gives the silhouette its edge quality.
	float cov = clamp(s.r + 0.5, 0.0, 1.0);
	outColor = vec4(s.g, s.b, s.a, cov);
}
`;

/** Uniforms the engine binds itself (not from `material.params`). */
export const BUILTIN_UNIFORMS = new Set([
	'u_state',
	'u_field',
	'u_frame',
	'u_tex',
	'u_filter',
]);

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Uniform names declared via `uniform <type> <name>;` (arrays included). */
export function declaredUniforms(src: string): Set<string> {
	const out = new Set<string>();
	for (const m of stripComments(src).matchAll(/\buniform\s+[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/g)) {
		out.add(m[1]);
	}
	return out;
}

/** Throws if a shader references a `u_*` uniform it never declares. */
export function checkUniforms(src: string): void {
	const declared = declaredUniforms(src);
	const used = new Set<string>();
	for (const m of stripComments(src).matchAll(/\bu_[A-Za-z0-9_]+/g)) used.add(m[0]);
	const missing = [...used].filter((n) => !declared.has(n) && !BUILTIN_UNIFORMS.has(n));
	if (missing.length) {
		throw new Error(`Shader references undeclared uniform(s): ${missing.sort().join(', ')}`);
	}
}

export function wrapFragment(body: string): string {
	const src = `#version 300 es
precision highp float;
${COMMON}
${body}
`;
	checkUniforms(src);
	return src;
}
