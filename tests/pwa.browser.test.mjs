import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright-core';

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

let browser;
let server;
let pageUrl;

const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

before(async () => {
  const distRoot = resolve('dist');
  if (!existsSync(join(distRoot, 'index.html'))) throw new Error('dist/index.html is missing; run npm run build first.');
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    let relative = decodeURIComponent(requestUrl.pathname.replace(/^\/timelight\/?/, ''));
    if (!relative) relative = 'index.html';
    let filePath = resolve(distRoot, relative);
    if (relative.split('/').includes('..')) {
      response.writeHead(400).end();
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      if (requestUrl.pathname.startsWith('/timelight/') && request.headers.accept?.includes('text/html')) filePath = join(distRoot, 'index.html');
      else {
        response.writeHead(404).end();
        return;
      }
    }
    response.writeHead(200, {
      'Cache-Control': filePath.endsWith('sw.js') ? 'no-store' : 'no-cache',
      'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(filePath));
  });
  await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PWA test server did not expose a port.');
  pageUrl = `http://127.0.0.1:${address.port}/timelight/`;
  const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((resolveServer) => server?.close(resolveServer));
});

async function openPage(addInitScript) {
  const context = await browser.newContext();
  if (addInitScript) await context.addInitScript(addInitScript);
  const page = await context.newPage();
  await page.goto(pageUrl);
  return { context, page };
}

test('production artifact is installable and serves its cached shell offline', async () => {
  const { context, page } = await openPage();
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/timelight/manifest.webmanifest');
    return { status: response.status, type: response.headers.get('content-type'), body: await response.json() };
  });
  assert.equal(manifest.status, 200);
  assert.match(manifest.type, /manifest\+json/);
  assert.equal(manifest.body.id, '/timelight/');
  assert.equal(manifest.body.scope, '/timelight/');
  assert.equal(manifest.body.start_url, '/timelight/');
  assert.equal(manifest.body.display, 'standalone');
  assert.deepEqual(manifest.body.icons.map((icon) => [icon.src, icon.sizes, icon.type, icon.purpose]), [
    ['pwa-192x192.png', '192x192', 'image/png', 'any'],
    ['pwa-512x512.png', '512x512', 'image/png', 'any'],
    ['pwa-512x512-maskable.png', '512x512', 'image/png', 'maskable'],
  ]);

  const icons = await page.evaluate(async (sources) => Promise.all(sources.map(async ({ src, size }) => {
    const response = await fetch(`/timelight/${src}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const loaded = new Promise((resolveImage, rejectImage) => { image.onload = resolveImage; image.onerror = rejectImage; });
    image.src = url;
    await loaded;
    URL.revokeObjectURL(url);
    return { status: response.status, type: response.headers.get('content-type'), width: image.naturalWidth, height: image.naturalHeight, expected: size };
  })), manifest.body.icons.map((icon) => ({ src: icon.src, size: Number.parseInt(icon.sizes, 10) })));
  for (const icon of icons) {
    assert.equal(icon.status, 200);
    assert.match(icon.type, /^image\/png/);
    assert.deepEqual([icon.width, icon.height], [icon.expected, icon.expected]);
  }

  const serviceWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active ?? registration.waiting ?? registration.installing;
    if (worker && worker.state !== 'activated') {
      await new Promise((resolveWorker, rejectWorker) => {
        const handleStateChange = () => {
          if (worker.state === 'activated') {
            worker.removeEventListener('statechange', handleStateChange);
            resolveWorker();
          } else if (worker.state === 'redundant') {
            worker.removeEventListener('statechange', handleStateChange);
            rejectWorker(new Error('Service worker became redundant before activation.'));
          }
        };
        worker.addEventListener('statechange', handleStateChange);
        handleStateChange();
      });
    }
    return { scope: registration.scope, active: registration.active?.state };
  });
  assert.equal(serviceWorker.scope, new URL('/timelight/', pageUrl).href);
  assert.equal(serviceWorker.active, 'activated');
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  await context.setOffline(true);
  await page.close();
  await context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); });
  const offlinePage = await context.newPage();
  await offlinePage.goto(pageUrl);
  const connectionBadge = offlinePage.locator('#connection-badge');
  await connectionBadge.waitFor({ state: 'visible' });
  assert.match(await connectionBadge.getAttribute('class') ?? '', /\boffline\b/);
  assert.equal(await connectionBadge.getAttribute('aria-label'), 'Network connection unavailable · Running from the cached shell');
  await context.setOffline(false);
  await context.close();
});

test('deployed releases activate automatically without a hard refresh', () => {
  const serviceWorker = readFileSync(resolve('dist/sw.js'), 'utf8');
  const index = readFileSync(resolve('dist/index.html'), 'utf8');
  const mainAssetPath = index.match(/src="\/timelight\/(assets\/main-[^"]+\.js)"/)?.[1];

  assert.ok(mainAssetPath, 'the production page should reference a content-hashed main bundle');
  const mainAsset = readFileSync(resolve('dist', mainAssetPath), 'utf8');

  assert.match(serviceWorker, /skipWaiting\(\)/, 'the new worker should not remain waiting behind an older release');
  assert.match(serviceWorker, /clientsClaim\(\)/, 'the new worker should immediately control open clients');
  assert.match(mainAsset, /location\.reload\(\)/, 'an open client should reload once after the new worker activates');
});

test('deferred install action prompts once and hides after every terminal state', async () => {
  const { context, page } = await openPage();
  await page.evaluate(() => {
    window.__installTest = { prompts: 0 };
    window.emitInstallPrompt = (outcome) => {
      const event = new Event('beforeinstallprompt');
      Object.defineProperty(event, 'prompt', { value: async () => { window.__installTest.prompts += 1; } });
      Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome, platform: 'web' }) });
      window.dispatchEvent(event);
    };
  });

  await page.evaluate(() => window.emitInstallPrompt('dismissed'));
  await page.locator('#install-app').waitFor({ state: 'visible' });
  await page.click('#install-app');
  await page.waitForFunction(() => document.querySelector('#install-app')?.hidden === true);
  assert.equal(await page.evaluate(() => window.__installTest.prompts), 1);

  await page.evaluate(() => window.emitInstallPrompt('accepted'));
  await page.locator('#install-app').waitFor({ state: 'visible' });
  await page.click('#install-app');
  await page.waitForFunction(() => document.querySelector('#install-app')?.hidden === true);
  assert.equal(await page.evaluate(() => window.__installTest.prompts), 2);

  await page.evaluate(() => window.emitInstallPrompt('accepted'));
  await page.locator('#install-app').waitFor({ state: 'visible' });
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  assert.equal(await page.locator('#install-app').isHidden(), true);
  await context.close();

  const standalone = await openPage(() => {
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === '(display-mode: standalone)'
      ? { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
      : realMatchMedia(query);
  });
  assert.equal(await standalone.page.locator('#install-app').isHidden(), true);
  await standalone.context.close();
});
