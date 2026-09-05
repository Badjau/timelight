export const PROTOCOL_VERSION = 3;
export const DEFAULT_BAUD_RATE = 115200;
export const OUTPUT_LEASE_MS = 3000;

export type SerialConnectionState = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error';
export type LedEffect = 'off' | 'solid' | 'blink';
export type BuzzerMode = 'none' | 'repeat';
export type OutputSnapshot = { revision: number; color: string; ledEffect: LedEffect; transitionMs: number; animationState: 'playing' | 'paused'; buzzerMode: BuzzerMode };
export type DeviceMessage = { version?: number; type?: string; [key: string]: unknown };
export type ReadyMessage = DeviceMessage & { type: 'ready'; firmware?: string; ledCount?: number; buttons?: string[]; requestId?: string };
export type ButtonMessage = DeviceMessage & { type: 'button'; button?: string; sequence?: number };
export type SerialStatus = { state: SerialConnectionState; message: string; firmware?: string; warning?: boolean; ledCount?: number };

export interface SerialPortLike { readable: ReadableStream<Uint8Array> | null; writable: WritableStream<Uint8Array> | null; open(options: { baudRate: number }): Promise<void>; close(): Promise<void> }
export interface SerialLike { requestPort(): Promise<SerialPortLike>; getPorts(): Promise<SerialPortLike[]> }
declare global { interface Navigator { serial?: SerialLike } }
function serialApi(): SerialLike | undefined { return typeof navigator === 'undefined' ? undefined : navigator.serial; }
function requestId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
type PendingAck = { resolve: (message: DeviceMessage) => void; reject: (error: Error) => void };

export class ArduinoSerial {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private requestQueue: Promise<void> = Promise.resolve();
  private readLoopTask: Promise<void> | null = null;
  private lineBuffer = '';
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private readyTimer: number | undefined;
  private keepaliveTimer: number | undefined;
  private pending = new Map<string, PendingAck>();
  private outputPending: OutputSnapshot | null = null;
  private outputTask: Promise<void> | null = null;
  private sessionId = requestId();
  private listeners = new Set<(status: SerialStatus) => void>();
  private messageListeners = new Set<(message: DeviceMessage) => void>();
  private readyListeners = new Set<(message: ReadyMessage) => void>();
  private currentStatus: SerialStatus = serialApi() ? { state: 'disconnected', message: 'Connect an Arduino controller' } : { state: 'unsupported', message: 'Web Serial requires desktop Chrome or Edge' };

