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
  assert.deepEqual(controlOrder, ['local-reset', 'local-play', 'local-next-stage', 'transcription-toggle', 'local-stop']);
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

test('grace stages are marked and saved as an allotted-time range', async () => {
  const page = await openTimer();
  await page.click('#back-to-editor');

  const firstStage = page.locator('.stage-row').nth(0);
  await firstStage.locator('[data-field="name"]').fill('Opening grace');
  assert.equal(await firstStage.locator('[data-field="grace"]').isChecked(), true);
  assert.equal(await firstStage.evaluate((row) => row.classList.contains('is-grace')), true);

  const secondStage = page.locator('.stage-row').nth(1);
  await secondStage.locator('[data-field="grace"]').check();
  assert.equal(await secondStage.evaluate((row) => row.classList.contains('is-grace')), true);

  await page.click('#play-preset');
  await page.click('#local-play');
  await page.click('#local-stop');
  await page.click('#back-to-editor');
  await page.click('#open-history');

  const headers = await page.locator('#history-overlay th').allTextContents();
  assert.ok(headers.includes('Allotted Time'));
  assert.equal(await page.locator('#history-overlay tbody tr').first().locator('td').nth(5).textContent(), '00:30 to 1:00');
  await page.close();
});

test('optional allotted-time range replaces the derived timer history value', async () => {
  const page = await openTimer();
  await page.click('#back-to-editor');
  await page.fill('#allotted-time-from-minutes', '01');
  await page.fill('#allotted-time-from-seconds', '00');
  await page.fill('#allotted-time-to-minutes', '02');
  await page.fill('#allotted-time-to-seconds', '00');
  await page.click('#play-preset');
  await page.click('#local-play');
  await page.click('#local-stop');
  await page.click('#back-to-editor');
  await page.click('#open-history');

  assert.equal(await page.locator('#history-overlay tbody tr').first().locator('td').nth(5).textContent(), '01:00 to 02:00');
  await page.close();
});

test('one optional allotted-time value is used by itself', async () => {
  const page = await openTimer();
  await page.click('#back-to-editor');
  await page.fill('#allotted-time-from-minutes', '01');
  await page.fill('#allotted-time-from-seconds', '30');
  await page.click('#play-preset');
  await page.click('#local-play');
  await page.click('#local-stop');
  await page.click('#back-to-editor');
  await page.click('#open-history');

  assert.equal(await page.locator('#history-overlay tbody tr').first().locator('td').nth(5).textContent(), '01:30');
  await page.close();
});

test('stop and save confirmation survives timer status refreshes', async () => {
  const page = await openTimer();
  await page.click('#local-play');
  await page.click('#local-stop');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.textContent('.timer-saved'), 'Timer stopped and saved to history.');
  await page.close();
});

test('editor allows seven stages and stops at the limit', async () => {
  const page = await openTimer();
  await page.click('#back-to-editor');
  await page.click('#add-stage');
  await page.click('#add-stage');
  assert.equal(await page.locator('.stage-row').count(), 7);
  assert.equal(await page.textContent('#stage-count'), '7 of 7');
  assert.equal(await page.locator('#add-stage').isDisabled(), true);
  assert.equal(await page.inputValue('.stage-row:nth-child(6) [data-field="color"]'), '#00c2a8');
  assert.equal(await page.inputValue('.stage-row:nth-child(7) [data-field="color"]'), '#ff4fa3');
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
    timerBottom: document.querySelector('.timer-zone').getBoundingClientRect().bottom,
    controlsTop: document.querySelector('.control-zone').getBoundingClientRect().top,
    controlsBottom: document.querySelector('.control-zone').getBoundingClientRect().bottom,
    transcriptTop: document.querySelector('#transcription-panel').getBoundingClientRect().top,
    panelWidth: document.querySelector('#transcription-panel').getBoundingClientRect().width,
    cardWidth: document.querySelector('#timer-panel').getBoundingClientRect().width,
  }));
  assert.ok(positions.controlsTop >= positions.timerBottom);
  assert.ok(positions.transcriptTop >= positions.controlsBottom);
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

test('stacked tablet layout keeps timer content, controls, and transcript separated', async () => {
  const page = await openTimer({ width: 806, height: 776 });
  await page.click('#transcription-toggle');
  const positions = await page.evaluate(() => ({
    displayBottom: document.querySelector('.timer-display').getBoundingClientRect().bottom,
    stagesTop: document.querySelector('.stage-progress').getBoundingClientRect().top,
    stagesBottom: document.querySelector('.stage-progress').getBoundingClientRect().bottom,
    timerBottom: document.querySelector('.timer-zone').getBoundingClientRect().bottom,
    controlsTop: document.querySelector('.control-zone').getBoundingClientRect().top,
    controlsBottom: document.querySelector('.control-zone').getBoundingClientRect().bottom,
    transcriptTop: document.querySelector('#transcription-panel').getBoundingClientRect().top,
  }));
  assert.ok(positions.stagesTop >= positions.displayBottom);
  assert.ok(positions.timerBottom >= positions.stagesBottom);
  assert.ok(positions.controlsTop >= positions.timerBottom);
  assert.ok(positions.transcriptTop >= positions.controlsBottom);
  await page.close();
});

test('editor re-renders do not reopen a closed timer modal', async () => {
  const page = await openTimer({ width: 390, height: 760 });
  await page.click('#local-play');
  const headerControls = await page.evaluate(() => {
    const back = document.querySelector('#back-to-editor').getBoundingClientRect();
    const picker = document.querySelector('#timer-preset-picker').getBoundingClientRect();
    return { backRight: back.right, pickerLeft: picker.left };
  });
  assert.ok(headerControls.backRight <= headerControls.pickerLeft);
  await page.click('#back-to-editor');

  await page.fill('#preset-name', 'Updated preset');
  await page.click('#save-preset');
  assert.notEqual(await page.getAttribute('#live-overlay', 'hidden'), null);

  await page.click('.stage-row:nth-child(2) [data-stage-toggle]');
  const dragHandle = page.locator('.stage-row:nth-child(2) [data-stage-drag]');
  const destination = page.locator('#stage-list > .stage-row:nth-child(3)');
  await dragHandle.scrollIntoViewIfNeeded();
  const from = await dragHandle.boundingBox();
  assert.ok(from);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  assert.equal(await page.locator('.stage-drag-ghost').count(), 1);
  assert.equal(await page.locator('.stage-drag-ghost.is-expanded').count(), 0);
  assert.equal(await page.locator('.stage-row:nth-child(2).is-expanded').count(), 0);
  const to = await destination.boundingBox();
  assert.ok(to);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * .75, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.locator('.stage-drag-ghost').count(), 0);
  assert.notEqual(await page.getAttribute('#live-overlay', 'hidden'), null);
  assert.equal(await page.inputValue('.stage-row:nth-child(2) [data-field="name"]'), 'Speech halfway point');
  assert.equal(await page.inputValue('.stage-row:nth-child(2) [data-field="threshold-minutes"]'), '00');
  assert.equal(await page.inputValue('.stage-row:nth-child(2) [data-field="threshold-seconds"]'), '15');
  assert.equal(await page.inputValue('.stage-row:nth-child(3) [data-field="name"]'), 'Speech start');
  assert.equal(await page.inputValue('.stage-row:nth-child(3) [data-field="threshold-minutes"]'), '00');
  assert.equal(await page.inputValue('.stage-row:nth-child(3) [data-field="threshold-seconds"]'), '30');
  assert.equal(await page.locator('.stage-row:nth-child(3).is-expanded').count(), 1);
  await page.close();
});
