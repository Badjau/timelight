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
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
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

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition: SpeechRecognitionLike | null = null;
let shouldListen = false;
let starting = false;
let restartTimer: number | undefined;
let finalized = '';

function setStatus(kind: 'idle' | 'listening' | 'error', message: string): void {
  status.className = `status ${kind}`;
  const label = status.querySelector('strong');
  if (label) label.textContent = message;
}

function renderTranscript(interim = ''): void {
  finalText.textContent = finalized;
  interimText.textContent = interim;
  placeholder.hidden = Boolean(finalized || interim);
}

function configureRecognition(): SpeechRecognitionLike {
  if (!Recognition) throw new Error('SpeechRecognition is unavailable.');
  const instance = new Recognition();
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;
  instance.lang = language.value;

  instance.onstart = () => {
    starting = false;
    setStatus('listening', 'Listening');
    toggle.textContent = 'Stop listening';
  };

  instance.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result?.[0]?.transcript ?? '';
      if (result?.isFinal) {
        finalized += `${text.trim()} `;
      } else {
        interim += text;
      }
    }
    renderTranscript(interim.trim());
  };

  instance.onerror = (event) => {
    starting = false;
    const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error);
    if (fatal) shouldListen = false;
    const messages: Record<string, string> = {
      'not-allowed': 'Microphone permission was denied. Use Start listening to try again.',
      'service-not-allowed': 'Speech recognition is blocked by this browser.',
      'audio-capture': 'No working microphone was found.',
      'network': 'Speech recognition needs a network connection in this browser.',
      'no-speech': 'No speech detected. Still listening…',
      'language-not-supported': 'The selected language is not supported.',
    };
    setStatus(fatal ? 'error' : 'idle', messages[event.error] ?? event.message ?? `Recognition error: ${event.error}`);
  };

  instance.onend = () => {
    starting = false;
    if (shouldListen) {
      setStatus('idle', 'Restarting recognition…');
      restartTimer = window.setTimeout(startRecognition, 250);
    } else {
      setStatus('idle', 'Not listening');
      toggle.textContent = 'Start listening';
    }
  };

  return instance;
}

function startRecognition(): void {
  if (!Recognition || starting || !shouldListen) return;
  window.clearTimeout(restartTimer);
  recognition?.abort();
  recognition = configureRecognition();
  starting = true;
  setStatus('idle', 'Opening microphone…');
  try {
    recognition.start();
  } catch (error) {
    starting = false;
    shouldListen = false;
    setStatus('error', error instanceof Error ? error.message : 'Could not start speech recognition.');
    toggle.textContent = 'Start listening';
  }
}

function stopRecognition(): void {
  shouldListen = false;
  starting = false;
  window.clearTimeout(restartTimer);
  recognition?.stop();
  setStatus('idle', 'Not listening');
  toggle.textContent = 'Start listening';
}

if (!Recognition) {
  toggle.disabled = true;
  language.disabled = true;
  setStatus('error', 'SpeechRecognition is not supported in this browser.');
  supportNote.hidden = false;
  supportNote.textContent = 'Open this page in a current desktop version of Chrome or Microsoft Edge.';
} else {
  const browserLanguage = navigator.language;
  if ([...language.options].some((option) => option.value === browserLanguage)) language.value = browserLanguage;
  shouldListen = true;
  startRecognition();
}

toggle.addEventListener('click', () => {
  if (shouldListen) stopRecognition();
  else {
    shouldListen = true;
    startRecognition();
  }
});

language.addEventListener('change', () => {
  if (!shouldListen) return;
  recognition?.abort();
});

clear.addEventListener('click', () => {
  finalized = '';
  renderTranscript();
});

copy.addEventListener('click', async () => {
  if (!finalized.trim()) return;
  await navigator.clipboard.writeText(finalized.trim());
  copy.textContent = 'Copied';
  window.setTimeout(() => { copy.textContent = 'Copy text'; }, 1200);
});

window.addEventListener('beforeunload', () => {
  shouldListen = false;
  recognition?.abort();
});
