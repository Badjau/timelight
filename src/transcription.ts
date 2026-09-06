import './transcription.css';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  phrases?: SpeechRecognitionPhraseLike[];
  processLocally?: boolean;
  start(audioTrack?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onsoundend: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechRecognitionPhraseLike {
  readonly phrase: string;
  readonly boost: number;
}

interface SpeechRecognitionPhraseConstructor {
  new (phrase: string, boost: number): SpeechRecognitionPhraseLike;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognitionPhrase?: SpeechRecognitionPhraseConstructor;
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Speech recognition test element is missing: ${selector}`);
  return element;
}

const toggle = requiredElement<HTMLButtonElement>('#toggle');
const clear = requiredElement<HTMLButtonElement>('#clear');
const copy = requiredElement<HTMLButtonElement>('#copy');
const language = requiredElement<HTMLSelectElement>('#language');
const status = requiredElement<HTMLElement>('#status');
const finalText = requiredElement<HTMLElement>('#final-text');
const interimText = requiredElement<HTMLElement>('#interim-text');
const placeholder = requiredElement<HTMLElement>('#placeholder');
const supportNote = requiredElement<HTMLElement>('#support-note');
const expectedNames = requiredElement<HTMLInputElement>('#expected-names');
const microphoneMeter = requiredElement<HTMLElement>('#microphone-meter');
const microphoneLevel = requiredElement<HTMLElement>('#microphone-level');
const microphoneLabel = requiredElement<HTMLElement>('#microphone-label');
const quietWarning = requiredElement<HTMLElement>('#quiet-warning');
const biasNote = requiredElement<HTMLElement>('#bias-note');
const activityLog = requiredElement<HTMLOListElement>('#activity-log');
const activityPlaceholder = requiredElement<HTMLElement>('#activity-placeholder');

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition: SpeechRecognitionLike | null = null;
let shouldListen = false;
let starting = false;
let restartTimer: number | undefined;
let committedText = '';
let sessionFinalText = '';
let listeningStartedAt: number | null = null;
let inputStream: MediaStream | null = null;
let meterStartPromise: Promise<MediaStreamTrack | null> | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let meterSink: GainNode | null = null;
let meterSamples: Float32Array<ArrayBuffer> | null = null;
let meterFrame: number | undefined;
let quietSince: number | null = null;
let quietEventRecorded = false;
let recognitionSoundActive = false;
let latestInterimText = '';
let silenceEndpointRequested = false;

// Ignore faint room/electrical noise when deciding whether a phrase is still
// active. Web Speech does not expose an end-of-speech sensitivity control, so
// the input meter supplies a more decisive local endpoint for pending text.
const speechLevelThreshold = 25;
const silenceEndpointDelay = 1100;

const fillerPhrases = ['um', 'uh', 'erm', 'hmm', 'you know', 'I mean', 'sort of', 'kind of'];
const speechPhrases = [''];

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function joinText(...parts: string[]): string {
  return normalizeWhitespace(parts.filter(Boolean).join(' '));
}

function setStatus(kind: 'idle' | 'listening' | 'error', message: string): void {
  status.className = `status ${kind}`;
  const label = status.querySelector('strong');
  if (label) label.textContent = message;
}

function renderTranscript(interim = ''): void {
  finalText.textContent = joinText(committedText, sessionFinalText);
  interimText.textContent = normalizeWhitespace(interim);
  placeholder.hidden = Boolean(committedText || sessionFinalText || interim);
}

function commitSession(): void {
  committedText = joinText(committedText, sessionFinalText);
  sessionFinalText = '';
  renderTranscript();
}

function preservePendingInterim(): void {
  const punctuated = punctuateFinalResult(latestInterimText);
  latestInterimText = '';
  if (!punctuated) return;
  sessionFinalText = joinText(sessionFinalText, punctuated);
  addActivity('transcript', punctuated);
}

function punctuateFinalResult(text: string): string {
  const cleanText = normalizeWhitespace(text);
  if (!cleanText) return cleanText;
  const punctuated = /[.!?…]["')\]]*$/.test(cleanText) ? cleanText : `${cleanText.replace(/[,;:]$/, '')}.`;
  return punctuated.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_match, boundary: string, letter: string) => `${boundary}${letter.toLocaleUpperCase(language.value)}`);
}

function elapsedTimestamp(): { label: string; seconds: number } {
  const seconds = Math.max(0, Math.floor((performance.now() - (listeningStartedAt ?? performance.now())) / 1000));
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return { label: `${minutes}:${remainder}`, seconds };
}

function addActivity(kind: 'transcript' | 'quiet', detail: string): void {
  const timestamp = elapsedTimestamp();
  const item = document.createElement('li');
  item.className = `activity-item ${kind}`;
  const time = document.createElement('time');
  time.dateTime = `PT${timestamp.seconds}S`;
  time.textContent = timestamp.label;
  const type = document.createElement('span');
  type.className = 'activity-kind';
  type.textContent = kind === 'transcript' ? 'Recognized' : 'Very quiet';
  const description = document.createElement('span');
  description.className = 'activity-detail';
  description.textContent = detail;
  item.append(time, type, description);
  activityLog.append(item);
  activityPlaceholder.hidden = true;
}

function expectedVocabulary(): Array<{ phrase: string; boost: number }> {
  const names = expectedNames.value.split(',').map(normalizeWhitespace).filter(Boolean).slice(0, 30);
  const phrases = [
    ...fillerPhrases.map((phrase) => ({ phrase, boost: 1.5 })),
    ...speechPhrases.map((phrase) => ({ phrase, boost: 1.75 })),
    ...names.map((phrase) => ({ phrase: phrase.slice(0, 80), boost: 2.25 })),
  ];
  return phrases.filter((entry, index) => phrases.findIndex((candidate) => candidate.phrase.toLocaleLowerCase() === entry.phrase.toLocaleLowerCase()) === index);
}

function applyVocabularyBias(instance: SpeechRecognitionLike): void {
  const Phrase = window.SpeechRecognitionPhrase;
  if (!Phrase || !('phrases' in instance)) {
    biasNote.textContent = 'Contextual vocabulary biasing is unavailable in this browser; recognition will continue normally.';
    return;
  }
  if (instance.processLocally !== true) {
    // Chrome can expose `phrases` while using its cloud recognizer, then end the
    // session before `audiostart` without reporting an error if phrases are set.
    biasNote.textContent = 'Contextual vocabulary biasing is disabled for cloud recognition to preserve browser compatibility.';
    return;
  }
  const vocabulary = expectedVocabulary();
  try {
    instance.phrases = vocabulary.map(({ phrase, boost }) => new Phrase(phrase, boost));
    biasNote.textContent = `Moderately biasing ${vocabulary.length} filler words, names, and speech terms.`;
  } catch {
    biasNote.textContent = 'Contextual vocabulary biasing could not be enabled; recognition will continue normally.';
  }
}

function updateMeter(): void {
  if (!analyser || !meterSamples) return;
  if (audioContext?.state !== 'running') {
    quietSince = null;
    quietEventRecorded = false;
    quietWarning.hidden = true;
    microphoneLevel.style.transform = 'scaleX(0)';
    microphoneMeter.setAttribute('aria-valuenow', '0');
    microphoneLabel.textContent = 'Meter paused · interact with the page to enable';
    meterFrame = window.requestAnimationFrame(updateMeter);
    return;
  }
  analyser.getFloatTimeDomainData(meterSamples);
  const rms = Math.sqrt(meterSamples.reduce((sum, sample) => sum + sample * sample, 0) / meterSamples.length);
  const decibels = rms > 0 ? 20 * Math.log10(rms) : -100;
  const level = Math.max(0, Math.min(100, ((decibels + 60) / 60) * 100));
  microphoneLevel.style.transform = `scaleX(${level / 100})`;
  microphoneMeter.setAttribute('aria-valuenow', String(Math.round(level)));

  const now = performance.now();
  if (shouldListen && recognitionSoundActive && level < speechLevelThreshold) quietSince ??= now;
  else {
    quietSince = null;
    quietEventRecorded = false;
  }
  if (
    quietSince !== null
    && now - quietSince >= silenceEndpointDelay
    && latestInterimText
    && !silenceEndpointRequested
  ) {
    silenceEndpointRequested = true;
    recognition?.stop();
  }
  const isQuiet = quietSince !== null && now - quietSince >= 2500;
  quietWarning.hidden = !isQuiet;
  microphoneLabel.textContent = isQuiet ? 'Very quiet' : recognitionSoundActive && level >= 92 ? 'Too loud' : recognitionSoundActive && level >= speechLevelThreshold ? 'Good level' : 'Listening for speech';
  if (isQuiet && !quietEventRecorded) {
    addActivity('quiet', 'Speech was detected while the microphone level was very low.');
    quietEventRecorded = true;
  }
  meterFrame = window.requestAnimationFrame(updateMeter);
}

async function openInputMeter(): Promise<MediaStreamTrack | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!shouldListen) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    inputStream = stream;
    const track = stream.getAudioTracks()[0] ?? null;
    if (!track) throw new Error('The microphone did not provide an audio track.');
    track.contentHint = 'speech-recognition';
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.65;
    meterSamples = new Float32Array(analyser.fftSize);
    const source = audioContext.createMediaStreamSource(inputStream);
    meterSink = audioContext.createGain();
    meterSink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(meterSink);
    meterSink.connect(audioContext.destination);
    updateMeter();
    // AudioContext can remain suspended until a user gesture. The meter is
    // optional, so its resume promise must never block speech recognition.
    void audioContext.resume().catch(() => {
      microphoneLabel.textContent = 'Level meter paused';
    });
    return track;
  } catch {
    stopInputMeter();
    microphoneLabel.textContent = 'Level meter unavailable';
    return null;
  }
}

function startInputMeter(): Promise<MediaStreamTrack | null> {
  const existingTrack = inputStream?.getAudioTracks()[0];
  if (existingTrack?.readyState === 'live') return Promise.resolve(existingTrack);
  if (!navigator.mediaDevices?.getUserMedia) {
    microphoneLabel.textContent = 'Level meter unavailable';
    return Promise.resolve(null);
  }
  meterStartPromise ??= openInputMeter().finally(() => { meterStartPromise = null; });
  return meterStartPromise;
}

function stopInputMeter(): void {
  window.cancelAnimationFrame(meterFrame ?? 0);
  meterFrame = undefined;
  inputStream?.getTracks().forEach((track) => track.stop());
  inputStream = null;
  analyser = null;
  meterSink = null;
  meterSamples = null;
  void audioContext?.close();
  audioContext = null;
  quietSince = null;
  quietEventRecorded = false;
  recognitionSoundActive = false;
  silenceEndpointRequested = false;
  quietWarning.hidden = true;
  microphoneLevel.style.transform = 'scaleX(0)';
  microphoneMeter.setAttribute('aria-valuenow', '0');
  microphoneLabel.textContent = 'Microphone off';
}

function resumeInputMeter(): void {
  if (audioContext?.state !== 'suspended') return;
  void audioContext.resume().catch(() => {
    microphoneLabel.textContent = 'Level meter unavailable';
  });
}

function configureRecognition(): SpeechRecognitionLike {
  if (!Recognition) throw new Error('SpeechRecognition is unavailable.');
  const instance = new Recognition();
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;
  instance.lang = language.value;
  applyVocabularyBias(instance);
  const finalizedResults = new Set<number>();
  let sessionErrorMessage: string | null = null;
  silenceEndpointRequested = false;

  instance.onstart = () => {
    if (recognition !== instance) return;
    starting = false;
    setStatus('listening', 'Listening');
    toggle.textContent = 'Stop listening';
    void audioContext?.resume();
  };

  instance.onaudiostart = () => {};

  instance.onsoundstart = () => {
    if (recognition !== instance) return;
    recognitionSoundActive = true;
    quietSince = null;
    quietEventRecorded = false;
  };

  instance.onsoundend = () => {
    if (recognition !== instance) return;
    recognitionSoundActive = false;
    quietSince = null;
    quietEventRecorded = false;
    quietWarning.hidden = true;
  };

  instance.onresult = (event) => {
    if (recognition !== instance) return;
    sessionErrorMessage = null;
    let sessionFinal = '';
    let interim = '';
    // SpeechRecognition results are a revisable list, not a stream of new text.
    // Rebuild the active session so repeated revisions are never appended twice.
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = normalizeWhitespace(result?.[0]?.transcript ?? '');
      if (result?.isFinal) {
        const punctuated = punctuateFinalResult(text);
        sessionFinal = joinText(sessionFinal, punctuated);
        if (punctuated && !finalizedResults.has(index)) {
          addActivity('transcript', punctuated);
          finalizedResults.add(index);
        }
      } else {
        interim = joinText(interim, text);
      }
    }
    sessionFinalText = sessionFinal;
    latestInterimText = interim;
    renderTranscript(interim);
  };

  instance.onerror = (event) => {
    if (recognition !== instance) return;
    starting = false;
    const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error);
    if (fatal) {
      shouldListen = false;
      stopInputMeter();
    }
    const messages: Record<string, string> = {
      'not-allowed': 'Microphone permission was denied. Use Start listening to try again.',
      'service-not-allowed': 'Speech recognition is blocked by this browser.',
      'audio-capture': 'No working microphone was found.',
      'network': 'Speech recognition needs a network connection in this browser.',
      'no-speech': 'No speech detected. Still listening…',
      'language-not-supported': 'The selected language is not supported.',
    };
    sessionErrorMessage = messages[event.error] ?? event.message ?? `Recognition error: ${event.error}`;
    setStatus(fatal ? 'error' : 'idle', sessionErrorMessage);
  };

  instance.onend = () => {
    if (recognition !== instance) return;
    recognition = null;
    recognitionSoundActive = false;
    starting = false;
    preservePendingInterim();
    commitSession();
    if (shouldListen) {
      setStatus(sessionErrorMessage ? 'error' : 'idle', sessionErrorMessage ? `${sessionErrorMessage} Retrying…` : 'Restarting recognition…');
      restartTimer = window.setTimeout(startRecognition, sessionErrorMessage ? 1200 : 250);
    } else {
      setStatus('idle', 'Not listening');
      toggle.textContent = 'Start listening';
    }
  };

  return instance;
}

async function startRecognition(): Promise<void> {
  if (!Recognition || starting || !shouldListen) return;
  window.clearTimeout(restartTimer);
  starting = true;
  setStatus('idle', 'Opening microphone…');
  const audioTrack = await startInputMeter();
  if (!shouldListen) {
    starting = false;
    return;
  }
  recognition = configureRecognition();
  try {
    // Recognition and the meter consume the same live track. Opening a second
    // microphone capture can leave Web Speech listening without delivering
    // results on some browser/device combinations.
    recognition.start(audioTrack ?? undefined);
  } catch (error) {
    if (audioTrack) {
      // Fall back for older implementations without start(MediaStreamTrack).
      stopInputMeter();
      recognition = configureRecognition();
      try {
        recognition.start();
        microphoneLabel.textContent = 'Meter unavailable during recognition';
        return;
      } catch {
        // Report the original exception below.
      }
    }
    starting = false;
    shouldListen = false;
    stopInputMeter();
    setStatus('error', error instanceof Error ? error.message : 'Could not start speech recognition.');
    toggle.textContent = 'Start listening';
  }
}

function stopRecognition(): void {
  shouldListen = false;
  starting = false;
  window.clearTimeout(restartTimer);
  recognition?.stop();
  stopInputMeter();
  setStatus('idle', 'Not listening');
  toggle.textContent = 'Start listening';
}

if (!Recognition) {
  toggle.disabled = true;
  language.disabled = true;
  expectedNames.disabled = true;
  setStatus('error', 'SpeechRecognition is not supported in this browser.');
  supportNote.hidden = false;
  supportNote.textContent = 'Open this page in a current desktop version of Chrome or Microsoft Edge.';
} else {
  const browserLanguage = navigator.language;
  if ([...language.options].some((option) => option.value === browserLanguage)) language.value = browserLanguage;
  shouldListen = true;
  listeningStartedAt = performance.now();
  void startRecognition();
}

toggle.addEventListener('click', () => {
  if (shouldListen) stopRecognition();
  else {
    shouldListen = true;
    listeningStartedAt ??= performance.now();
    void startRecognition();
  }
});

document.addEventListener('pointerdown', resumeInputMeter, { passive: true });
document.addEventListener('keydown', resumeInputMeter);

language.addEventListener('change', () => {
  if (!shouldListen) return;
  recognition?.abort();
});

expectedNames.addEventListener('change', () => {
  if (shouldListen) recognition?.abort();
});

clear.addEventListener('click', () => {
  committedText = '';
  sessionFinalText = '';
  latestInterimText = '';
  activityLog.replaceChildren();
  activityPlaceholder.hidden = false;
  listeningStartedAt = shouldListen ? performance.now() : null;
  renderTranscript();
  if (shouldListen) recognition?.abort();
});

copy.addEventListener('click', async () => {
  const transcript = joinText(committedText, sessionFinalText);
  if (!transcript) return;
  await navigator.clipboard.writeText(transcript);
  copy.textContent = 'Copied';
  window.setTimeout(() => { copy.textContent = 'Copy text'; }, 1200);
});

window.addEventListener('beforeunload', () => {
  shouldListen = false;
  recognition?.abort();
  recognition = null;
  stopInputMeter();
});
