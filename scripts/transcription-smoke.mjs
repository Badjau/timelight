import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
const fakeAudioFile = process.env.FAKE_AUDIO_FILE;
let browser;

try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a test port.');
  const executablePath = candidates.find(existsSync);
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(fakeAudioFile ? [`--use-file-for-fake-audio-capture=${fakeAudioFile}%noloop`] : []),
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addInitScript(() => {
    window.__nativeSpeechEvents = [];
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;
    const originalStart = Recognition.prototype.start;
    Recognition.prototype.start = function (...args) {
      for (const type of ['start', 'audiostart', 'soundstart', 'speechstart', 'result', 'speechend', 'soundend', 'audioend', 'error', 'end']) {
        this.addEventListener(type, (event) => {
          window.__nativeSpeechEvents.push({
            type,
            error: event.error,
            results: event.results ? Array.from(event.results, (result) => ({
              final: result.isFinal,
              transcript: result[0]?.transcript,
            })) : undefined,
          });
        });
      }
      return originalStart.apply(this, args);
    };
  });

  async function runVariant(name, disablePhrases) {
    const page = await context.newPage();
    const errors = [];
    if (disablePhrases) {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'SpeechRecognitionPhrase', { configurable: true, value: undefined });
      });
    }
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/timelight/admin/transcription/`);

    const samples = [];
    for (let index = 0; index < (fakeAudioFile ? 32 : 16); index += 1) {
      await page.waitForTimeout(250);
      const current = await page.evaluate(() => ({
        status: document.querySelector('#status strong')?.textContent,
        final: document.querySelector('#final-text')?.textContent,
        interim: document.querySelector('#interim-text')?.textContent,
        meter: document.querySelector('#microphone-label')?.textContent,
      }));
      const previous = samples.at(-1);
      if (!previous || previous.status !== current.status || previous.final !== current.final || previous.interim !== current.interim || previous.meter !== current.meter) {
        samples.push({ atMs: (index + 1) * 250, ...current });
      }
    }

    const capabilities = await page.evaluate(() => {
      const speechEvents = window.__nativeSpeechEvents;
      return {
        recognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
        phrases: Boolean(window.SpeechRecognitionPhrase),
        meterLabel: document.querySelector('#microphone-label')?.textContent,
        transcript: document.querySelector('#final-text')?.textContent,
        interim: document.querySelector('#interim-text')?.textContent,
        speechEventTypes: speechEvents.map(({ type }) => type),
        lastResult: speechEvents.findLast(({ type }) => type === 'result')?.results,
      };
    });
    await page.close();
    return { name, capabilities, samples, errors };
  }

  const variants = [];
  variants.push(await runVariant('phrases API exposed', false));
  variants.push(await runVariant('phrases API unavailable', true));
  if (fakeAudioFile && variants.some(({ capabilities }) => !`${capabilities.transcript} ${capabilities.interim}`.trim())) {
    throw new Error('Chrome received the spoken fixture but rendered no transcript output.');
  }
  if (fakeAudioFile && variants.some(({ samples }) => samples.some(({ meter }) => meter === 'Very quiet'))) {
    const quietSamples = variants.flatMap(({ name, samples }) => samples.filter(({ meter }) => meter === 'Very quiet').map((sample) => ({ name, ...sample })));
    throw new Error(`Chrome incorrectly classified the spoken fixture or its trailing silence as very quiet: ${JSON.stringify(quietSamples)}`);
  }
  console.log(JSON.stringify(variants, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
