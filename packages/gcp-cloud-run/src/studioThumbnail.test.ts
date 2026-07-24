import { describe, expect, it } from "bun:test";
import { internalStudioPreviewUrl } from "./studioThumbnail.js";

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
