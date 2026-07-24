import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ResolvedProject } from "@hyperframes/studio-server";

interface StudioProjectSummary {
  projectId: string;
  title: string;
  slug: string;
  sourceMode: "template";
  templateVersionId: string;
  dataChecksum: string;
  etag: string;
}

interface StudioProjectBootstrap extends StudioProjectSummary {
  entryFile: string;
}

interface StudioProjectArchiveFile {
  path: string;
  sha256: string;
  size: number;
  contentBase64: string;
}

interface StudioProjectArchive {
  format: "datframes-studio-archive-v1";
  projectId: string;
  entryFile: string;
  revision: string;
  dataChecksum: string;
  compiledManifestChecksum: string;
  etag: string;
  files: StudioProjectArchiveFile[];
}

interface CachedProjectMetadata {
  projectId: string;
  title: string;
  entryFile: string;
  etag: string;
  revision: string;
}

export interface DatframesStudioProjectProviderConfig {
  apiUrl: string;
  serviceToken: string;
  cacheRoot: string;
  maxArchiveBytes: number;
  requestTimeoutMs: number;
  revalidateMs: number;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`DATframes response field ${field} must be a non-empty string.`);
  }
  return value;
}

function parseSummary(value: unknown): StudioProjectSummary {
  if (!isRecord(value)) throw new Error("DATframes project summary must be an object.");
  const sourceMode = requiredString(value.sourceMode, "sourceMode");
  if (sourceMode !== "template")
    throw new Error(`Unsupported DATframes source mode: ${sourceMode}`);
  return {
    projectId: requiredString(value.projectId, "projectId"),
    title: requiredString(value.title, "title"),
    slug: requiredString(value.slug, "slug"),
    sourceMode,
    templateVersionId: requiredString(value.templateVersionId, "templateVersionId"),
    dataChecksum: requiredString(value.dataChecksum, "dataChecksum"),
    etag: requiredString(value.etag, "etag"),
  };
}

function parseBootstrap(value: unknown): StudioProjectBootstrap {
  if (!isRecord(value)) throw new Error("DATframes project bootstrap must be an object.");
  return {
    ...parseSummary(value),
    entryFile: requiredString(value.entryFile, "entryFile"),
  };
}

function parseArchiveFile(value: unknown): StudioProjectArchiveFile {
  if (!isRecord(value)) throw new Error("DATframes archive file must be an object.");
  const size = value.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("DATframes archive file size must be a non-negative integer.");
  }
  const sha256 = requiredString(value.sha256, "files.sha256");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("DATframes archive file sha256 is invalid.");
  }
  const contentBase64 = value.contentBase64;
  if (typeof contentBase64 !== "string") {
    throw new Error("DATframes archive file contentBase64 must be a string.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("DATframes archive file content is not valid base64.");
  }
  return {
    path: requiredString(value.path, "files.path"),
    sha256: sha256.toLowerCase(),
    size,
    contentBase64,
  };
}

