import type { Browser, Page } from "puppeteer-core";
import { grantCaptureLoads, thumbnailDeviceScaleFactor } from "@hyperframes/studio-server";
import { resolveChromeExecutablePath } from "./chromium.js";

export interface StudioThumbnailOptions {
  previewUrl: string;
  seekTime: number;
  width: number;
  height: number;
  outputWidth?: number;
  outputHeight?: number;
  format: "jpeg" | "png";
  selector?: string;
  selectorIndex?: number;
  signal?: AbortSignal;
}

export interface StudioThumbnailConfig {
  internalOrigin: string;
  navigationTimeoutMs: number;
  timelineTimeoutMs: number;
  settleMs: number;
  executablePath: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be configured as a positive integer.`);
  }
  return parsed;
}

export function internalStudioPreviewUrl(previewUrl: string, internalOrigin: string): string {
  const source = new URL(previewUrl);
  const internal = new URL(internalOrigin);
  source.protocol = internal.protocol;
  source.hostname = internal.hostname;
  source.port = internal.port;
  source.username = "";
  source.password = "";
  return source.toString();
}

async function seekPreview(page: Page, seekTime: number): Promise<void> {
  await page.evaluate((time: number) => {
    const runtimeWindow = window as Window & {
      __player?: { seek?: (value: number) => void };
      __timelines?: Record<string, { pause?: (value?: number) => void }>;
      gsap?: { ticker?: { tick?: () => void } };
    };
    if (typeof runtimeWindow.__player?.seek === "function") {
      runtimeWindow.__player.seek(time);
      return;
    }
    for (const timeline of Object.values(runtimeWindow.__timelines ?? {})) {
      timeline.pause?.(time);
    }
    runtimeWindow.gsap?.ticker?.tick?.();
  }, seekTime);
}

export function resolveThumbnailViewport(options: {
  width: number;
  height: number;
  outputWidth?: number;
  outputHeight?: number;
}): { width: number; height: number; deviceScaleFactor: number } {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  let deviceScaleFactor = 1;
  if (
    typeof options.outputWidth === "number" &&
    typeof options.outputHeight === "number" &&
    Number.isFinite(options.outputWidth) &&
    Number.isFinite(options.outputHeight) &&
    options.outputWidth > 0 &&
    options.outputHeight > 0
  ) {
    deviceScaleFactor = thumbnailDeviceScaleFactor({
      width,
      height,
      outputWidth: options.outputWidth,
      outputHeight: options.outputHeight,
    });
  }
  return { width, height, deviceScaleFactor };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Thumbnail generation aborted", "AbortError");
  }
}

async function preparePage(page: Page, options: StudioThumbnailOptions): Promise<void> {
  await page.setViewport(resolveThumbnailViewport(options));
}

export class StudioThumbnailGenerator {
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: StudioThumbnailConfig) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.browserPromise) return this.browserPromise;
    this.browserPromise = (async () => {
      const puppeteer = await import("puppeteer-core");
      const browser = await puppeteer.default.launch({
        headless: true,
        executablePath: this.config.executablePath,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--enable-webgl",
          "--ignore-gpu-blocklist",
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      });
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = null;
      });
      this.browser = browser;
      return browser;
    })().finally(() => {
      this.browserPromise = null;
    });
    return this.browserPromise;
  }

  async generate(options: StudioThumbnailOptions): Promise<Buffer> {
    throwIfAborted(options.signal);
    const targetUrl = internalStudioPreviewUrl(options.previewUrl, this.config.internalOrigin);
    const targetOrigin = new URL(targetUrl).origin;
    const browser = await this.getBrowser();
    throwIfAborted(options.signal);
    const page = await browser.newPage();
    try {
      await preparePage(page, options);
      await page.setExtraHTTPHeaders({ referer: `${targetOrigin}/` });
      const cdp = await page.createCDPSession();
      await grantCaptureLoads(cdp as unknown as Parameters<typeof grantCaptureLoads>[0], targetUrl);
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      });
      throwIfAborted(options.signal);
      await page
        .waitForFunction(
          () => {
            const runtimeWindow = window as Window & {
              __timelines?: Record<string, unknown>;
            };
            return Object.keys(runtimeWindow.__timelines ?? {}).length > 0;
          },
          { timeout: this.config.timelineTimeoutMs },
        )
        .catch(() => undefined);
      throwIfAborted(options.signal);
      await seekPreview(page, options.seekTime);
      await page.evaluate(async () => {
        document.documentElement.style.background = "#1c2028";
        document.body.style.background = "#1c2028";
        document.body.style.margin = "0";
        document.body.style.overflow = "hidden";
        await document.fonts?.ready;
      });
      await new Promise((resolve) => setTimeout(resolve, this.config.settleMs));
      throwIfAborted(options.signal);

      if (options.selector) {
        const elements = await page.$$(options.selector);
        const index = Math.max(0, Math.floor(options.selectorIndex ?? 0));
        const element = elements[index];
        if (!element) throw new Error(`Thumbnail selector did not match: ${options.selector}`);
        const content =
          options.format === "png"
            ? await element.screenshot({ type: "png" })
            : await element.screenshot({ type: "jpeg", quality: 75 });
        return Buffer.from(content);
      }
      const content =
        options.format === "png"
          ? await page.screenshot({ type: "png" })
          : await page.screenshot({ type: "jpeg", quality: 75 });
      return Buffer.from(content);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

export function createStudioThumbnailGeneratorFromEnv(): StudioThumbnailGenerator {
  return new StudioThumbnailGenerator({
    internalOrigin: requiredEnv("HYPERFRAMES_INTERNAL_ORIGIN"),
    navigationTimeoutMs: positiveInteger(
      process.env.HYPERFRAMES_THUMBNAIL_NAVIGATION_TIMEOUT_MS,
      "HYPERFRAMES_THUMBNAIL_NAVIGATION_TIMEOUT_MS",
    ),
    timelineTimeoutMs: positiveInteger(
      process.env.HYPERFRAMES_THUMBNAIL_TIMELINE_TIMEOUT_MS,
      "HYPERFRAMES_THUMBNAIL_TIMELINE_TIMEOUT_MS",
    ),
    settleMs: positiveInteger(
      process.env.HYPERFRAMES_THUMBNAIL_SETTLE_MS,
      "HYPERFRAMES_THUMBNAIL_SETTLE_MS",
    ),
    executablePath: resolveChromeExecutablePath(),
  });
}
