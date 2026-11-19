import { describe, expect, it } from "bun:test";
import { internalStudioPreviewUrl, resolveThumbnailViewport } from "./studioThumbnail.js";

describe("internalStudioPreviewUrl", () => {
  it("keeps the preview path and query while routing Chrome to the local server", () => {
    expect(
      internalStudioPreviewUrl(
        "http://hyperapi.datmarketing.edu.vn/api/projects/project-1/preview/comp/scene.html?t=3",
        "http://127.0.0.1:8080",
      ),
    ).toBe("http://127.0.0.1:8080/api/projects/project-1/preview/comp/scene.html?t=3");
  });
});

describe("resolveThumbnailViewport", () => {
  it("scales viewport DPR down to bounded output dimensions", () => {
    const viewport = resolveThumbnailViewport({
      width: 1920,
      height: 1080,
      outputWidth: 240,
      outputHeight: 135,
    });
    expect(viewport.width).toBe(1920);
    expect(viewport.height).toBe(1080);
    expect(viewport.deviceScaleFactor).toBeCloseTo(0.125, 4);
  });

  it("defaults DPR to 1 when output dimensions are omitted", () => {
    expect(resolveThumbnailViewport({ width: 1080, height: 1920 })).toEqual({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
    });
  });
});
