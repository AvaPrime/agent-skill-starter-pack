/**
 * @module skills/web-scraper
 * @description Production web scraping skill using Playwright for JS-rendered pages
 * and Cheerio for static HTML. Includes stealth mode, rate limiting, and screenshot capture.
 *
 * @example
 * ```ts
 * const result = await executor.run(webScraperSkill, {
 *   url: 'https://example.com',
 *   selectors: { title: 'h1', price: '.price' },
 *   mode: 'static',
 * }, taskId);
 * ```
 */

import { z } from 'zod';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { BaseSkill } from '../../core/base-skill';
import { SkillDefinition, ExecutionContext, SkillHealthStatus } from '../../core/types';
import { SkillExecutionError } from '../../core/executor';

// ── Input Schema ──────────────────────────────────────────────────────────────

export const WebScraperInputSchema = z.object({
  /** Target URL to scrape */
  url: z.string().url('Must be a valid URL'),
  /** CSS selectors mapped to output field names */
  selectors: z.record(z.string()).optional(),
  /** XPath expressions mapped to output field names */
  xpathSelectors: z.record(z.string()).optional(),
  /** Scraping mode: static uses Cheerio, dynamic uses Playwright */
  mode: z.enum(['static', 'dynamic']).default('static'),
  /** Wait for this CSS selector before extracting (dynamic mode only) */
  waitForSelector: z.string().optional(),
  /** Additional HTTP headers */
  headers: z.record(z.string()).optional(),
  /** Whether to capture a screenshot (dynamic mode only) */
  captureScreenshot: z.boolean().default(false),
  /** Proxy URL (e.g. http://user:pass@proxy:8080) */
  proxyUrl: z.string().url().optional(),
  /** Request timeout in milliseconds */
  timeoutMs: z.number().min(1000).max(60000).default(15000),
  /** Follow redirects */
  followRedirects: z.boolean().default(true),
  /** Custom user agent */
  userAgent: z.string().optional(),
  /** Whether to extract all links from the page */
  extractLinks: z.boolean().default(false),
  /** Whether to extract all images from the page */
  extractImages: z.boolean().default(false),
});

export type WebScraperInput = z.infer<typeof WebScraperInputSchema>;

// ── Output Schema ─────────────────────────────────────────────────────────────

export const WebScraperOutputSchema = z.object({
  url: z.string(),
  statusCode: z.number(),
  title: z.string().optional(),
  /** Extracted data mapped from selectors */
  extracted: z.record(z.string()),
  /** Full page text content */
  textContent: z.string().optional(),
  /** Raw HTML (truncated to 500KB) */
  html: z.string().optional(),
  /** All href links found on the page */
  links: z.array(z.string()).optional(),
  /** All image src URLs found on the page */
  images: z.array(z.string()).optional(),
  /** Base64-encoded PNG screenshot (dynamic mode only) */
  screenshot: z.string().optional(),
  /** Response headers */
  responseHeaders: z.record(z.string()).optional(),
  scrapedAt: z.string(),
});

export type WebScraperOutput = z.infer<typeof WebScraperOutputSchema>;

// ── Skill Definition ──────────────────────────────────────────────────────────

export const webScraperDefinition: SkillDefinition<WebScraperInput, WebScraperOutput> = {
  id: 'web-scraper',
  name: 'Web Scraper',
  version: '1.0.0',
  description:
    'Scrape web pages using CSS selectors or XPath. Supports static HTML (Cheerio) and JS-rendered pages (Playwright).',
  inputSchema: WebScraperInputSchema,
  outputSchema: WebScraperOutputSchema,
  category: 'web-scraping',
  tags: ['scraping', 'html', 'playwright', 'cheerio', 'extraction'],
  supportsStreaming: false,
  maxConcurrency: 5,
  config: {
    timeoutMs: 30000,
    maxRetries: 3,
    retryDelayMs: 2000,
    retryBackoffMultiplier: 2,
    cacheTtlSeconds: 300, // 5 minutes
    rateLimit: { maxRequests: 10, windowMs: 60000 },
  },
};

// ── Skill Implementation ──────────────────────────────────────────────────────

export class WebScraperSkill extends BaseSkill<WebScraperInput, WebScraperOutput> {
  readonly definition = webScraperDefinition;

  protected async executeImpl(
    input: WebScraperInput,
    context: ExecutionContext,
  ): Promise<WebScraperOutput> {
    this.logger.info(
      { url: input.url, mode: input.mode, executionId: context.executionId },
      'Scraping URL',
    );

    if (input.mode === 'dynamic') {
      return this.scrapeDynamic(input, context);
    }
    return this.scrapeStatic(input);
  }

  // ── Static scraping with Axios + Cheerio ──────────────────────────────────

