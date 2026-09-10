import type { Stage } from './timer';

interface RecognitionResultLike { isFinal: boolean; readonly length: number; [index: number]: { transcript: string } }
interface RecognitionEventLike extends Event { results: ArrayLike<RecognitionResultLike> }
interface RecognitionErrorLike extends Event { error: string; message?: string }
interface RecognitionLike {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void; abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
}
interface RecognitionConstructor { new(): RecognitionLike }
const speechWindow = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };

export interface TranscriptMoment { seconds: number; stage: Stage }
interface TranscriptEntry extends TranscriptMoment { text: string }

const copyIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="6" width="9" height="10" rx="1.5"/><path d="M5 13.5H4.5A1.5 1.5 0 0 1 3 12V4.5A1.5 1.5 0 0 1 4.5 3H12a1.5 1.5 0 0 1 1.5 1.5V5"/></svg>';
const microphoneIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>';

function normalize(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
function punctuate(text: string): string {
  const clean = normalize(text);
  if (!clean) return clean;
  const capitalized = `${clean.charAt(0).toLocaleUpperCase()}${clean.slice(1)}`;
  if (/[.!?…]["')\]]*$/.test(capitalized)) return capitalized;
  return `${capitalized.replace(/[,;:]$/, '')}.`;
}
function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export class LiveTranscription {
  private readonly Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  private recognition: RecognitionLike | null = null;
  private entries: TranscriptEntry[] = [];
  private sessionFinal = '';
  private interim = '';
  private shouldListen = false;
  private starting = false;
  private open = false;
  private timerRunning = false;
  private restartTimer: number | undefined;
  private status: 'idle' | 'opening' | 'listening' | 'error' = 'idle';
  private statusMessage = 'Microphone off';
  private view: 'raw' | 'timestamp' = 'timestamp';

  constructor(private readonly getMoment: () => TranscriptMoment) {}

  markup(): string {
    return `<button type="button" class="transcription-tab transcription-tab-mobile" id="transcription-toggle-mobile" data-transcription-toggle aria-controls="transcription-panel" aria-expanded="false">${microphoneIcon}<span>Transcript</span></button><aside class="transcription-panel" id="transcription-panel" aria-label="Live transcription" data-view="timestamp" hidden><header class="transcription-header"><div><div class="transcription-status" id="transcription-status" role="status" aria-live="polite"><i></i><strong>Microphone off</strong></div></div><button type="button" class="transcription-close" id="transcription-close" aria-label="Close transcription">&times;</button></header><div class="transcription-toolbar"><div class="transcription-view-tabs" role="tablist" aria-label="Transcript view"><button type="button" id="timestamp-transcript-tab" role="tab" aria-controls="timestamp-transcript-view" aria-selected="true" data-transcript-view="timestamp">Timestamped</button><button type="button" id="raw-transcript-tab" role="tab" aria-controls="raw-transcript-view" aria-selected="false" data-transcript-view="raw" tabindex="-1">Raw</button></div><button type="button" class="transcript-copy" id="transcript-copy" data-copy="timestamp" aria-label="Copy timestamped transcript" title="Copy timestamped transcript">${copyIcon}<span>Copy</span></button></div><div class="transcription-sections"><section class="transcript-section timestamp-section" id="timestamp-transcript-view" role="tabpanel" aria-labelledby="timestamp-transcript-tab"><div class="transcript-scroll" id="timestamp-transcript" aria-live="polite"><p class="transcript-empty">Timed speech will appear here.</p></div></section><section class="transcript-section" id="raw-transcript-view" role="tabpanel" aria-labelledby="raw-transcript-tab" hidden><div class="transcript-scroll" id="raw-transcript" aria-live="polite"><p class="transcript-empty">Speech will appear here.</p></div></section></div></aside>`;
  }

  bind(): void {
    const panel = document.querySelector<HTMLElement>('#transcription-panel');
    const mobileToggle = document.querySelector<HTMLButtonElement>('#transcription-toggle-mobile');
    const nextStageButton = document.querySelector<HTMLButtonElement>('#local-next-stage');
    if (!panel || !mobileToggle || !nextStageButton) return;
    const desktopToggle = mobileToggle.cloneNode(true) as HTMLButtonElement;
    desktopToggle.id = 'transcription-toggle';
    desktopToggle.classList.replace('transcription-tab-mobile', 'transcription-tab-desktop');
    nextStageButton.insertAdjacentElement('afterend', desktopToggle);
    panel.hidden = !this.open;
    const toggles = document.querySelectorAll<HTMLButtonElement>('[data-transcription-toggle]');
    toggles.forEach((toggle) => toggle.setAttribute('aria-expanded', String(this.open)));
    document.querySelector('#timer-panel')?.classList.toggle('transcription-open', this.open);
    toggles.forEach((toggle) => toggle.addEventListener('click', () => this.open ? this.close() : this.show()));
    document.querySelector('#transcription-close')?.addEventListener('click', () => this.close());
    document.querySelectorAll<HTMLButtonElement>('[data-transcript-view]').forEach((button) => button.addEventListener('click', () => this.switchView(button.dataset.transcriptView === 'raw' ? 'raw' : 'timestamp')));
    document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => button.addEventListener('click', () => { void this.copy(button); }));
    this.switchView(this.view);
    this.render();
  }

  private switchView(view: 'raw' | 'timestamp'): void {
    this.view = view;
    const panel = document.querySelector<HTMLElement>('#transcription-panel');
    panel?.setAttribute('data-view', view);
    document.querySelectorAll<HTMLButtonElement>('[data-transcript-view]').forEach((button) => {
      const selected = button.dataset.transcriptView === view;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const raw = document.querySelector<HTMLElement>('#raw-transcript-view');
    const timestamp = document.querySelector<HTMLElement>('#timestamp-transcript-view');
    if (raw) raw.hidden = view !== 'raw';
    if (timestamp) timestamp.hidden = view !== 'timestamp';
    const copy = document.querySelector<HTMLButtonElement>('#transcript-copy');
    if (copy) {
      copy.dataset.copy = view;
      copy.setAttribute('aria-label', `Copy ${view === 'timestamp' ? 'timestamped' : 'raw'} transcript`);
      copy.title = `Copy ${view === 'timestamp' ? 'timestamped' : 'raw'} transcript`;
    }
  }

  show(): void {
    this.open = true;
    const panel = document.querySelector<HTMLElement>('#transcription-panel');
    if (panel) panel.hidden = false;
    document.querySelector('#timer-panel')?.classList.add('transcription-open');
    document.querySelectorAll('[data-transcription-toggle]').forEach((toggle) => toggle.setAttribute('aria-expanded', 'true'));
    if (this.timerRunning) this.start();
    else {
      this.status = 'idle';
      this.statusMessage = 'Start the timer to transcribe';
      this.renderStatus();
    }
  }

  close(): void {
    this.open = false;
    document.querySelector<HTMLElement>('#transcription-panel')?.setAttribute('hidden', '');
    document.querySelector('#timer-panel')?.classList.remove('transcription-open');
    document.querySelectorAll('[data-transcription-toggle]').forEach((toggle) => toggle.setAttribute('aria-expanded', 'false'));
    this.stop();
  }

  stop(): void {
    this.stopListening('Microphone off');
  }

  syncTimer(running: boolean, clearSession = false): void {
    if (clearSession) this.clear();
    if (this.timerRunning === running) return;
    this.timerRunning = running;
    if (running && this.open) this.start();
    else if (!running && this.open) this.stopListening('Timer paused · transcription paused');
  }

  clear(): void {
    this.entries = [];
    this.sessionFinal = '';
    this.interim = '';
    this.render();
  }

  private stopListening(message: string): void {
    this.shouldListen = false;
    this.starting = false;
    window.clearTimeout(this.restartTimer);
    this.recognition?.stop();
    this.recognition = null;
    this.status = 'idle';
    this.statusMessage = message;
    this.renderStatus();
  }

  private start(): void {
    if (!this.Recognition) {
      this.status = 'error'; this.statusMessage = 'Transcription is unavailable in this browser'; this.renderStatus(); return;
    }
    this.shouldListen = true;
    this.startSession();
  }

  private startSession(): void {
    if (!this.timerRunning || !this.shouldListen || this.starting || this.recognition) return;
    this.starting = true;
    this.status = 'opening'; this.statusMessage = 'Allow microphone access to begin'; this.renderStatus();
    const instance = new this.Recognition!();
    instance.continuous = true; instance.interimResults = true; instance.lang = navigator.language || 'en-US';
    const finalized = new Set<number>();
    instance.onstart = () => {
      if (this.recognition !== instance) return;
      this.starting = false; this.status = 'listening'; this.statusMessage = 'Listening'; this.renderStatus();
    };
    instance.onresult = (event) => {
      if (this.recognition !== instance || !this.timerRunning) return;
      let sessionFinal = ''; let interim = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = normalize(result?.[0]?.transcript ?? '');
        if (result?.isFinal) {
          const finalText = punctuate(text);
          sessionFinal = normalize(`${sessionFinal} ${finalText}`);
          if (finalText && !finalized.has(index)) { this.entries.push({ ...this.getMoment(), text: finalText }); finalized.add(index); }
        } else interim = normalize(`${interim} ${text}`);
      }
      this.sessionFinal = sessionFinal; this.interim = interim; this.render();
    };
    instance.onerror = (event) => {
      if (this.recognition !== instance) return;
      const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error);
      const messages: Record<string, string> = { 'not-allowed': 'Microphone access was denied', 'service-not-allowed': 'Speech recognition is blocked', 'audio-capture': 'No working microphone was found', network: 'Speech recognition needs a network connection', 'no-speech': 'No speech detected; retrying', 'language-not-supported': 'Your browser language is not supported' };
      if (fatal) this.shouldListen = false;
      this.status = 'error'; this.statusMessage = messages[event.error] ?? event.message ?? `Recognition error: ${event.error}`; this.renderStatus();
    };
    instance.onend = () => {
      if (this.recognition !== instance) return;
      this.recognition = null; this.starting = false; this.sessionFinal = '';
      if (this.interim) this.entries.push({ ...this.getMoment(), text: punctuate(this.interim) });
      this.interim = ''; this.render();
      if (this.shouldListen) this.restartTimer = window.setTimeout(() => this.startSession(), 300);
    };
    this.recognition = instance;
    try { instance.start(); }
    catch (error) {
      this.recognition = null; this.starting = false; this.shouldListen = false; this.status = 'error';
      this.statusMessage = error instanceof Error ? error.message : 'Could not start transcription'; this.renderStatus();
    }
  }

  private rawText(): string { return normalize(this.entries.map((entry) => entry.text).join(' ')); }
  private timestampText(): string { return this.entries.map((entry) => `[${formatTime(entry.seconds)}] ${entry.text}`).join('\n'); }

  private render(): void {
    const raw = document.querySelector<HTMLElement>('#raw-transcript');
    const timed = document.querySelector<HTMLElement>('#timestamp-transcript');
    if (raw) {
      raw.replaceChildren(); const text = this.rawText();
      if (text || this.interim) {
        const final = document.createElement('span'); final.textContent = text;
        const interim = document.createElement('span'); interim.className = 'transcript-interim'; interim.textContent = this.interim ? `${text ? ' ' : ''}${this.interim}` : '';
        raw.append(final, interim);
      } else raw.append(this.emptyMessage('Speech will appear here.'));
      raw.scrollTop = raw.scrollHeight;
    }
    if (timed) {
      timed.replaceChildren();
      if (this.entries.length) this.entries.forEach((entry) => {
        const item = document.createElement('article'); item.className = 'timestamp-entry';
        const time = document.createElement('time'); time.dateTime = `PT${Math.floor(entry.seconds)}S`; time.textContent = formatTime(entry.seconds); time.style.setProperty('--transcript-stage-color', entry.stage.color); time.title = entry.stage.name;
        const text = document.createElement('p'); text.textContent = entry.text;
        item.append(time, text); timed.append(item);
      }); else timed.append(this.emptyMessage('Timed speech will appear here.'));
      timed.scrollTop = timed.scrollHeight;
    }
    this.renderStatus();
  }

  private emptyMessage(text: string): HTMLParagraphElement { const item = document.createElement('p'); item.className = 'transcript-empty'; item.textContent = text; return item; }
  private renderStatus(): void {
    const status = document.querySelector<HTMLElement>('#transcription-status'); if (!status) return;
    status.className = `transcription-status ${this.status}`;
    const label = status.querySelector('strong'); if (label) label.textContent = this.statusMessage;
  }
  private async copy(button: HTMLButtonElement): Promise<void> {
    const value = button.dataset.copy === 'timestamp' ? this.timestampText() : this.rawText(); if (!value) return;
    try {
      await navigator.clipboard.writeText(value); button.classList.add('copied'); button.setAttribute('aria-label', 'Copied');
      window.setTimeout(() => { button.classList.remove('copied'); button.setAttribute('aria-label', `Copy ${button.dataset.copy} transcript`); }, 1200);
    } catch { this.status = 'error'; this.statusMessage = 'The transcript could not be copied'; this.renderStatus(); }
  }
}
