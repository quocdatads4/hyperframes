/**
 * Cloud Run request handler for HyperFrames distributed rendering.
 *
 * One container image, three roles. Cloud Workflows POSTs a JSON body with
 * an `Action` field; the handler unwraps any `Payload`/`Input` envelope,
 * primes the runtime (Chrome path), and forwards to the matching OSS
 * primitive from `@hyperframes/producer/distributed`.
 *
 * Everything heavy — capture, encode, audio mix — happens inside the OSS
 * primitives. The handler is thin glue: parse body → GCS download → call
 * primitive → GCS upload → return small JSON result.
 *
 * `dispatch()` is the testable core (inject `storage` + `primitives`); the
 * Hono app at the bottom is the HTTP shell the Dockerfile runs. The shape
 * deliberately tracks `@hyperframes/aws-lambda`'s `handler.ts` so the two
 * adapters stay easy to diff.
 */

import { timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createProjectSignature,
  createStudioApi,
  PREVIEW_BUNDLE_OPTIONS,
  previewAllowedHostsFromEnv,
  type RenderJobState,
  type ResolvedProject,
  type StudioApiAdapter,
} from "@hyperframes/studio-server";
import { encoderJobOptions } from "@hyperframes/studio-server/encoder-options";
import { requestFromAnotherSite, requestHost } from "@hyperframes/studio-server/request-identity";
import { loadHyperframeRuntimeSource } from "@hyperframes/core";
import { lintHyperframeHtml, lintProject } from "@hyperframes/lint";
import { Storage } from "@google-cloud/storage";
import { Hono } from "hono";
import { compress } from "hono/compress";
import {
  assemble,
  type ChunkRenderer,
  type ChunkResult,
  listPlanV2ArtifactsForTarget,
  materializePlanV2Target,
  isPlanAudioArtifactPath,
  resolvePlanAudioPath,
  planV2WithPublisher,
  type PlanV2Artifact,
  type PlanV2Manifest,
  type PlanV2MaterializationTarget,
  readPlanV2Manifest,
  renderChunk,
} from "@hyperframes/producer/distributed";
import { resolveChromeExecutablePath } from "./chromium.js";
import type {
  AssembleEvent,
  AssembleResultBody,
  CloudRunAction,
  CloudRunEvent,
  CloudRunResult,
  PlanEvent,
  PlanResultBody,
  RenderChunkEvent,
  RenderChunkResultBody,
} from "./events.js";
import { type DistributedFormat, formatExtension } from "./formatExtension.js";
import {
  downloadGcsObjectToFile,
  downloadGcsObjectToFileVerified,
  parseGcsUri,
  tarDirectory,
  untarDirectory,
  uploadFileToGcs,
} from "./gcsTransport.js";
import { GcsPlanV2ArtifactPublisher } from "./gcsPlanV2Publisher.js";
import { createDatframesStudioProjectProviderFromEnv } from "./datframesStudioAdapter.js";
import { createStudioThumbnailGeneratorFromEnv } from "./studioThumbnail.js";

