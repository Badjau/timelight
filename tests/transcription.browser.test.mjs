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
  pageUrl = `http://127.0.0.1:${address.port}/timelight/admin/transcription/`;

  const executablePath = chromeCandidates.find(existsSync);
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openMockedTranscription({ restartAfterResult = false } = {}) {
  const page = await browser.newPage();
  await page.addInitScript(({ restartAfterResult }) => {
    const state = window.__transcriptionTest = { events: [], starts: 0, meterStarts: 0, sharedTrackStarts: 0 };

    class FakeSpeechRecognitionPhrase {
      constructor(phrase, boost) {
        this.phrase = phrase;
        this.boost = boost;
      }
    }

    class FakeSpeechRecognition {
      constructor() {
        this.phrases = [];
        this.processLocally = false;
        this.onstart = null;
        this.onaudiostart = null;
        this.onsoundstart = null;
        this.onsoundend = null;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.instanceNumber = state.starts;
      }

      start(audioTrack) {
        this.instanceNumber = state.starts;
        state.starts += 1;
        state.events.push('recognition:start');
        queueMicrotask(() => {
          this.onstart?.();
          // Mirrors current Chrome: assigning contextual phrases to the cloud
          // recognizer ends it before audio capture and emits no error.
          if (this.phrases.length > 0 && !this.processLocally) {
            this.onend?.();
            return;
          }
          this.onaudiostart?.();
          this.onsoundstart?.();
          if (audioTrack !== track) return;
          state.sharedTrackStarts += 1;
          if (this.instanceNumber !== 0) return;
          setTimeout(() => {
            const result = { 0: { transcript: 'hello world' }, length: 1, isFinal: true };
            this.onresult?.({ resultIndex: 0, results: [result] });
            this.onsoundend?.();
            if (restartAfterResult) setTimeout(() => this.onend?.(), 5);
          }, 5);
        });
      }

      stop() { queueMicrotask(() => this.onend?.()); }
      abort() { queueMicrotask(() => this.onend?.()); }
    }

    class FakeAudioContext {
      constructor() { this.state = 'suspended'; }

      createAnalyser() {
        return {
          fftSize: 1024,
          smoothingTimeConstant: 0,
          connect() {},
          getFloatTimeDomainData(samples) { samples.fill(0.2); },
        };
      }

      createMediaStreamSource() { return { connect() {} }; }
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      get destination() { return {}; }
      // Deliberately never resolves: browser autoplay policy may suspend an
      // AudioContext until a user gesture, but recognition must still run.
      resume() { return new Promise(() => {}); }
      close() { return Promise.resolve(); }
    }

    const track = { contentHint: '', kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; } };
    const mediaDevices = {
      async getUserMedia() {
        state.meterStarts += 1;
        state.events.push('meter:start');
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      },
    };

    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeSpeechRecognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeSpeechRecognition });
    Object.defineProperty(window, 'SpeechRecognitionPhrase', { configurable: true, value: FakeSpeechRecognitionPhrase });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
  }, { restartAfterResult });
  await page.goto(pageUrl);
  return page;
}

test('recognition is not blocked by the optional volume meter', async () => {
  const page = await openMockedTranscription();
  await page.waitForFunction(() => document.querySelector('#final-text')?.textContent === 'Hello world.');

  const state = await page.evaluate(() => window.__transcriptionTest);
  assert.deepEqual(state.events.slice(0, 2), ['meter:start', 'recognition:start']);
  assert.equal(state.starts, 1);
  assert.equal(state.meterStarts, 1);
  assert.equal(state.sharedTrackStarts, 1);
  assert.equal(await page.textContent('#status strong'), 'Listening');
  assert.match(await page.textContent('#bias-note'), /disabled for cloud recognition/);
  await page.waitForTimeout(2800);
  assert.match(await page.textContent('#microphone-label'), /Meter paused/);
  assert.equal(await page.locator('.activity-item.quiet').count(), 0);
  await page.close();
});

test('an ended session restarts without duplicating its final result', async () => {
  const page = await openMockedTranscription({ restartAfterResult: true });
  await page.waitForFunction(() => window.__transcriptionTest.starts >= 2);

  assert.equal(await page.textContent('#final-text'), 'Hello world.');
  assert.equal(await page.locator('.activity-item.transcript').count(), 1);
  assert.equal(await page.textContent('#status strong'), 'Listening');
  await page.close();
});