function parseArchive(value: unknown): StudioProjectArchive {
  if (!isRecord(value)) throw new Error("DATframes project archive must be an object.");
  if (value.format !== "datframes-studio-archive-v1") {
    throw new Error(`Unsupported DATframes archive format: ${String(value.format)}`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("DATframes project archive must contain files.");
  }
  return {
    format: value.format,
    projectId: requiredString(value.projectId, "projectId"),
    entryFile: requiredString(value.entryFile, "entryFile"),
    revision: requiredString(value.revision, "revision"),
    dataChecksum: requiredString(value.dataChecksum, "dataChecksum"),
    compiledManifestChecksum: requiredString(
      value.compiledManifestChecksum,
      "compiledManifestChecksum",
    ),
    etag: requiredString(value.etag, "etag"),
    files: value.files.map(parseArchiveFile),
  };
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be configured as a positive integer.`);
  }
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function apiEndpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/${path.replace(/^\/+/, "")}`;
  base.search = "";
  base.hash = "";
  return base;
}

function projectCacheKey(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex");
}

function safeProjectFile(projectRoot: string, projectPath: string): string {
  const normalized = projectPath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`DATframes archive path is unsafe: ${projectPath}`);
  }
  const root = resolve(projectRoot);
  const target = resolve(root, normalized);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`DATframes archive path escapes project cache: ${projectPath}`);
  }
  return target;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class DatframesStudioProjectProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<ResolvedProject | null>>();
  private readonly resolvedProjects = new Map<
    string,
    { project: ResolvedProject; revalidateAt: number }
  >();
  private readonly titles = new Map<string, string>();

  constructor(private readonly config: DatframesStudioProjectProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
    if (!Number.isSafeInteger(config.maxArchiveBytes) || config.maxArchiveBytes < 1) {
      throw new Error("maxArchiveBytes must be a positive integer.");
    }
    if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(config.revalidateMs) || config.revalidateMs < 1) {
      throw new Error("revalidateMs must be a positive integer.");
    }
  }

  private async request(path: string): Promise<unknown> {
    const response = await this.fetchImpl(apiEndpoint(this.config.apiUrl, path), {
      headers: {
        authorization: `Bearer ${this.config.serviceToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`DATframes API ${response.status} for ${path}: ${detail}`);
    }
    return await response.json();
  }

  async listProjects(): Promise<ResolvedProject[]> {
    const value = await this.request("/internal/hyperframes/projects");
    if (!Array.isArray(value)) throw new Error("DATframes projects response must be an array.");
    return value.map(parseSummary).map((project) => {
      this.titles.set(project.projectId, project.title);
      return {
        id: project.projectId,
        dir: this.projectDirectory(project.projectId),
        title: project.title,
      };
    });
  }

  resolveProject(projectId: string): Promise<ResolvedProject | null> {
    const cached = this.resolvedProjects.get(projectId);
    if (cached && cached.revalidateAt > this.now()) {
      return Promise.resolve(cached.project);
    }
    const active = this.inFlight.get(projectId);
    if (active) return active;
    const operation = this.resolveProjectUncached(projectId)
      .then((project) => {
        if (project) {
          this.resolvedProjects.set(projectId, {
            project,
            revalidateAt: this.now() + this.config.revalidateMs,
          });
        } else {
          this.resolvedProjects.delete(projectId);
        }
        return project;
      })
      .finally(() => {
        this.inFlight.delete(projectId);
      });
    this.inFlight.set(projectId, operation);
    return operation;
  }

  private projectDirectory(projectId: string): string {
    return join(resolve(this.config.cacheRoot), "projects", projectCacheKey(projectId));
  }

  private metadataPath(projectId: string): string {
    return join(resolve(this.config.cacheRoot), "metadata", `${projectCacheKey(projectId)}.json`);
  }

  private async readMetadata(projectId: string): Promise<CachedProjectMetadata | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.metadataPath(projectId), "utf8"));
      if (!isRecord(value)) return null;
      return {
        projectId: requiredString(value.projectId, "metadata.projectId"),
        title: requiredString(value.title, "metadata.title"),
        entryFile: requiredString(value.entryFile, "metadata.entryFile"),
        etag: requiredString(value.etag, "metadata.etag"),
        revision: requiredString(value.revision, "metadata.revision"),
      };
    } catch {
      return null;
    }
  }

  private async resolveProjectUncached(projectId: string): Promise<ResolvedProject | null> {
    let bootstrap: StudioProjectBootstrap;
    try {
      bootstrap = parseBootstrap(
        await this.request(
          `/internal/hyperframes/projects/${encodeURIComponent(projectId)}/bootstrap`,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("DATframes API 404")) return null;
      throw error;
    }
    if (bootstrap.projectId !== projectId) {
      throw new Error(
        `DATframes bootstrap returned project ${bootstrap.projectId} for ${projectId}.`,
      );
    }
    const projectDir = this.projectDirectory(projectId);
    const cached = await this.readMetadata(projectId);
    if (
      cached?.projectId === projectId &&
      cached.etag === bootstrap.etag &&
      (await fileExists(safeProjectFile(projectDir, cached.entryFile)))
    ) {
      return {
        id: projectId,
        dir: projectDir,
        title: this.titles.get(projectId) ?? cached.title,
      };
    }

    const archive = parseArchive(
      await this.request(`/internal/hyperframes/projects/${encodeURIComponent(projectId)}/archive`),
    );
    if (archive.projectId !== projectId || archive.etag !== bootstrap.etag) {
      throw new Error("DATframes bootstrap and archive revisions do not match.");
    }
    await this.materializeArchive(projectDir, archive);
    const metadata: CachedProjectMetadata = {
      projectId,
      title: this.titles.get(projectId) ?? bootstrap.title,
      entryFile: archive.entryFile,
      etag: archive.etag,
      revision: archive.revision,
    };
    const metadataPath = this.metadataPath(projectId);
    await mkdir(dirname(metadataPath), { recursive: true });
    const stagingMetadata = `${metadataPath}.${randomUUID()}.tmp`;
    await writeFile(stagingMetadata, `${JSON.stringify(metadata)}\n`, "utf8");
    await rename(stagingMetadata, metadataPath);
    return { id: projectId, dir: projectDir, title: metadata.title };
  }

  private async materializeArchive(
    projectDir: string,
    archive: StudioProjectArchive,
  ): Promise<void> {
    const cacheRoot = resolve(this.config.cacheRoot);
    const stagingRoot = join(
      cacheRoot,
      "staging",
      `${projectCacheKey(archive.projectId)}-${randomUUID()}`,
    );
    const seenPaths = new Set<string>();
    let totalBytes = 0;
    await mkdir(stagingRoot, { recursive: true });
    try {
      for (const file of archive.files) {
        if (seenPaths.has(file.path))
          throw new Error(`Duplicate DATframes archive path: ${file.path}`);
        seenPaths.add(file.path);
        totalBytes += file.size;
        if (totalBytes > this.config.maxArchiveBytes) {
          throw new Error(`DATframes archive exceeds ${this.config.maxArchiveBytes} bytes.`);
        }
        const content = Buffer.from(file.contentBase64, "base64");
        const checksum = createHash("sha256").update(content).digest("hex");
        if (content.length !== file.size || checksum !== file.sha256) {
          throw new Error(`DATframes archive verification failed: ${file.path}`);
        }
        const target = safeProjectFile(stagingRoot, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      if (!seenPaths.has(archive.entryFile)) {
        throw new Error(`DATframes archive is missing entry file: ${archive.entryFile}`);
      }
      await mkdir(dirname(projectDir), { recursive: true });
      await rm(projectDir, { recursive: true, force: true });
      await rename(stagingRoot, projectDir);
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }
}

export function createDatframesStudioProjectProviderFromEnv(): DatframesStudioProjectProvider {
  return new DatframesStudioProjectProvider({
    apiUrl: requiredEnv("DATFRAMES_API_URL"),
    serviceToken: requiredEnv("DATFRAMES_STUDIO_SERVICE_TOKEN"),
    cacheRoot: requiredEnv("HYPERFRAMES_PROJECT_CACHE_ROOT"),
    maxArchiveBytes: positiveInteger(
      process.env.HYPERFRAMES_PROJECT_ARCHIVE_MAX_BYTES,
      "HYPERFRAMES_PROJECT_ARCHIVE_MAX_BYTES",
    ),
    requestTimeoutMs: positiveInteger(
      process.env.DATFRAMES_API_TIMEOUT_MS,
      "DATFRAMES_API_TIMEOUT_MS",
    ),
    revalidateMs: positiveInteger(
      process.env.HYPERFRAMES_PROJECT_REVALIDATE_MS,
      "HYPERFRAMES_PROJECT_REVALIDATE_MS",
    ),
  });
}