const PACKAGE_VERSION = (() => {
  try {
    const pkgPath = join(fileURLToPath(import.meta.url), "../../package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.9.70";
  } catch {
    return "0.9.70";
  }
})();

export interface StudioBundleCache {
  (dir: string): Promise<string | null>;
  invalidate(dir?: string): void;
}

export function createStudioBundleCache(
  bundle: (dir: string) => Promise<string | null>,
  getRevision: (dir: string) => string | number = (dir) => {
    const stats = statSync(dir);
    return `${stats.dev}:${stats.ino}:${stats.mtimeMs}`;
  },
): StudioBundleCache {
  const cached = new Map<string, { revision: string | number; html: string | null }>();
  const inFlight = new Map<
    string,
    { revision: string | number; promise: Promise<string | null> }
  >();

  const load = (async (dir: string) => {
    const revision = getRevision(dir);
    const existing = cached.get(dir);
    if (existing?.revision === revision) return existing.html;

    const active = inFlight.get(dir);
    if (active?.revision === revision) return active.promise;

    const promise = bundle(dir)
      .then((html) => {
        cached.set(dir, { revision, html });
        return html;
      })
      .finally(() => {
        if (inFlight.get(dir)?.promise === promise) inFlight.delete(dir);
      });
    inFlight.set(dir, { revision, promise });
    return promise;
  }) as StudioBundleCache;

  load.invalidate = (dir?: string) => {
    if (!dir) {
      cached.clear();
      return;
    }
    cached.delete(dir);
  };

  return load;
}

export function isTrustedServiceToken(
  authHeader: string | undefined,
  expectedToken = process.env.DATFRAMES_STUDIO_SERVICE_TOKEN?.trim(),
): boolean {
  if (!expectedToken || !authHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match?.[1]) return false;
  const actual = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseMaxConcurrentRenders(override?: number): number {
  if (typeof override === "number" && Number.isSafeInteger(override) && override > 0) {
    return override;
  }
  const raw = Number(process.env.HYPERFRAMES_MAX_CONCURRENT_RENDERS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
}

type RenderStartOpts = Parameters<StudioApiAdapter["startRender"]>[0];

export type LocalRenderExecutor = (opts: {
  renderOpts: RenderStartOpts;
  signal: AbortSignal;
  onProgress: (progress: number, stage?: string) => void;
}) => Promise<{ audioLoweredDb?: number } | void>;

interface RenderStatusRecord {
  id: string;
  projectId: string;
  state: RenderJobState;
  filename: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

function removeRenderArtifacts(outputPath: string): void {
  const metaPath = outputPath.replace(/\.(mp4|webm|mov|gif)$/i, ".meta.json");
  for (const filePath of [outputPath, metaPath]) {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function writeRenderMetaFile(outputPath: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    const metaPath = outputPath.replace(/\.(mp4|webm|mov|gif)$/i, ".meta.json");
    writeFileSync(metaPath, JSON.stringify(payload), "utf8");
  } catch {
    /* best effort */
  }
}

async function defaultLocalRenderExecutor({
  renderOpts,
  signal,
  onProgress,
}: Parameters<LocalRenderExecutor>[0]): Promise<{ audioLoweredDb?: number }> {
  if (!process.env.PRODUCER_HEADLESS_SHELL_PATH) {
    process.env.PRODUCER_HEADLESS_SHELL_PATH = resolveChromeExecutablePath();
  }
  mkdirSync(dirname(renderOpts.outputPath), { recursive: true });
  const { createRenderJob, executeRenderJob } = await import("@hyperframes/producer");
  const job = createRenderJob({
    fps: renderOpts.fps,
    quality: renderOpts.quality as "draft" | "standard" | "high",
    format: renderOpts.format,
    ...(renderOpts.gifLoop !== undefined ? { gifLoop: renderOpts.gifLoop } : {}),
    outputResolution: renderOpts.outputResolution,
    ...(renderOpts.composition ? { entryFile: renderOpts.composition } : {}),
    ...(renderOpts.variables ? { variables: renderOpts.variables } : {}),
    ...encoderJobOptions(renderOpts),
    ...(renderOpts.useGpu ? { useGpu: true } : {}),
    ...(renderOpts.pageMotionBlur ? { pageMotionBlur: renderOpts.pageMotionBlur } : {}),
    allowOutsideProjectAssets: false,
  });
  await executeRenderJob(
    job,
    renderOpts.project.dir,
    renderOpts.outputPath,
    (progressJob) => {
      onProgress(progressJob.progress, progressJob.currentStage);
    },
    signal,
  );
  return {
    ...(job.audioLoweredDb !== undefined ? { audioLoweredDb: job.audioLoweredDb } : {}),
  };
}

function createRenderQueueController(
  maxConcurrent: number,
  executor: LocalRenderExecutor = defaultLocalRenderExecutor,
) {
  let active = 0;
  const waiters: Array<{
    cancelled: boolean;
    grant: () => void;
  }> = [];
  const records = new Map<string, RenderStatusRecord>();
  const MAX_RECORDS = 200;

  const rememberRecord = (record: RenderStatusRecord) => {
    records.delete(record.id);
    records.set(record.id, record);
    if (records.size > MAX_RECORDS) {
      const oldestKey = records.keys().next().value;
      if (oldestKey) records.delete(oldestKey);
    }
  };

  const acquireSlot = (signal: AbortSignal): Promise<() => void> => {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Render cancelled while queued", "AbortError"));
    }
    if (active < maxConcurrent) {
      active += 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        drainQueue();
      });
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        cancelled: false,
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active = Math.max(0, active - 1);
            drainQueue();
          });
        },
      };
      const onAbort = () => {
        waiter.cancelled = true;
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new DOMException("Render cancelled while queued", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
    });
  };

  const drainQueue = () => {
    while (active < maxConcurrent && waiters.length > 0) {
      const next = waiters.shift();
      if (next && !next.cancelled) {
        next.grant();
      }
    }
  };

  const startRender = (renderOpts: RenderStartOpts): RenderJobState => {
    const abortController = new AbortController();
    const state: RenderJobState = {
      id: renderOpts.jobId,
      status: "rendering",
      progress: 0,
      stage: "queued",
      outputPath: renderOpts.outputPath,
      cancel: () => {
        abortController.abort();
      },
    };
    const record: RenderStatusRecord = {
      id: renderOpts.jobId,
      projectId: renderOpts.project.id,
      state,
      filename: basename(renderOpts.outputPath),
      startedAt: Date.now(),
    };
    rememberRecord(record);

    void (async () => {
      let release: (() => void) | null = null;
      try {
        release = await acquireSlot(abortController.signal);
        if (abortController.signal.aborted) {
          state.status = "cancelled";
          state.stage = "cancelled";
          record.finishedAt = Date.now();
          record.durationMs = record.finishedAt - record.startedAt;
          removeRenderArtifacts(renderOpts.outputPath);
          return;
        }
        state.stage = "initializing";
        const result = await executor({
          renderOpts,
          signal: abortController.signal,
          onProgress: (progress, stage) => {
            if (abortController.signal.aborted) return;
            state.progress = progress;
            if (stage) state.stage = stage;
          },
        });
        if (abortController.signal.aborted) {
          state.status = "cancelled";
          state.stage = "cancelled";
          record.finishedAt = Date.now();
          record.durationMs = record.finishedAt - record.startedAt;
          removeRenderArtifacts(renderOpts.outputPath);
          return;
        }
        if (result && typeof result.audioLoweredDb === "number") {
          state.audioLoweredDb = result.audioLoweredDb;
        }
        state.status = "complete";
        state.progress = 100;
        state.stage = "complete";
        record.finishedAt = Date.now();
        record.durationMs = record.finishedAt - record.startedAt;
        writeRenderMetaFile(renderOpts.outputPath, {
          status: "complete",
          durationMs: record.durationMs,
          ...(state.audioLoweredDb !== undefined ? { audioLoweredDb: state.audioLoweredDb } : {}),
        });
      } catch (error) {
        record.finishedAt = Date.now();
        record.durationMs = record.finishedAt - record.startedAt;
        if (abortController.signal.aborted) {
          state.status = "cancelled";
          state.stage = "cancelled";
          removeRenderArtifacts(renderOpts.outputPath);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        state.status = "failed";
        state.stage = "failed";
        state.error = message;
        writeRenderMetaFile(renderOpts.outputPath, {
          status: "failed",
          error: message,
          durationMs: record.durationMs,
        });
      } finally {
        release?.();
      }
    })();

    return state;
  };

  return {
    startRender,
    getRecord: (jobId: string) => records.get(jobId),
    activeCount: () => active,
    queuedCount: () => waiters.filter((w) => !w.cancelled).length,
    maxConcurrent,
  };
}

/**
 * Lazily-constructed Storage client. Cached at module scope so warm
 * container instances reuse the underlying HTTP keep-alive pool across
 * requests.
 */
let cachedStorage: Storage | null = null;
function getStorage(): Storage {
  if (cachedStorage) return cachedStorage;
  cachedStorage = new Storage();
  return cachedStorage;
}

