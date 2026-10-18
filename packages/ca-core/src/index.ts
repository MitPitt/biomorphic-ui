/**
 * @biomorphic/ca-core — the shared kernel: the WebGL2 engine, the framework-agnostic
 * runtime (`createBio`), substrate shapes, distance/normal fields, GLSL helpers
 * and the shared types. Material families (`@biomorphic/ca-flora`, `@biomorphic/ca-goo`) depend
 * on this and are composed by the app into the registry `createBio` takes.
 */

export type { BioEngine, EngineOptions } from './engine-api';
export { OffscreenEngine, canUseOffscreen } from './offscreen';
export type { OffscreenEngineOptions } from './offscreen';
export { startBioWorker } from './worker';
export type { WorkerRequest, WorkerResponse } from './offscreen-protocol';
export { createBio } from './runtime';
export type { Bio, CreateBioOptions, RegisterOptions } from './runtime';

export { boxBlur, chamfer, distanceField, normalField } from './fields';
export { checkUniforms, declaredUniforms, wrapFragment } from './glsl';
export { T, DIRS, headingFromVector } from './types';
export type {
	ActivityMode,
	FieldData,
	LiveHandle,
	LivePatch,
	Material,
	MaterialRegistry,
	Occupancy,
	ParamDef,
	ParamSection,
	SeedCtx,
	TargetSpec,
	UpsampleMode,
} from './types';
