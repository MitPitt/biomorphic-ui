/// <reference types="astro/client" />
/// <reference types="@webgpu/types" />

declare module '*.wasm?url' {
	const src: string;
	export default src;
}

declare module '*.wgsl?raw' {
	const src: string;
	export default src;
}
