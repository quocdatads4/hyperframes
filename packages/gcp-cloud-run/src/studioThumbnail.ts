import type { Browser, Page } from "puppeteer-core";
import { resolveChromeExecutablePath } from "./chromium.js";

export interface StudioThumbnailOptions {
  previewUrl: string;
  seekTime: number;
  width: number;
  height: number;
  format: "jpeg" | "png";
  selector?: string;
  selectorIndex?: number;
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

async function preparePage(page: Page, options: StudioThumbnailOptions): Promise<void> {
  await page.setViewport({
    width: Math.max(1, Math.floor(options.width)),
    height: Math.max(1, Math.floor(options.height)),
    deviceScaleFactor: 1,
  });
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
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await preparePage(page, options);
      await page.goto(internalStudioPreviewUrl(options.previewUrl, this.config.internalOrigin), {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      });
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
      await seekPreview(page, options.seekTime);
      await page.evaluate(async () => {
        document.documentElement.style.background = "#1c2028";
        document.body.style.background = "#1c2028";
        document.body.style.margin = "0";
        document.body.style.overflow = "hidden";
        await document.fonts?.ready;
      });
      await new Promise((resolve) => setTimeout(resolve, this.config.settleMs));

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