  constructor(private readonly api: SerialLike | undefined = serialApi()) {}
  get status(): SerialStatus { return this.currentStatus; }
  get browserSessionId(): string { return this.sessionId; }
  onStatus(listener: (status: SerialStatus) => void): () => void { this.listeners.add(listener); listener(this.currentStatus); return () => this.listeners.delete(listener); }
  onMessage(listener: (message: DeviceMessage) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onReady(listener: (message: ReadyMessage) => void): () => void { this.readyListeners.add(listener); return () => this.readyListeners.delete(listener); }

  async connect(port?: SerialPortLike): Promise<void> {
    if (!this.api) { this.setStatus({ state: 'unsupported', message: 'Web Serial requires desktop Chrome or Edge' }); throw new Error('Web Serial is not supported by this browser.'); }
    if (this.currentStatus.state === 'connected') return;
    this.setStatus({ state: 'connecting', message: 'Connecting to the TimeLight controller' });
    try {
      this.port = port ?? await this.api.requestPort(); await this.port.open({ baudRate: DEFAULT_BAUD_RATE }); this.startReading(); await this.waitForReady();
      this.setStatus({ state: 'connected', message: 'Controller ready', firmware: this.currentStatus.firmware, ledCount: this.currentStatus.ledCount }); this.startKeepalive();
    } catch (error) { await this.closePort(); const message = error instanceof Error ? error.message : 'Could not connect to the controller'; this.setStatus({ state: 'error', message }); throw error; }
  }
  async reconnect(): Promise<boolean> { if (!this.api) return false; const ports = await this.api.getPorts(); if (!ports.length) return false; await this.closePort(); await this.connect(ports[0]); return true; }
  async disconnect(): Promise<void> { await this.closePort(); this.setStatus({ state: 'disconnected', message: 'Controller disconnected' }); }

  async setOutputs(snapshot: OutputSnapshot): Promise<void> {
    this.outputPending = snapshot;
    while (this.outputPending) {
      if (!this.outputTask) {
        const task = (async () => { try { while (this.outputPending) { const next = this.outputPending; this.outputPending = null; await this.sendRequest({ type: 'set_outputs', sessionId: this.sessionId, revision: next.revision, color: next.color, ledEffect: next.ledEffect, transitionMs: next.transitionMs, animationState: next.animationState, buzzerMode: next.buzzerMode, leaseMs: next.buzzerMode === 'repeat' ? OUTPUT_LEASE_MS : 0 }); } } catch (error) { if (this.currentStatus.state === 'connected') this.setStatus({ state: 'error', message: 'Controller stopped acknowledging output; reconnecting' }); throw error; } })();
        const tracked = task.finally(() => { if (this.outputTask === tracked) this.outputTask = null; });
        this.outputTask = tracked;
      }
      await this.outputTask;
    }
  }
  async buzzOnce(eventId: string): Promise<void> { await this.sendRequest({ type: 'buzz_once', sessionId: this.sessionId, eventId }); }
  async ping(): Promise<void> { await this.sendRequest({ type: 'ping' }); }

  private sendRequest(payload: DeviceMessage, attempts = 3): Promise<DeviceMessage> {
    const task = this.requestQueue.then(() => this.performRequest(payload, attempts));
    this.requestQueue = task.then(() => undefined, () => undefined);
    return task;
  }
  private async performRequest(payload: DeviceMessage, attempts: number): Promise<DeviceMessage> {
    if (!this.port?.writable || (this.currentStatus.state !== 'connected' && payload.type !== 'hello')) throw new Error('Connect the Arduino controller before sending commands.');
    const id = requestId();
    for (let attempt = 0; attempt < attempts; attempt++) {
      const acknowledgement = this.waitForAck(id, 500);
      acknowledgement.catch(() => undefined);
      try { await this.write({ version: PROTOCOL_VERSION, requestId: id, ...payload }); return await acknowledgement; }
      catch (error) {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); pending.reject(error instanceof Error ? error : new Error('Serial write failed.')); }
        if (attempt === attempts - 1) throw error;
      }
    }
    throw new Error('The controller did not acknowledge the command.');
  }
  private async write(message: DeviceMessage): Promise<void> {
    const task = this.writeQueue.then(async () => {
      if (!this.port?.writable) throw new Error('The controller serial port is not writable.');
      const writer = this.port.writable.getWriter(); this.writer = writer;
      try { await writer.write(new TextEncoder().encode(JSON.stringify(message) + '\n')); }
      finally { writer.releaseLock(); if (this.writer === writer) this.writer = null; }
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }
  private waitForAck(id: string, timeoutMs: number): Promise<DeviceMessage> { return new Promise((resolve, reject) => { const timeout = window.setTimeout(() => { this.pending.delete(id); reject(new Error(`Controller acknowledgement timed out for ${id}.`)); }, timeoutMs); this.pending.set(id, { resolve: (message) => { window.clearTimeout(timeout); resolve(message); }, reject: (error) => { window.clearTimeout(timeout); reject(error); } }); }); }
  private startReading(): void { if (!this.port?.readable || this.readLoopTask) return; this.readLoopTask = this.readMessages(this.port.readable).finally(() => { this.readLoopTask = null; }); }
  private async readMessages(readable: ReadableStream<Uint8Array>): Promise<void> {
    this.reader = readable.getReader(); const decoder = new TextDecoder();
    try { while (true) { const { value, done } = await this.reader.read(); if (done) break; this.lineBuffer += decoder.decode(value, { stream: true }); const lines = this.lineBuffer.split('\n'); this.lineBuffer = lines.pop() ?? ''; lines.map((line) => line.trim()).filter(Boolean).forEach((line) => this.handleLine(line)); } }
    catch (error) { if (this.currentStatus.state !== 'disconnected') this.setStatus({ state: 'error', message: error instanceof Error ? error.message : 'Serial communication error' }); }
    finally { this.reader.releaseLock(); this.reader = null; if (this.currentStatus.state !== 'disconnected') this.setStatus({ state: 'disconnected', message: 'Controller connection lost' }); }
  }
  private handleLine(line: string): void {
    let message: DeviceMessage;
    try { message = JSON.parse(line) as DeviceMessage; } catch { this.setStatus({ ...this.currentStatus, message: 'Controller warning: malformed JSON ignored', warning: true }); return; }
    if (message.version !== PROTOCOL_VERSION) { this.setStatus({ ...this.currentStatus, message: `Incompatible controller protocol (expected v${PROTOCOL_VERSION})`, warning: true }); return; }
    if (message.type === 'ack' && typeof message.requestId === 'string') { const waiter = this.pending.get(message.requestId); if (waiter) { this.pending.delete(message.requestId); waiter.resolve(message); if (this.currentStatus.state === 'connected' && this.currentStatus.warning) this.setStatus({ ...this.currentStatus, message: 'Controller ready', warning: false }); } }
    if (message.type === 'error') { const waiter = typeof message.requestId === 'string' ? this.pending.get(message.requestId) : undefined; if (waiter && typeof message.requestId === 'string') { this.pending.delete(message.requestId); waiter.reject(new Error(typeof message.message === 'string' ? message.message : 'Controller rejected the command.')); } else this.setStatus({ ...this.currentStatus, message: typeof message.message === 'string' ? `Controller warning: ${message.message}` : 'Controller warning', warning: true }); }
    if (message.type === 'ready') this.handleReady(message as ReadyMessage);
    this.messageListeners.forEach((listener) => listener(message));
  }
  private handleReady(message: ReadyMessage): void {
    const firmware = typeof message.firmware === 'string' ? message.firmware : undefined; const ledCount = typeof message.ledCount === 'number' ? message.ledCount : undefined;
    this.currentStatus = { ...this.currentStatus, firmware, ledCount, message: 'Controller ready', warning: false };
    const requestMatchesHandshake = typeof message.requestId === 'string';
    if (requestMatchesHandshake) {
      this.readyResolver?.(); this.readyResolver = null; this.readyRejecter = null;
      this.setStatus({ state: 'connected', message: 'Controller ready', firmware, ledCount }); this.startKeepalive(); this.readyListeners.forEach((listener) => listener(message));
    } else if (this.currentStatus.state === 'connected') {
      this.setStatus({ state: 'connecting', message: 'Controller restarted; reconnecting' }); void this.waitForReady().then(() => { this.setStatus({ state: 'connected', message: 'Controller ready', firmware, ledCount }); this.startKeepalive(); this.readyListeners.forEach((listener) => listener(message)); }).catch(() => undefined);
    }
  }
  private waitForReady(): Promise<void> { return new Promise((resolve, reject) => { this.readyResolver = resolve; this.readyRejecter = reject; const deadline = Date.now() + 8000; const sendHello = () => { if (!this.readyResolver) return; if (Date.now() >= deadline) { this.readyResolver = null; this.readyRejecter = null; reject(new Error('Timed out waiting for the controller ready message.')); return; } void this.write({ version: PROTOCOL_VERSION, requestId: requestId(), type: 'hello', sessionId: this.sessionId }).catch(() => undefined); this.readyTimer = window.setTimeout(sendHello, 250); }; sendHello(); }); }
  private startKeepalive(): void { if (this.keepaliveTimer) window.clearInterval(this.keepaliveTimer); this.keepaliveTimer = window.setInterval(() => { if (this.currentStatus.state === 'connected') void this.sendRequest({ type: 'keepalive', sessionId: this.sessionId }, 1).catch(() => undefined); }, 1000); }
  private async closePort(): Promise<void> { if (this.readyTimer) window.clearTimeout(this.readyTimer); this.readyTimer = undefined; if (this.keepaliveTimer) window.clearInterval(this.keepaliveTimer); this.keepaliveTimer = undefined; this.readyRejecter?.(new Error('Serial connection closed.')); this.readyResolver = null; this.readyRejecter = null; this.pending.forEach(({ reject }) => reject(new Error('Serial connection closed.'))); this.pending.clear(); if (this.reader) await this.reader.cancel().catch(() => undefined); if (this.readLoopTask) await this.readLoopTask.catch(() => undefined); if (this.writer) this.writer.releaseLock(); this.writer = null; if (this.port) await this.port.close().catch(() => undefined); this.port = null; this.lineBuffer = ''; this.outputPending = null; }
  private setStatus(status: SerialStatus): void { this.currentStatus = status; this.listeners.forEach((listener) => listener(status)); }
}