/**
 * Optional injection points used by the handler's unit tests. Production
 * callers leave these unset; the real OSS primitives are used. Tests inject
 * `storage` and `primitives` directly rather than mutating module state.
 */
export interface HandlerDeps {
  storage?: Storage;
  primitives?: {
    planV2WithPublisher?: typeof planV2WithPublisher;
    renderChunk: ChunkRenderer;
    assemble: typeof assemble;
  };
  /** Override the per-request workdir root (defaults to the OS tmpdir). */
  tmpRoot?: string;
  /** Skip Chrome resolution (used by dispatch tests that mock renderChunk). */
  skipChromeResolution?: boolean;
  /** Override Studio project discovery/materialization (used by HTTP tests and embedders). */
  studioAdapter?: StudioApiAdapter;
  /** Additional hosts accepted by Studio API same-origin guards during tests/embedding. */
  allowedHosts?: readonly string[];
  /** Override resolved projects list for local HTTP shell tests. */
  projects?: ResolvedProject[];
  /** Override DATframes studio service token verification during tests. */
  serviceToken?: string;
  /** Override maximum concurrent local renders during tests. */
  maxConcurrentRenders?: number;
  /** Override local render execution during tests. */
  renderExecutor?: LocalRenderExecutor;
  /** Callback invoked when cache invalidation is triggered. */
  onInvalidateCache?: (projectId: string) => void | Promise<void>;
}

/**
 * Dispatch a single render request. Cloud Workflows (or a direct caller)
 * sometimes wraps the body in `{ Payload: ... }` or `{ Input: ... }`; unwrap
 * until we hit a discriminated event.
 */
