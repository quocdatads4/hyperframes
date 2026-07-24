import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { DatframesStudioProjectProvider } from "./datframesStudioAdapter.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function archiveFile(path: string, content: string) {
  const bytes = Buffer.from(content);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    contentBase64: bytes.toString("base64"),
  };
}

describe("DatframesStudioProjectProvider", () => {
  it("lists real projects and materializes a verified project archive once per ETag", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "hf-datframes-provider-"));
    temporaryRoots.push(cacheRoot);
    let archiveRequests = 0;
    let bootstrapRequests = 0;
    let now = 1_000;
    const fetchImpl: typeof fetch = async (input) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname.endsWith("/internal/hyperframes/projects")) {
        return Response.json([
          {
            projectId: "project-1",
            title: "Data Project",
            slug: "data-project",
            sourceMode: "template",
            templateVersionId: "template-v1",
            dataChecksum: "a".repeat(64),
            etag: '"etag-1"',
            updatedAt: "2026-07-24T00:00:00.000Z",
          },
        ]);
      }
      if (pathname.endsWith("/bootstrap")) {
        bootstrapRequests += 1;
        return Response.json({
          projectId: "project-1",
          title: "Data Project",
          slug: "data-project",
          sourceMode: "template",
          templateVersionId: "template-v1",
          dataChecksum: "a".repeat(64),
          etag: '"etag-1"',
          entryFile: "index.html",
        });
      }
      if (pathname.endsWith("/archive")) {
        archiveRequests += 1;
        return Response.json({
          format: "datframes-studio-archive-v1",
          projectId: "project-1",
          entryFile: "index.html",
          revision: "revision-1",
          dataChecksum: "a".repeat(64),
          compiledManifestChecksum: "b".repeat(64),
          etag: '"etag-1"',
          files: [
            archiveFile("index.html", "<html>from data</html>"),
            archiveFile("manifest.json", "{}\n"),
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };
    const provider = new DatframesStudioProjectProvider({
      apiUrl: "https://frames-api.example.test",
      serviceToken: "test-token",
      cacheRoot,
      maxArchiveBytes: 10_000,
      requestTimeoutMs: 5_000,
      revalidateMs: 5_000,
      fetchImpl,
      now: () => now,
    });

    expect(await provider.listProjects()).toHaveLength(1);
    const first = await provider.resolveProject("project-1");
    const second = await provider.resolveProject("project-1");

    expect(first?.id).toBe("project-1");
    expect(second?.dir).toBe(first?.dir);
    expect(await readFile(join(first!.dir, "index.html"), "utf8")).toContain("from data");
    expect(archiveRequests).toBe(1);
    expect(bootstrapRequests).toBe(1);

    now += 5_001;
    await provider.resolveProject("project-1");
    expect(bootstrapRequests).toBe(2);
    expect(archiveRequests).toBe(1);
  });

  it("rejects archive content that does not match its checksum", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "hf-datframes-provider-"));
    temporaryRoots.push(cacheRoot);
    const fetchImpl: typeof fetch = async (input) => {
      const pathname = new URL(input.toString()).pathname;
      if (pathname.endsWith("/bootstrap")) {
        return Response.json({
          projectId: "project-1",
          title: "Data Project",
          slug: "data-project",
          sourceMode: "template",
          templateVersionId: "template-v1",
          dataChecksum: "a".repeat(64),
          etag: '"etag-1"',
          entryFile: "index.html",
        });
      }
      return Response.json({
        format: "datframes-studio-archive-v1",
        projectId: "project-1",
        entryFile: "index.html",
        revision: "revision-1",
        dataChecksum: "a".repeat(64),
        compiledManifestChecksum: "b".repeat(64),
        etag: '"etag-1"',
        files: [
          {
            ...archiveFile("index.html", "<html></html>"),
            sha256: "0".repeat(64),
          },
        ],
      });
    };
    const provider = new DatframesStudioProjectProvider({
      apiUrl: "https://frames-api.example.test",
      serviceToken: "test-token",
      cacheRoot,
      maxArchiveBytes: 10_000,
      requestTimeoutMs: 5_000,
      revalidateMs: 5_000,
      fetchImpl,
    });

    await expect(provider.resolveProject("project-1")).rejects.toThrow(
      /archive verification failed/,
    );
  });
});
