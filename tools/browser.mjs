// Shared headless-Chrome helpers for screenshots and automated tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const shotsDir = path.join(here, 'screenshots');
fs.mkdirSync(shotsDir, { recursive: true });

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function startServer(port = 8123) {
  const proc = spawn(process.execPath, [path.join(here, 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('running')) resolve({ proc, url: `http://localhost:${port}/` }); });
  });
}

export async function launch({ width = 1280, height = 720, gpu = process.env.GPU || 'metal' } = {}) {
  const exe = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Chrome not found; set CHROME_PATH');
  const args = [
    `--window-size=${width},${height}`,
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
  ];
  if (gpu === 'swiftshader') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  else if (gpu === 'metal') args.push('--use-angle=metal', '--enable-unsafe-webgpu');
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args, defaultViewport: { width, height }, protocolTimeout: 900000 });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  return { browser, page, logs };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