// fallow-ignore-next-line complexity
export async function dispatch(event: CloudRunEvent, deps?: HandlerDeps): Promise<CloudRunResult> {
  const unwrapped = unwrapEvent(event);
  validatePlanProtocolShape(unwrapped);
  validateEventGcsUris(unwrapped);
  logEvent({ event: "handler_start", action: unwrapped.Action, input: summarizeEvent(unwrapped) });
  try {
    switch (unwrapped.Action) {
      case "plan":
        return await handlePlan(unwrapped, deps);
      case "renderChunk":
        return await handleRenderChunk(unwrapped, deps);
      case "assemble":
        return await handleAssemble(unwrapped, deps);
      default: {
        // Compile-time exhaustiveness: a new CloudRunAction member trips
        // the `never` assignment before the runtime error is reachable.
        const _exhaustive: never = unwrapped;
        throw new Error(
          `[handler] unknown Action: ${JSON.stringify(
            (_exhaustive as { Action?: string }).Action,
          )}. Expected one of "plan", "renderChunk", "assemble".`,
        );
      }
    }
  } catch (err) {
    normalizeTerminalErrorName(err);
    logEvent({
      event: "handler_error",
      action: unwrapped.Action,
      input: summarizeEvent(unwrapped),
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
    throw err;
  }
}

// This is the single fail-closed boundary for the wire union. Keeping all
// forbidden locator combinations together makes mixed-protocol input auditable.
// fallow-ignore-next-line complexity
function validatePlanProtocolShape(event: PlanEvent | RenderChunkEvent | AssembleEvent): void {
  const raw = event as unknown as Record<string, unknown>;
  const protocol = raw.PlanProtocol;
  if (protocol !== undefined && protocol !== "v2") {
    const error = new Error(
      `[handler] unsupported PlanProtocol ${JSON.stringify(protocol)}; expected "v2" or absent`,
    );
    error.name = "PLAN_PROTOCOL_UNSUPPORTED";
    throw error;
  }
  if (event.Action === "plan") return;

  const hasV1Locator = typeof raw.PlanGcsUri === "string";
  const hasV2Manifest = typeof raw.PlanV2ManifestGcsUri === "string";
  const hasV2Prefix = typeof raw.PlanV2ArtifactGcsPrefix === "string";
  const valid = !hasV1Locator && hasV2Manifest && hasV2Prefix;
  if (!valid) {
    const error = new Error(
      `[handler] v2 ${event.Action} event has mixed or missing plan locators`,
    );
    error.name = "PLAN_PROTOCOL_UNSUPPORTED";
    throw error;
  }
  if (event.Action === "assemble" && event.AudioGcsUri !== null) {
    const error = new Error("[handler] v2 assemble audio must be materialized from the manifest");
    error.name = "PLAN_PROTOCOL_UNSUPPORTED";
    throw error;
  }
}

/** Normalize producer error codes to the stable HTTP/workflow discriminator. */
// The explicit mapping is the public Cloud Workflows retry contract.
// fallow-ignore-next-line complexity
function normalizeTerminalErrorName(error: unknown): void {
  if (!error || typeof error !== "object") return;
  const candidate = error as { code?: unknown; name?: string };
  if (
    candidate.code === "PLAN_PROTOCOL_UNSUPPORTED" ||
    candidate.code === "PLAN_V2_INTEGRITY_UNRECOVERABLE" ||
    candidate.code === "FONT_FETCH_FAILED" ||
    candidate.code === "FONT_FETCH_UNAVAILABLE" ||
    candidate.code === "VIDEO_SOURCE_UNRENDERABLE" ||
    candidate.code === "VIDEO_EXTRACTION_FAILED" ||
    candidate.code === "INVALID_VIDEO_METADATA" ||
    candidate.code === "CHUNK_EXCEEDS_WORKER_TIMEOUT"
  ) {
    candidate.name = candidate.code;
  }
}

// At most `{Payload: {Input: ...}}` is expected; 4 levels is 2× headroom
// and prevents infinite loops on malformed input.
const MAX_ENVELOPE_DEPTH = 4;

// fallow-ignore-next-line complexity
export function unwrapEvent(event: CloudRunEvent): PlanEvent | RenderChunkEvent | AssembleEvent {
  let cursor: CloudRunEvent = event;
  for (let i = 0; i < MAX_ENVELOPE_DEPTH; i++) {
    if (cursor && typeof cursor === "object") {
      const obj = cursor as Record<string, unknown>;
      if (typeof obj.Action === "string" && isCloudRunAction(obj.Action)) {
        return cursor as PlanEvent | RenderChunkEvent | AssembleEvent;
      }
      if ("Payload" in obj) {
        cursor = obj.Payload as CloudRunEvent;
        continue;
      }
      if ("Input" in obj) {
        cursor = obj.Input as CloudRunEvent;
        continue;
      }
    }
    break;
  }
  throw new Error(
    `[handler] body has no recognised Action; unwrapped ${MAX_ENVELOPE_DEPTH} levels of Payload/Input without finding one.`,
  );
}

function isCloudRunAction(value: string): value is CloudRunAction {
  return value === "plan" || value === "renderChunk" || value === "assemble";
}

/**
 * Emit a single JSON line to stdout. Cloud Logging ingests each stdout line
 * as a structured `jsonPayload` entry, so Logs Explorer can filter on
 * `jsonPayload.event="handler_start"` and project specific fields when
 * triaging without attaching a debugger.
 */
function logEvent(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

/**
 * Compact, non-PII summary of an event for logging. The full body can
 * include the entire project config; we only emit the routable fields
 * needed to triage a failure from Cloud Logging.
 */
// Keep event variants together so Cloud Logging has one redaction boundary.
// fallow-ignore-next-line complexity
function summarizeEvent(
  event: PlanEvent | RenderChunkEvent | AssembleEvent,
): Record<string, unknown> {
  switch (event.Action) {
    case "plan":
      return {
        projectGcsUri: event.ProjectGcsUri,
        planOutputGcsPrefix: event.PlanOutputGcsPrefix,
        planProtocol: event.PlanProtocol ?? "v2",
        format: event.Config.format,
        fps: event.Config.fps,
      };
    case "renderChunk":
      return {
        planProtocol: event.PlanProtocol ?? "v2",
        planV2ManifestGcsUri: event.PlanV2ManifestGcsUri,
        chunkIndex: event.ChunkIndex,
        format: event.Format,
      };
    case "assemble":
      return {
        planProtocol: event.PlanProtocol ?? "v2",
        planV2ManifestGcsUri: event.PlanV2ManifestGcsUri,
        chunkCount: event.ChunkGcsUris.length,
        hasAudio: event.AudioGcsUri !== null,
        outputGcsUri: event.OutputGcsUri,
        format: event.Format,
      };
  }
}

/**
 * Point the engine at the in-image Chrome binary. The OSS engine resolves
 * Chrome via `PRODUCER_HEADLESS_SHELL_PATH` first; set it once per instance
 * before invoking any browser-touching primitive. ffmpeg is on the image's
 * PATH (apt-installed by the Dockerfile), so nothing to prime there.
 */
function primeChrome(deps?: HandlerDeps): void {
  if (deps?.skipChromeResolution) return;
  if (process.env.PRODUCER_HEADLESS_SHELL_PATH) return;
  process.env.PRODUCER_HEADLESS_SHELL_PATH = resolveChromeExecutablePath();
}

// ── Plan ────────────────────────────────────────────────────────────────────

async function handlePlan(event: PlanEvent, deps?: HandlerDeps): Promise<PlanResultBody> {
  const started = Date.now();
  const storage = deps?.storage ?? getStorage();
  const primitive = deps?.primitives?.planV2WithPublisher ?? planV2WithPublisher;
  primeChrome(deps);

  const work = mkdtempSync(join(deps?.tmpRoot ?? tmpdir(), "hf-cr-plan-v2-"));
  const projectArchive = join(work, "project.tar.gz");
  const projectDir = join(work, "project");
  try {
    await downloadGcsObjectToFile(storage, event.ProjectGcsUri, projectArchive);
    await untarDirectory(projectArchive, projectDir);
    const publisher = new GcsPlanV2ArtifactPublisher({
      storage,
      planOutputGcsPrefix: event.PlanOutputGcsPrefix,
      temporaryRoot: work,
    });
    const manifest: PlanV2Manifest = await primitive(projectDir, { ...event.Config }, publisher, {
      stagingParentDir: work,
    });

    return {
      Action: "plan",
      PlanProtocol: "v2",
      PlanV2ManifestGcsUri: publisher.manifestUri,
      PlanV2ArtifactGcsPrefix: publisher.artifactPrefix,
      PlanHash: manifest.planHash,
      ChunkCount: manifest.chunkCount,
      TotalFrames: manifest.totalFrames,
      Fps: manifest.fps,
      Width: manifest.width,
      Height: manifest.height,
      Format: manifest.format,
      HasAudio: manifest.artifacts.some((artifact) => isPlanAudioArtifactPath(artifact.path)),
      AudioGcsUri: null,
      FfmpegVersion: manifest.ffmpegVersion,
      ProducerVersion: manifest.producerVersion,
      DurationMs: Date.now() - started,
    };
  } finally {
    cleanupDir(work);
  }
}

// ── RenderChunk ─────────────────────────────────────────────────────────────

// fallow-ignore-next-line complexity
async function handleRenderChunk(
  event: RenderChunkEvent,
  deps?: HandlerDeps,
): Promise<RenderChunkResultBody> {
  const started = Date.now();
  const storage = deps?.storage ?? getStorage();
  const primitive = deps?.primitives?.renderChunk ?? renderChunk;
  primeChrome(deps);

  const work = mkdtempSync(join(deps?.tmpRoot ?? tmpdir(), "hf-cr-chunk-v2-"));
  try {
    const planDir = await downloadAndMaterializePlanV2(
      storage,
      event,
      { role: "chunk", chunkIndex: event.ChunkIndex },
      work,
    );
    const chunkOutputBase = join(
      work,
      event.Format === "png-sequence"
        ? `chunk-${pad(event.ChunkIndex)}`
        : `chunk-${pad(event.ChunkIndex)}${formatExtension(event.Format)}`,
    );
    const result = await primitive(planDir, event.ChunkIndex, chunkOutputBase);
    const chunkUri = await uploadChunkOutput(
      storage,
      result,
      event.ChunkOutputGcsPrefix,
      event.ChunkIndex,
    );
    return {
      Action: "renderChunk",
      ChunkGcsUri: chunkUri,
      ChunkIndex: event.ChunkIndex,
      Sha256: result.sha256,
      FramesEncoded: result.framesEncoded,
      CaptureMode: result.captureMode,
      DurationMs: Date.now() - started,
    };
  } finally {
    cleanupDir(work);
  }
}

async function uploadChunkOutput(
  storage: Storage,
  result: ChunkResult,
  prefix: string,
  chunkIndex: number,
): Promise<string> {
  const trimmed = trimTrailingSlash(prefix);
  if (result.outputKind === "file") {
    const ext = extname(result.outputPath);
    const uri = `${trimmed}/chunks/${pad(chunkIndex)}${ext}`;
    await uploadFileToGcs(storage, result.outputPath, uri);
    return uri;
  }
  // frame-dir: upload as a tarball so a single GCS object represents the
  // chunk. Assemble's png-sequence path expects a directory per chunk; it
  // untars on its end.
  const tarball = `${result.outputPath}.tar.gz`;
  await tarDirectory(result.outputPath, tarball);
  const uri = `${trimmed}/chunks/${pad(chunkIndex)}.tar.gz`;
  await uploadFileToGcs(storage, tarball, uri, "application/gzip");
  return uri;
}

// ── Assemble ────────────────────────────────────────────────────────────────

// fallow-ignore-next-line complexity
async function handleAssemble(
  event: AssembleEvent,
  deps?: HandlerDeps,
): Promise<AssembleResultBody> {
  const started = Date.now();
  const storage = deps?.storage ?? getStorage();
  const primitive = deps?.primitives?.assemble ?? assemble;
  const work = mkdtempSync(join(deps?.tmpRoot ?? tmpdir(), "hf-cr-assemble-v2-"));
  try {
    const planDir = await downloadAndMaterializePlanV2(storage, event, { role: "assembler" }, work);
    const audioPath = resolvePlanAudioPath(planDir);
    const chunkPaths = await downloadChunkObjects(storage, event.ChunkGcsUris, work, event.Format);
    const finalOutput =
      event.Format === "png-sequence"
        ? join(work, "output-frames")
        : join(work, `output${formatExtension(event.Format)}`);
    const result = await primitive(planDir, chunkPaths, audioPath, finalOutput, {
      cfr: event.Cfr === true,
    });
    if (event.Format === "png-sequence") {
      const tarball = `${finalOutput}.tar.gz`;
      await tarDirectory(finalOutput, tarball);
      await uploadFileToGcs(storage, tarball, event.OutputGcsUri, "application/gzip");
    } else {
      await uploadFileToGcs(storage, finalOutput, event.OutputGcsUri);
    }
    return {
      Action: "assemble",
      OutputGcsUri: event.OutputGcsUri,
      FramesEncoded: result.framesEncoded,
      FileSize: result.fileSize,
      DurationMs: Date.now() - started,
    };
  } finally {
    cleanupDir(work);
  }
}

async function downloadAndMaterializePlanV2(
  storage: Storage,
  event: {
    PlanV2ManifestGcsUri: string;
    PlanV2ArtifactGcsPrefix: string;
    PlanHash: string;
  },
  target: PlanV2MaterializationTarget,
  work: string,
): Promise<string> {
  const transportDir = join(work, "plan-v2");
  mkdirSync(transportDir, { recursive: true });
  await downloadGcsObjectToFile(
    storage,
    event.PlanV2ManifestGcsUri,
    join(transportDir, "plan.json"),
  );
  const manifest = readPlanV2Manifest(transportDir);
  if (manifest.planHash !== event.PlanHash) {
    throwPlanHashMismatch(event.PlanHash, manifest.planHash);
  }
  const artifacts = listPlanV2ArtifactsForTarget(manifest, target);
  const uniqueArtifacts = [
    ...new Map(artifacts.map((artifact) => [artifact.sha256, artifact])).values(),
  ];
  await mapConcurrent(uniqueArtifacts, 16, async (artifact) => {
    await downloadPlanV2Artifact(storage, event.PlanV2ArtifactGcsPrefix, transportDir, artifact);
  });
  const planDir = join(work, "plan");
  materializePlanV2Target(transportDir, target, planDir);
  return planDir;
}

async function downloadPlanV2Artifact(
  storage: Storage,
  artifactPrefix: string,
  planV2Dir: string,
  artifact: Readonly<PlanV2Artifact>,
): Promise<void> {
  await downloadGcsObjectToFileVerified(
    storage,
    planV2BlobUri(artifactPrefix, artifact.sha256),
    planV2BlobPath(planV2Dir, artifact.sha256),
    artifact.sha256,
  );
}

function planV2BlobPath(planV2Dir: string, digest: string): string {
  return join(planV2Dir, "artifacts", "sha256", digest.slice(0, 2), digest);
}

function planV2BlobUri(prefix: string, digest: string): string {
  return `${trimTrailingSlash(prefix)}/${digest.slice(0, 2)}/${digest}`;
}

function throwPlanHashMismatch(expected: string, actual: string): never {
  const error = new Error(
    `PLAN_HASH_MISMATCH: event PlanHash=${expected} did not match v2 manifest planHash=${actual}`,
  );
  error.name = "PLAN_HASH_MISMATCH";
  throw error;
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      await fn(values[index]!);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  // Invocation cleanup removes the work directory in `finally`. Drain all
  // sibling downloads before surfacing an error so a late GCS stream cannot
  // keep writing into scratch after another artifact fails verification.
  if (failure) throw failure.reason;
}

async function downloadChunkObjects(
  storage: Storage,
  uris: string[],
  workDir: string,
  format: DistributedFormat,
): Promise<string[]> {
  const chunksDir = join(workDir, "chunks");
  mkdirSync(chunksDir, { recursive: true });
  // Each chunk is an independent GCS GET (+ untar for png-sequence). Run
  // them in parallel — assemble's wall-clock is otherwise dominated by
  // `Σ chunk-download-ms` instead of `max(chunk-download-ms)`. Preserve the
  // input order by writing into a pre-sized array rather than pushing as
  // each task settles.
  const local: string[] = new Array<string>(uris.length);
  await Promise.all(
    uris.map(async (uri, i) => {
      if (!uri) {
        throw new Error(`[handler] chunk URI at index ${i} is empty`);
      }
      const { key } = parseGcsUri(uri);
      const localPath = join(chunksDir, basename(key));
      await downloadGcsObjectToFile(storage, uri, localPath);
      if (format === "png-sequence") {
        const dirPath = join(chunksDir, `frames-${pad(i)}`);
        await untarDirectory(localPath, dirPath);
        local[i] = dirPath;
      } else {
        local[i] = localPath;
      }
    }),
  );
  return local;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Collect every GCS URI that the handler will touch for a given event. */
// This exhaustive event projection is the bucket-allowlist security boundary.
// fallow-ignore-next-line complexity
function getEventGcsUris(event: PlanEvent | RenderChunkEvent | AssembleEvent): string[] {
  switch (event.Action) {
    case "plan":
      return [event.ProjectGcsUri, event.PlanOutputGcsPrefix];
    case "renderChunk":
      return [
        event.PlanV2ManifestGcsUri,
        event.PlanV2ArtifactGcsPrefix,
        event.ChunkOutputGcsPrefix,
      ];
    case "assemble":
      return [
        event.PlanV2ManifestGcsUri,
        event.PlanV2ArtifactGcsPrefix,
        ...event.ChunkGcsUris,
        event.OutputGcsUri,
        event.AudioGcsUri,
      ].filter((u): u is string => u != null);
  }
}

/** Emit the "guard disabled" warning at most once per instance. */
let warnedAllowlistDisabled = false;

/**
 * Verify every GCS URI in the event resolves to the configured render
 * bucket. Throws `GCS_URI_NOT_ALLOWED` (non-retryable) when a URI targets a
 * different bucket, preventing request injection from reading or writing
 * arbitrary GCS data.
 *
 * Opt-out is explicit: set `HYPERFRAMES_RENDER_BUCKET="*"` to disable the
 * guard intentionally. If the env var is simply unset (or empty), the guard
 * is disabled but a warning is logged once so the gap is visible in Cloud
 * Logging — it shouldn't silently fail open. The Terraform module always
 * wires the bucket name, so the prod path enforces.
 */
// fallow-ignore-next-line complexity
function validateEventGcsUris(event: PlanEvent | RenderChunkEvent | AssembleEvent): void {
  const allowedBucket = process.env.HYPERFRAMES_RENDER_BUCKET?.trim();
  if (allowedBucket === "*") return; // explicit, intentional opt-out
  if (!allowedBucket) {
    if (!warnedAllowlistDisabled) {
      warnedAllowlistDisabled = true;
      logEvent({
        event: "bucket_allowlist_disabled",
        level: "WARNING",
        message:
          "HYPERFRAMES_RENDER_BUCKET is unset — the GCS bucket-allowlist guard is DISABLED. " +
          'Set it to the render bucket name to enforce, or to "*" to opt out intentionally.',
      });
    }
    return;
  }

  for (const uri of getEventGcsUris(event)) {
    const { bucket } = parseGcsUri(uri);
    if (bucket !== allowedBucket) {
      const err = new Error(
        `[handler] GCS_URI_NOT_ALLOWED: URI ${JSON.stringify(uri)} targets bucket "${bucket}" but only "${allowedBucket}" is permitted`,
      );
      err.name = "GCS_URI_NOT_ALLOWED";
      throw err;
    }
  }
}

function pad(n: number): string {
  return n.toString().padStart(4, "0");
}

function trimTrailingSlash(prefix: string): string {
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function cleanupDir(dir: string): void {
  try {
    // Cloud Run re-uses an instance's filesystem across requests; clean up
    // aggressively so we don't leak a chunk-sized footprint between renders
    // (the writable filesystem counts against the instance's memory).
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — leak is preferable to crashing on the success path.
  }
}

// ── HTTP shell ───────────────────────────────────────────────────────────────

/**
 * Error names the workflow treats as non-retryable. A request that fails
 * with one of these is the caller's fault (bad input, misrouted chunk) and
 * retrying it just burns instance-seconds, so we map them to HTTP 400 while
 * any other failure maps to 500 (which the workflow retry policy backs off
 * and re-attempts). Keep this list in sync with the `retry` predicate in
 * `packages/gcp-cloud-run/terraform/workflow.yaml`.
 */
const NON_RETRYABLE_ERROR_NAMES = new Set([
  // Handler-boundary guards.
  "GCS_URI_NOT_ALLOWED",
  "PLAN_HASH_MISMATCH",
  "PLAN_ARTIFACT_DIGEST_MISMATCH",
  "PLAN_PROTOCOL_UNSUPPORTED",
  "PLAN_V2_INTEGRITY_UNRECOVERABLE",
  "VIDEO_SOURCE_UNRENDERABLE",
  "INVALID_VIDEO_METADATA",
  "CHUNK_EXCEEDS_WORKER_TIMEOUT",
  "NOT_MEDIA_PAYLOAD",
  // Producer error class names (`.name`) + their string code aliases — the
  // class sets `.name` to the class name but wraps a `code`; cover both so a
  // raw-code throw is caught too. Mirrors the AWS state machine's
  // non-retryable list.
  "FormatNotSupportedInDistributedError",
  "NotMediaPayloadError",
  "PlanProtocolUnsupportedError",
  "PlanV2IntegrityError",
  "RenderChunkValidationError",
  "FFMPEG_VERSION_MISMATCH",
  "FORMAT_NOT_SUPPORTED_IN_DISTRIBUTED",
  "BROWSER_GPU_NOT_SOFTWARE",
  "FONT_FETCH_FAILED",
  "ChromeBinaryUnavailableError",
  "ImageMissingFromFrameError",
]);

/**
 * Build the Hono app. A single `POST /` endpoint dispatches on the body's
 * `Action` field — the workflow points every step (plan, each renderChunk,
 * assemble) at the same URL and varies only the body. `GET /healthz` backs
 * the Cloud Run startup/liveness probe.
 *
 * `deps` is threaded through so tests can drive the real HTTP surface with
 * an injected Storage double + mocked primitives.
 */
export function createApp(deps?: HandlerDeps): Hono {
  const app = new Hono();
  const studioDist = join(fileURLToPath(import.meta.url), "../../../studio/dist");
  const studioUiAvailable = existsSync(join(studioDist, "index.html"));
  const maxConcurrentRenders = parseMaxConcurrentRenders(deps?.maxConcurrentRenders);
  const renderQueue = createRenderQueueController(maxConcurrentRenders, deps?.renderExecutor);
  const expectedServiceToken = () =>
    deps?.serviceToken ?? process.env.DATFRAMES_STUDIO_SERVICE_TOKEN?.trim();

  const runtimeSummary = () => ({
    service: "hyperframes-runtime",
    version: PACKAGE_VERSION,
    studioUiAvailable,
    datframesConfigured: Boolean(process.env.DATFRAMES_API_URL?.trim() && expectedServiceToken()),
    activeRenders: renderQueue.activeCount(),
    queuedRenders: renderQueue.queuedCount(),
    maxConcurrentRenders,
    renderEngine: deps?.studioAdapter ? "custom-adapter" : "producer",
    lintEngine: deps?.studioAdapter ? "custom-adapter" : "hyperframes-lint",
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("Vary", "Accept-Encoding");
  });
  app.use("*", compress());
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    }
  });

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      ...runtimeSummary(),
    }),
  );
  app.get("/api/runtime.js", (c) => {
    const runtimeSource = loadHyperframeRuntimeSource();
    if (!runtimeSource) return c.text("HyperFrames runtime is unavailable.", 404);
    return c.body(runtimeSource, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  });

  app.get("/api/runtime/info", (c) =>
    c.json({
      ...runtimeSummary(),
      capabilities: [
        "studio",
        "render",
        "render-status",
        "render-cancel",
        "lint",
        "lint-project",
        "thumbnails",
        "cache-invalidate",
      ],
    }),
  );

  // fallow-ignore-next-line complexity
  app.post("/", async (c) => {
    const sentByBrowserPage = c.req.header("origin") !== undefined;
    if (sentByBrowserPage) {
      return c.json(
        { error: "FORBIDDEN", message: "requests from a browser page are refused" },
        403,
      );
    }
    let body: CloudRunEvent;
    try {
      body = (await c.req.json()) as CloudRunEvent;
    } catch {
      return c.json({ error: "BAD_REQUEST", message: "request body must be JSON" }, 400);
    }
    try {
      const result = await dispatch(body, deps);
      return c.json(result, 200);
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const status = name && NON_RETRYABLE_ERROR_NAMES.has(name) ? 400 : 500;
      // Surface `error` (the name) as the discriminator the workflow's
      // retry predicate keys off, plus `message` for human triage.
      return c.json({ error: name ?? "RenderError", message }, status);
    }
  });

  const testProject: ResolvedProject = {
    id: "hyperframes-studio-test",
    dir: process.cwd(),
    title: "HyperFrames Studio Test Project",
  };
  const fallbackProjects = deps?.projects ?? [testProject];
  const datframesProvider = deps ? null : createDatframesStudioProjectProviderFromEnv();
  const thumbnailGenerator = deps ? null : createStudioThumbnailGeneratorFromEnv();
  const bundleStudioProject = createStudioBundleCache(async (dir) => {
    try {
      const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
      return await bundleToSingleHtml(dir, { ...PREVIEW_BUNDLE_OPTIONS, stampHfIds: true });
    } catch {
      return null;
    }
  });

  const studioAdapter: StudioApiAdapter = deps?.studioAdapter ?? {
    listProjects: () => datframesProvider?.listProjects() ?? fallbackProjects,
    resolveProject: (id: string) =>
      datframesProvider?.resolveProject(id) ??
      fallbackProjects.find((project) => project.id === id) ??
      null,
    bundle: (dir, options) => {
      if (options?.onRead || options?.privateFiles) {
        return import("@hyperframes/core/compiler")
          .then(({ bundleToSingleHtml }) =>
            bundleToSingleHtml(dir, { ...PREVIEW_BUNDLE_OPTIONS, ...options }),
          )
          .catch(() => null);
      }
      return bundleStudioProject(dir);
    },
    getProjectSignature: (projectDir) => createProjectSignature(projectDir),
    invalidateProjectSignature: () => bundleStudioProject.invalidate(),
    lint: (html, opts) =>
      lintHyperframeHtml(html, {
        ...opts,
        host: "studio",
      }),
    lintProject: (projectDir) => lintProject(projectDir, undefined, { host: "studio" }),
    runtimeUrl: "/api/runtime.js",
    serverOrigin: () => process.env.HYPERFRAMES_INTERNAL_ORIGIN?.trim() || undefined,
    rendersDir: (project) => join(project.dir, "renders"),
    startRender: (renderOpts) => renderQueue.startRender(renderOpts),
    ...(thumbnailGenerator
      ? {
          generateThumbnail: (options) =>
            thumbnailGenerator.generate({
              previewUrl: options.previewUrl,
              seekTime: options.seekTime,
              width: options.width,
              height: options.height,
              outputWidth: options.outputWidth,
              outputHeight: options.outputHeight,
              selector: options.selector,
              selectorIndex: options.selectorIndex,
              format: options.format ?? "jpeg",
              signal: options.signal,
            }),
        }
      : {}),
  };

  app.get("/api/render/:jobId/status", async (c) => {
    const trusted = isTrustedServiceToken(c.req.header("authorization"), expectedServiceToken());
    if (
      !trusted &&
      requestFromAnotherSite({
        fetchSite: c.req.header("sec-fetch-site"),
        host: requestHost({
          host: c.req.header("host") ?? new URL(c.req.url).host,
          forwardedHost: c.req.header("x-forwarded-host"),
        }),
        referer: c.req.header("referer"),
      })
    ) {
      return c.json({ error: "forbidden: requested by another site", why: "another_site" }, 403);
    }

    const { jobId } = c.req.param();
    if (!jobId || jobId.includes("/") || jobId.includes("\\") || jobId.includes("\0")) {
      return c.json({ error: "forbidden" }, 403);
    }

    const record = renderQueue.getRecord(jobId);
    if (record) {
      const outputReady =
        record.state.status === "complete" &&
        Boolean(record.state.outputPath && existsSync(record.state.outputPath));
      return c.json({
        id: record.id,
        projectId: record.projectId,
        status: record.state.status,
        progress: record.state.progress,
        ...(record.state.stage ? { stage: record.state.stage } : {}),
        ...(record.state.error ? { error: record.state.error } : {}),
        filename: record.filename,
        outputReady,
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.state.audioLoweredDb !== undefined
          ? { audioLoweredDb: record.state.audioLoweredDb }
          : {}),
      });
    }

    const projects = await Promise.resolve(studioAdapter.listProjects()).catch(() => []);
    for (const project of projects) {
      const rendersDir = studioAdapter.rendersDir(project);
      for (const ext of [".mp4", ".webm", ".mov", ".gif"] as const) {
        const candidate = join(rendersDir, `${jobId}${ext}`);
        if (existsSync(candidate)) {
          const metaPath = join(rendersDir, `${jobId}.meta.json`);
          let meta: Record<string, unknown> = {};
          if (existsSync(metaPath)) {
            try {
              meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
            } catch {
              meta = {};
            }
          }
          const diskStatus = meta.status === "failed" ? "failed" : "complete";
          return c.json({
            id: jobId,
            projectId: project.id,
            status: diskStatus,
            progress: diskStatus === "complete" ? 100 : 0,
            filename: `${jobId}${ext}`,
            outputReady: diskStatus === "complete",
            ...(typeof meta.error === "string" ? { error: meta.error } : {}),
            ...(typeof meta.durationMs === "number" ? { durationMs: meta.durationMs } : {}),
            ...(typeof meta.audioLoweredDb === "number"
              ? { audioLoweredDb: meta.audioLoweredDb }
              : {}),
          });
        }
      }
      const metaOnlyPath = join(rendersDir, `${jobId}.meta.json`);
      if (existsSync(metaOnlyPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaOnlyPath, "utf8")) as Record<string, unknown>;
          if (meta.status === "failed") {
            return c.json({
              id: jobId,
              projectId: project.id,
              status: "failed",
              progress: 0,
              outputReady: false,
              ...(typeof meta.error === "string" ? { error: meta.error } : {}),
              ...(typeof meta.durationMs === "number" ? { durationMs: meta.durationMs } : {}),
            });
          }
        } catch {
          /* ignore malformed metadata */
        }
      }
    }

    return c.json({ error: "not found" }, 404);
  });

  app.post("/api/projects/:id/cache/invalidate", async (c) => {
    if (!isTrustedServiceToken(c.req.header("authorization"), expectedServiceToken())) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const projectId = c.req.param("id");
    datframesProvider?.invalidateProject(projectId);
    bundleStudioProject.invalidate();
    await deps?.onInvalidateCache?.(projectId);
    return c.json({ ok: true, invalidated: projectId });
  });

  const allowedHosts = [
    ...new Set([...previewAllowedHostsFromEnv(), ...(deps?.allowedHosts ?? [])]),
  ];
  const studioApi = createStudioApi(studioAdapter, {
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(thumbnailGenerator ? { sandboxThumbnailCaptures: true } : {}),
  });

  app.all("/api/*", async (c) => {
    const url = new URL(c.req.url);
    if (!deps && isDataDrivenSourceMutation(c.req.method, url.pathname)) {
      return c.json(
        {
          error: "DATA_DRIVEN_PROJECT_READ_ONLY",
          message:
            "Project source files are compiled artifacts. Update project data through the DATframes API.",
        },
        409,
      );
    }

    const trustedBackendCall =
      !c.req.header("origin") &&
      !c.req.header("sec-fetch-site") &&
      isTrustedServiceToken(c.req.header("authorization"), expectedServiceToken());

    url.pathname = url.pathname.slice(4); // Strip "/api" prefix
    const headers = new Headers(c.req.raw.headers);
    if (trustedBackendCall) {
      url.protocol = "http:";
      url.host = "127.0.0.1";
      headers.set("host", "127.0.0.1");
      headers.delete("x-forwarded-host");
      headers.set("sec-fetch-site", "same-origin");
      headers.set("referer", "http://127.0.0.1/");
    }

    const forwardReq = new Request(url.toString(), {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      // @ts-expect-error -- Node streaming body
      duplex: "half",
    });
    return studioApi.fetch(forwardReq);
  });

  if (existsSync(studioDist)) {
    app.use("/*", serveStatic({ root: "../studio/dist" }));
    app.get("*", (c) => {
      const indexPath = join(studioDist, "index.html");
      if (existsSync(indexPath)) {
        c.header("Cache-Control", "no-cache");
        return c.html(readFileSync(indexPath, "utf-8"));
      }
      return c.text("Studio UI index.html not found", 404);
    });
  }

  return app;
}

function isDataDrivenSourceMutation(method: string, pathname: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  return [
    "/files/",
    "/file-mutations/",
    "/gsap-mutation",
    "/duplicate-file",
    "/registry/install",
    "/media/remove-background",
  ].some((segment) => pathname.includes(segment));
}

/** Start the HTTP server. Cloud Run injects `PORT` (default 8080). */
export function startServer(): void {
  const port = Number(process.env.PORT ?? 8080);
  const app = createApp();
  serve({ fetch: app.fetch, port }, (info) => {
    logEvent({ event: "server_listening", port: info.port });
  });
}

// Boot when executed directly (the Dockerfile runs `node dist/server.js`),
// but not when imported by tests or the SDK.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