  private async scrapeStatic(input: WebScraperInput): Promise<WebScraperOutput> {
    this.trackApiCall();

    let response;
    try {
      response = await axios.get(input.url, {
        timeout: input.timeoutMs,
        maxRedirects: input.followRedirects ? 5 : 0,
        headers: {
          'User-Agent': input.userAgent ?? 'Mozilla/5.0 (compatible; AgentSkillBot/1.0)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...input.headers,
        },
        proxy: input.proxyUrl ? this.parseProxy(input.proxyUrl) : undefined,
        validateStatus: null, // don't throw on 4xx/5xx
      });
    } catch (err) {
      throw new SkillExecutionError(
        `HTTP request failed: ${(err as Error).message}`,
        'HTTP_REQUEST_FAILED',
        true, // retryable
      );
    }

    const $ = cheerio.load(response.data as string);
    const extracted: Record<string, string> = {};

    // Apply CSS selectors
    if (input.selectors) {
      for (const [key, selector] of Object.entries(input.selectors)) {
        extracted[key] =
          $(selector).first().text().trim() || $(selector).first().attr('content') || '';
      }
    }

    const output: WebScraperOutput = {
      url: input.url,
      statusCode: response.status,
      title: $('title').text().trim() || $('h1').first().text().trim() || undefined,
      extracted,
      textContent: $('body').text().replace(/\s+/g, ' ').trim().substring(0, 50000),
      html: (response.data as string).substring(0, 500000),
      responseHeaders: response.headers as Record<string, string>,
      scrapedAt: new Date().toISOString(),
    };

    if (input.extractLinks) {
      output.links = [];
      $('a[href]').each((_: number, el: cheerio.Element) => {
        const href = $(el).attr('href');
        if (href) output.links!.push(this.resolveUrl(input.url, href));
      });
    }

    if (input.extractImages) {
      output.images = [];
      $('img[src]').each((_: number, el: cheerio.Element) => {
        const src = $(el).attr('src');
        if (src) output.images!.push(this.resolveUrl(input.url, src));
      });
    }

    return output;
  }

  // ── Dynamic scraping with Playwright ─────────────────────────────────────

  private async scrapeDynamic(
    input: WebScraperInput,
    _context: ExecutionContext,
  ): Promise<WebScraperOutput> {
    let browser: import('playwright').Browser | undefined;
    let page: import('playwright').Page | undefined;

    try {
      const { chromium } = await import('playwright');
      this.trackApiCall();

      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          ...(input.proxyUrl ? [`--proxy-server=${input.proxyUrl}`] : []),
        ],
      });

      const browserContext = await browser.newContext({
        userAgent:
          input.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        extraHTTPHeaders: input.headers ?? {},
        ignoreHTTPSErrors: false,
      });

      page = await browserContext.newPage();

      await page.addInitScript({
        content: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });',
      });

      const response = await page.goto(input.url, {
        timeout: input.timeoutMs,
        waitUntil: 'networkidle',
      });

      if (input.waitForSelector) {
        await page.waitForSelector(input.waitForSelector, { timeout: 10000 });
      }

      const html = await page.content();
      const extracted: Record<string, string> = {};

      if (input.selectors) {
        for (const [key, selector] of Object.entries(input.selectors)) {
          try {
            extracted[key] =
              (await page.$eval(selector, (el) => {
                const candidate = el as { textContent?: unknown };
                const textContent = candidate.textContent;
                return typeof textContent === 'string' ? textContent.trim() : '';
              })) || '';
          } catch {
            extracted[key] = ''; // selector not found
          }
        }
      }

      const output: WebScraperOutput = {
        url: input.url,
        statusCode: response?.status() ?? 200,
        title: await page.title(),
        extracted,
        textContent: (await page.innerText('body')).substring(0, 50000),
        html: html.substring(0, 500000),
        scrapedAt: new Date().toISOString(),
      };

      if (input.captureScreenshot) {
        const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true });
        output.screenshot = screenshotBuffer.toString('base64');
      }

      if (input.extractLinks) {
        output.links = await page.$$eval('a[href]', (els) =>
          els
            .map((el) => {
              const href = (el as { href?: unknown }).href;
              return typeof href === 'string' ? href : null;
            })
            .filter((x): x is string => x !== null),
        );
      }

      if (input.extractImages) {
        output.images = await page.$$eval('img[src]', (els) =>
          els
            .map((el) => {
              const src = (el as { src?: unknown }).src;
              return typeof src === 'string' ? src : null;
            })
            .filter((x): x is string => x !== null),
        );
      }

      return output;
    } catch (err) {
      if (err instanceof Error) {
        throw new SkillExecutionError(
          `Dynamic scraping failed: ${err.message}`,
          'PLAYWRIGHT_ERROR',
          true,
        );
      }
      throw err;
    } finally {
      await page?.close();
      await browser?.close();
    }
  }

  override async healthCheck(): Promise<SkillHealthStatus> {
    const start = Date.now();
    try {
      await axios.head('https://httpbin.org/status/200', { timeout: 5000 });
      return {
        healthy: true,
        latencyMs: Date.now() - start,
        details: { httpClient: 'ok' },
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        details: { httpClient: 'error' },
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private parseProxy(proxyUrl: string): {
    host: string;
    port: number;
    auth?: { username: string; password: string };
  } {
    const url = new URL(proxyUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10),
      ...(url.username ? { auth: { username: url.username, password: url.password } } : {}),
    };
  }

  private resolveUrl(base: string, href: string): string {
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }
}

export const webScraperSkill = new WebScraperSkill();
