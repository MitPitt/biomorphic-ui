/**
 * @biomorphic/ca-core — the shared kernel: the WebGL2 engine, the framework-agnostic
 * runtime (`createBio`), substrate shapes, distance/normal fields, GLSL helpers
 * and the shared types. Material families (`@biomorphic/ca-flora`, `@biomorphic/ca-goo`) depend
 * on this and are composed by the app into the registry `createBio` takes.
 */

export { CAEngine } from './engine';
export type { EngineOptions } from './engine';
export { createBio } from './runtime';
export type { Bio, CreateBioOptions, RegisterOptions } from './runtime';

export { boxBlur, chamfer, distanceField, normalField } from './fields';
export { checkUniforms, declaredUniforms, wrapFragment } from './glsl';
export { T, DIRS, headingFromVector } from './types';
export type {
	ActivityMode,
	LiveHandle,
	LivePatch,
	Material,
	MaterialRegistry,
	Occupancy,
	ParamDef,
	ParamSection,
	SeedCtx,
	TargetSpec,
} from './types';
