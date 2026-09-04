export const PROTOCOL_VERSION = 1;
export const DEFAULT_BAUD_RATE = 115200;

export type SerialConnectionState = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'error';
export type TimerCommand = 'start' | 'pause' | 'resume' | 'reset' | 'advance';

export type ControllerStage = {
  name: string;
  threshold: number;
  color: string;
  blink?: boolean;
  buzzer: 'none' | 'once' | 'repeat';
};

export type ControllerPreset = {
  name: string;
  speaker: string;
  duration: number;
  stages: ControllerStage[];
};

export type DeviceMessage = {
  version?: number;
  type?: string;
  [key: string]: unknown;
};

export type DeviceStatusMessage = DeviceMessage & {
  type: 'status';
  state?: 'idle' | 'running' | 'paused' | string;
  elapsed?: number;
  stage?: number;
};

export type SerialStatus = {
  state: SerialConnectionState;
  message: string;
  firmware?: string;
};

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

declare global {
  interface Navigator {
    serial?: SerialLike;
  }
}

function serialApi(): SerialLike | undefined {
  return navigator.serial;
}

export class ArduinoSerial {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopTask: Promise<void> | null = null;
  private lineBuffer = '';
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private listeners = new Set<(status: SerialStatus) => void>();
  private messageListeners = new Set<(message: DeviceMessage) => void>();
  private currentStatus: SerialStatus = serialApi()
    ? { state: 'disconnected', message: 'Connect an Arduino controller' }
    : { state: 'unsupported', message: 'Web Serial requires desktop Chrome or Edge' };

  get status(): SerialStatus {
    return this.currentStatus;
  }

  onStatus(listener: (status: SerialStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  onMessage(listener: (message: DeviceMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async connect(port?: SerialPortLike): Promise<void> {
    const serial = serialApi();
    if (!serial) {
      this.setStatus({ state: 'unsupported', message: 'Web Serial requires desktop Chrome or Edge' });
      throw new Error('Web Serial is not supported by this browser.');
    }

    if (this.currentStatus.state === 'connected') return;
    this.setStatus({ state: 'connecting', message: 'Choose the TimeLight USB serial port' });

    try {
      this.port = port ?? await serial.requestPort();
      await this.port.open({ baudRate: DEFAULT_BAUD_RATE });
      this.startReading();
      await this.waitForReady();
      this.setStatus({ state: 'connected', message: 'Controller ready' });
    } catch (error) {
      await this.closePort();
      const message = error instanceof Error ? error.message : 'Could not connect to the controller';
      this.setStatus({ state: 'error', message });
      throw error;
    }
  }

  async reconnect(): Promise<boolean> {
    const serial = serialApi();
    if (!serial) return false;
    const ports = await serial.getPorts();
    if (!ports.length) return false;
    await this.connect(ports[0]);
    return true;
  }

  async disconnect(): Promise<void> {
    await this.closePort();
    this.setStatus({ state: 'disconnected', message: 'Controller disconnected' });
  }

  async sendConfiguration(preset: ControllerPreset): Promise<void> {
    await this.send({
      type: 'configure',
      preset: {
        name: preset.name,
        speaker: preset.speaker,
        duration: preset.duration,
        stages: preset.stages,
      },
    });
  }

  async sendTimerCommand(command: TimerCommand): Promise<void> {
    await this.send({ type: 'timer', action: command });
  }

  private async send(payload: DeviceMessage): Promise<void> {
    if (this.currentStatus.state !== 'connected' || !this.port?.writable) {
      throw new Error('Connect the Arduino controller before sending commands.');
    }

    const message = JSON.stringify({ version: PROTOCOL_VERSION, requestId: crypto.randomUUID(), ...payload }) + '\n';
    this.writer = this.port.writable.getWriter();
    try {
      await this.writer.write(new TextEncoder().encode(message));
    } finally {
      this.writer.releaseLock();
      this.writer = null;
    }
  }

  private startReading(): void {
    if (!this.port?.readable || this.readLoopTask) return;
    this.readLoopTask = this.readMessages(this.port.readable).finally(() => {
      this.readLoopTask = null;
    });
  }

  private async readMessages(readable: ReadableStream<Uint8Array>): Promise<void> {
    this.reader = readable.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.lineBuffer += decoder.decode(value, { stream: true });
        const lines = this.lineBuffer.split('\n');
        this.lineBuffer = lines.pop() ?? '';
        lines.map((line) => line.trim()).filter(Boolean).forEach((line) => this.handleLine(line));
      }
    } catch (error) {
      if (this.currentStatus.state === 'connected') {
        this.setStatus({ state: 'error', message: error instanceof Error ? error.message : 'Serial communication error' });
      }
    } finally {
      this.reader.releaseLock();
      this.reader = null;
      if (this.currentStatus.state === 'connected') {
        this.setStatus({ state: 'disconnected', message: 'Controller disconnected' });
      }
    }
  }

  private handleLine(line: string): void {
    let message: DeviceMessage;
    try {
      message = JSON.parse(line) as DeviceMessage;
    } catch {
      this.setStatus({ state: 'error', message: 'Controller sent malformed JSON' });
      return;
    }

    if (message.version !== PROTOCOL_VERSION) {
      this.setStatus({ state: 'error', message: `Unsupported controller protocol (expected v${PROTOCOL_VERSION})` });
      return;
    }

    if (message.type === 'ready') {
      const firmware = typeof message.firmware === 'string' ? message.firmware : undefined;
      this.readyResolver?.();
      this.readyResolver = null;
      this.readyRejecter = null;
      this.setStatus({ state: 'connected', message: 'Controller ready', firmware });
    } else if (message.type === 'error') {
      this.setStatus({ state: 'error', message: typeof message.message === 'string' ? message.message : 'Controller rejected a message' });
    }

    this.messageListeners.forEach((listener) => listener(message));
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
      window.setTimeout(() => {
        if (!this.readyResolver) return;
        this.readyResolver = null;
        this.readyRejecter = null;
        reject(new Error('Timed out waiting for the controller ready message.'));
      }, 8000);
    });
  }

  private async closePort(): Promise<void> {
    this.readyRejecter?.(new Error('Serial connection closed.'));
    this.readyResolver = null;
    this.readyRejecter = null;
    if (this.reader) await this.reader.cancel().catch(() => undefined);
    if (this.readLoopTask) await this.readLoopTask.catch(() => undefined);
    if (this.writer) this.writer.releaseLock();
    this.writer = null;
    if (this.port) await this.port.close().catch(() => undefined);
    this.port = null;
    this.lineBuffer = '';
  }

  private setStatus(status: SerialStatus): void {
    this.currentStatus = status;
    this.listeners.forEach((listener) => listener(status));
  }
}
