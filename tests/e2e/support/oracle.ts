import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { fixturesDir } from './paths';

export interface OraclePanel {
  id: string;
  position: string;
  /** `[left, top, width, height]`, normalized to the image. */
  bounds: [number, number, number, number];
  /** `[x, y]`, normalized to the image. */
  click: [number, number];
  text: string;
  language: 'ja' | 'en';
}

export interface OraclePage {
  readingOrder: string[];
  panels: OraclePanel[];
  outsidePanels: { position: string; click: [number, number] }[];
}

export interface Oracle {
  imageSize: { width: number; height: number };
  pages: Record<'page-a.png' | 'page-b.png', OraclePage>;
  swapProbes: { click: [number, number]; pageA: string | null; pageB: string | null }[];
}

export function loadOracle(): Oracle {
  return JSON.parse(readFileSync(resolve(fixturesDir, 'expected-panels.json'), 'utf8')) as Oracle;
}

/**
 * Viewport coordinates of a normalized image point, after scrolling the point into view.
 * Mirrors the QA-PLAN procedure: clientX = rect.left + x * rect.width.
 */
export async function viewportPoint(page: Page, selector: string, normalized: [number, number]): Promise<{ x: number; y: number }> {
  const image = page.locator(selector);
  await image.evaluate((element, [, y]) => {
    const rect = element.getBoundingClientRect();
    window.scrollBy(0, rect.top + y * rect.height - window.innerHeight / 2);
  }, normalized);
  const box = await image.boundingBox();
  if (!box) throw new Error(`${selector} has no layout box`);
  return { x: box.x + normalized[0] * box.width, y: box.y + normalized[1] * box.height };
}

/** Real pointer click at a normalized image point. */
export async function clickImagePoint(page: Page, selector: string, normalized: [number, number]): Promise<{ x: number; y: number }> {
  const point = await viewportPoint(page, selector, normalized);
  await page.mouse.click(point.x, point.y);
  return point;
}
