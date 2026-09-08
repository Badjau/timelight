import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

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

before(async () => {
  server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a test port.');
  pageUrl = `http://127.0.0.1:${address.port}/timelight/`;
  const executablePath = chromeCandidates.find(existsSync);
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true });
});

after(async () => { await browser?.close(); await server?.close(); });

async function openTimer(viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => {
    window.__recognizers = [];
    class FakeRecognition {
      constructor() { this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null; window.__recognizers.push(this); }
      start() { queueMicrotask(() => this.onstart?.()); }
      stop() { queueMicrotask(() => this.onend?.()); }
      abort() { queueMicrotask(() => this.onend?.()); }
      emit(text) { this.onresult?.({ results: [{ 0: { transcript: text }, length: 1, isFinal: true }] }); }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedTranscript = text; } } });
  });
  await page.goto(pageUrl);
  await page.click('#play-preset');
  return page;
}

test('timer modal transcribes, timestamps, stage-colors, and copies speech', async () => {
  const page = await openTimer();
  await page.click('#local-play');
  await page.click('#transcription-toggle');
  const controlOrder = await page.locator('.player-controls > button').evaluateAll((buttons) => buttons.map((button) => button.id));
  assert.deepEqual(controlOrder, ['local-reset', 'local-play', 'local-next-stage', 'transcription-toggle']);
  await page.waitForFunction(() => document.querySelector('#transcription-status strong')?.textContent === 'Listening');
  await page.evaluate(() => window.__recognizers.at(-1).emit('good day everyone'));
  assert.equal(await page.textContent('#raw-transcript'), 'Good day everyone.');
  assert.match(await page.textContent('#timestamp-transcript'), /00:00Good day everyone\./);
  assert.equal(await page.locator('.timestamp-entry time').evaluate((node) => node.style.getPropertyValue('--transcript-stage-color')), '#0000ff');
  assert.equal(await page.getAttribute('#timestamp-transcript-tab', 'aria-selected'), 'true');
  await page.click('[data-copy="timestamp"]');
  assert.equal(await page.evaluate(() => window.__copiedTranscript), '[00:00] Good day everyone.');
  await page.click('#raw-transcript-tab');
  assert.equal(await page.getAttribute('#raw-transcript-tab', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('#raw-transcript-view', 'hidden'), null);
  assert.notEqual(await page.getAttribute('#timestamp-transcript-view', 'hidden'), null);
  await page.click('[data-copy="raw"]');
  assert.equal(await page.evaluate(() => window.__copiedTranscript), 'Good day everyone.');
  await page.close();
});

test('desktop transcript is docked without squeezing the timer workspace', async () => {
  const page = await openTimer({ width: 1440, height: 900 });
  await page.click('#transcription-toggle');
  const layout = await page.evaluate(() => {
    const timer = document.querySelector('.timer-zone').getBoundingClientRect();
    const transcript = document.querySelector('#transcription-panel').getBoundingClientRect();
    return { timerWidth: timer.width, transcriptWidth: transcript.width, timerLeft: timer.left, transcriptLeft: transcript.left };
  });
  assert.ok(layout.timerWidth >= 650);
  assert.ok(layout.transcriptWidth >= 380);
  assert.ok(layout.transcriptLeft > layout.timerLeft);
  await page.close();
});

test('phone layout places the open transcript below timer controls', async () => {
  const page = await openTimer({ width: 390, height: 760 });
  await page.click('#transcription-toggle-mobile');
  const positions = await page.evaluate(() => ({
    controls: document.querySelector('.control-zone').getBoundingClientRect().top,
    transcript: document.querySelector('#transcription-panel').getBoundingClientRect().top,
    panelWidth: document.querySelector('#transcription-panel').getBoundingClientRect().width,
    cardWidth: document.querySelector('#timer-panel').getBoundingClientRect().width,
  }));
  assert.ok(positions.transcript > positions.controls);
  assert.ok(positions.panelWidth >= positions.cardWidth - 32);
  await page.close();
});

test('transcription follows play, pause, resume, and reset', async () => {
  const page = await openTimer();
  await page.click('#transcription-toggle');
  assert.equal(await page.textContent('#transcription-status strong'), 'Start the timer to transcribe');
  assert.equal(await page.evaluate(() => window.__recognizers.length), 0);

  await page.click('#local-play');
  await page.waitForFunction(() => window.__recognizers.length === 1);
  await page.evaluate(() => window.__recognizers[0].emit('recorded while running'));
  await page.click('#local-play');
  assert.equal(await page.textContent('#transcription-status strong'), 'Timer paused · transcription paused');
  await page.evaluate(() => window.__recognizers[0].emit('must be ignored'));
  assert.equal(await page.textContent('#raw-transcript'), 'Recorded while running.');

  await page.click('#local-play');
  await page.waitForFunction(() => window.__recognizers.length === 2);
  await page.evaluate(() => window.__recognizers[1].emit('recorded after resume'));
  assert.equal(await page.textContent('#raw-transcript'), 'Recorded while running. Recorded after resume.');

  await page.click('#local-reset');
  assert.equal(await page.textContent('#raw-transcript'), 'Speech will appear here.');
  assert.equal(await page.locator('.timestamp-entry').count(), 0);
  await page.close();
});

test('editor re-renders do not reopen a closed timer modal', async () => {
  const page = await openTimer();
  await page.click('#local-play');
  await page.click('#back-to-editor');

  await page.fill('#preset-name', 'Updated preset');
  await page.click('#save-preset');
  assert.notEqual(await page.getAttribute('#live-overlay', 'hidden'), null);

  await page.click('.stage-row:nth-child(2) .move-down');
  assert.notEqual(await page.getAttribute('#live-overlay', 'hidden'), null);
  assert.equal(await page.inputValue('.stage-row:nth-child(2) [data-field="name"]'), 'Nearing limit');
  assert.equal(await page.inputValue('.stage-row:nth-child(2) [data-field="threshold"]'), '01:00');
  assert.equal(await page.inputValue('.stage-row:nth-child(3) [data-field="name"]'), 'Approaching');
  assert.equal(await page.inputValue('.stage-row:nth-child(3) [data-field="threshold"]'), '02:00');
  await page.close();
});
