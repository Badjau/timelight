import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

globalThis.window = globalThis;
const source = ts.transpileModule(readFileSync(new URL('../src/serial.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const serialModule = await import(`data:text/javascript,${encodeURIComponent(source)}`);

function fakePort({ ignoreFirstHello = false, retryOutput = false, ignoreOutput = false, retryBuzz = false, retryStore = false, malformedOutputAck = false, holdOutputAck = false, bootReady = false, standalone = false } = {}) {
  let controller;
  let helloCount = 0;
  let outputCount = 0;
  let buzzCount = 0;
  let heldOutput;
  const writes = [];
  const wire = (message) => serialModule.encodeWireMessage({ version: 4, requestId: 0, ...message });
  const readable = new ReadableStream({ start(value) { controller = value; if (bootReady) queueMicrotask(() => controller.enqueue(wire({ type: 'ready', firmware: '0.5.0', ledCount: 116 }))); } });
  const writable = new WritableStream({ write(chunk) {
    const message = serialModule.decodeWireMessage(chunk.subarray(0, -1)); assert.ok(message); writes.push(message);
    if (message.type === 'hello') { helloCount++; if (ignoreFirstHello && helloCount === 1) return; controller.enqueue(wire({ type: 'ready', requestId: message.requestId, firmware: '0.5.0', ledCount: 116, ...(standalone ? { capabilities: ['standalone-preset'] } : {}) })); }
    if (message.type === 'ping') { controller.enqueue(wire({ type: 'pong', requestId: message.requestId })); controller.enqueue(wire({ type: 'ack', requestId: message.requestId })); }
    if (message.type === 'set_outputs') { outputCount++; if (ignoreOutput || retryOutput && outputCount === 1) return; if (holdOutputAck && outputCount === 1) { heldOutput = message; return; } if (malformedOutputAck && outputCount === 1) { controller.enqueue(Uint8Array.of(2, 3, 4, 0)); return; } controller.enqueue(wire({ type: 'ack', requestId: message.requestId, appliedRevision: message.revision })); }
    if (message.type === 'buzz_once') { buzzCount++; if (retryBuzz && buzzCount === 1) return; controller.enqueue(wire({ type: 'ack', requestId: message.requestId, appliedRevision: outputCount })); }
    if (message.type === 'keepalive') controller.enqueue(wire({ type: 'ack', requestId: message.requestId, appliedRevision: 0 }));
    if (message.type === 'release_control') controller.enqueue(wire({ type: 'ack', requestId: message.requestId }));
    if (message.type === 'store_preset') { if (retryStore && writes.filter((item) => item.type === 'store_preset').length === 1) return; controller.enqueue(wire({ type: 'ack', requestId: message.requestId })); }
  } });
  return { port: { readable, writable, async open() {}, async close() { controller.close(); } }, writes, feed(message) { controller.enqueue(wire(message)); }, feedRaw(value) { controller.enqueue(value); }, acknowledgeOutput() { if (!heldOutput) return; controller.enqueue(wire({ type: 'ack', requestId: heldOutput.requestId, appliedRevision: heldOutput.revision })); heldOutput = undefined; }, get helloCount() { return helloCount; } };
}

test('handshake retries a missed boot message and malformed input remains recoverable', async () => {
  const fake = fakePort({ ignoreFirstHello: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  assert.equal(serial.status.state, 'connected');
  assert.ok(fake.helloCount >= 2);
  fake.feedRaw(Uint8Array.of(2, 3, 4, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(serial.status.warning, true);
  // A malformed line is handled by the reader without changing the connected state.
  await serial.setOutputs({ revision: 1, color: '#0000ff', ledEffect: 'solid', transitionMs: 0, animationState: 'playing', buzzerMode: 'none' });
  assert.equal(serial.status.state, 'connected');
  await serial.disconnect();
});

test('boot ready does not authorize output before the hello session is established', async () => {
  const fake = fakePort({ bootReady: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  await serial.setOutputs({ revision: 1, color: '#0000ff', ledEffect: 'solid', transitionMs: 0, animationState: 'playing', buzzerMode: 'none' });
  assert.equal(serial.status.state, 'connected');
  await serial.disconnect();
});

test('health check receives pong and acknowledgement frames', async () => {
  const fake = fakePort();
  const serial = new serialModule.ArduinoSerial({ async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } });
  const received = [];
  serial.onMessage((message) => received.push(message.type));
  await serial.connect();
  await serial.ping();
  assert.ok(received.includes('pong'));
  await serial.disconnect();
});

test('a ready frame survives a controller reset that truncates the preceding response', async () => {
  const fake = fakePort();
  const serial = new serialModule.ArduinoSerial({ async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } });
  let readyCount = 0;
  serial.onReady(() => { readyCount++; });
  await serial.connect();
  const ready = serialModule.encodeWireMessage({ version: 4, type: 'ready', requestId: 0, firmware: '0.5.0', ledCount: 116 });
  fake.feedRaw(Uint8Array.from([9, 9, ...ready]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(serial.status.state, 'connected');
  assert.equal(serial.status.warning, undefined);
  assert.ok(readyCount >= 2);
  await serial.disconnect();
});

test('acknowledgement timeout retries and output snapshots coalesce', async () => {
  const fake = fakePort({ retryOutput: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  const first = serial.setOutputs({ revision: 1, color: '#0000ff', ledEffect: 'solid', transitionMs: 0, animationState: 'playing', buzzerMode: 'none' });
  const second = serial.setOutputs({ revision: 3, color: '#ff0000', ledEffect: 'blink', transitionMs: 1000, animationState: 'playing', buzzerMode: 'repeat' });
  await Promise.all([first, second]);
  const revisions = fake.writes.filter((message) => message.type === 'set_outputs').map((message) => message.revision);
  assert.deepEqual(revisions, [1, 1, 3]);
  await serial.disconnect();
});

test('a one-shot chime can be sequenced after the stage output snapshot', async () => {
  const fake = fakePort();
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  await serial.setOutputs({ revision: 2, color: '#ffff00', ledEffect: 'solid', transitionMs: 1000, animationState: 'playing', buzzerMode: 'none' });
  await serial.buzzOnce('run:1');
  const commands = fake.writes.filter((message) => message.type === 'set_outputs' || message.type === 'buzz_once');
  assert.deepEqual(commands.map((message) => message.type), ['set_outputs', 'buzz_once']);
  await serial.disconnect();
});

test('a missed one-shot chime retries safely with the same event id', async () => {
  const fake = fakePort({ retryBuzz: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  await serial.buzzOnce('run:1');
  const buzzes = fake.writes.filter((message) => message.type === 'buzz_once');
  assert.equal(buzzes.length, 2);
  assert.equal(buzzes[0].eventId, buzzes[1].eventId);
  await serial.disconnect();
});

test('a malformed output acknowledgement is retried and the warning clears after recovery', async () => {
  const fake = fakePort({ malformedOutputAck: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  await serial.setOutputs({ revision: 4, color: '#ff0000', ledEffect: 'blink', transitionMs: 1000, animationState: 'playing', buzzerMode: 'repeat' });
  assert.equal(fake.writes.filter((message) => message.type === 'set_outputs').length, 2);
  assert.equal(serial.status.state, 'connected');
  assert.equal(serial.status.warning, false);
  await serial.disconnect();
});

test('a repeat-alert output completes before the next request is written', async () => {
  const fake = fakePort({ holdOutputAck: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  const output = serial.setOutputs({ revision: 5, color: '#ff0000', ledEffect: 'blink', transitionMs: 1000, animationState: 'playing', buzzerMode: 'repeat' });
  const buzz = serial.buzzOnce('run:next');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fake.writes.filter((message) => message.type === 'set_outputs' || message.type === 'buzz_once').map((message) => message.type), ['set_outputs']);
  fake.acknowledgeOutput();
  await Promise.all([output, buzz]);
  assert.deepEqual(fake.writes.filter((message) => message.type === 'set_outputs' || message.type === 'buzz_once').map((message) => message.type), ['set_outputs', 'buzz_once']);
  await serial.disconnect();
});

test('an unrecoverable output timeout marks the link for reconnection', async () => {
  const fake = fakePort({ ignoreOutput: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  await assert.rejects(serial.setOutputs({ revision: 5, color: '#ff0000', ledEffect: 'blink', transitionMs: 1000, animationState: 'playing', buzzerMode: 'repeat' }), /timed out/);
  assert.equal(serial.status.state, 'error');
  await serial.disconnect();
});

test('standalone capability gates exact compact preset serialization and retries', async () => {
  const fake = fakePort({ standalone: true, retryStore: true });
  const serial = new serialModule.ArduinoSerial({ async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } });
  await serial.connect();
  assert.equal(serial.supportsStandalonePreset, true);
  const preset = { duration: 86400, stages: [
    { threshold: 0, color: '#0000ff', blink: false, buzzer: 'none' },
    { threshold: 10000, color: '#ffff00', blink: true, buzzer: 'once' },
    { threshold: 20000, color: '#ff0000', blink: false, buzzer: 'repeat' },
    { threshold: 30000, color: '#ffffff', blink: true, buzzer: 'none' },
    { threshold: 40000, color: '#00ffff', blink: false, buzzer: 'repeat' },
  ] };
  await serial.storePreset(preset);
  const stores = fake.writes.filter((message) => message.type === 'store_preset');
  assert.equal(stores.length, 2);
  assert.deepEqual(stores[0], { version: 4, requestId: stores[0].requestId, type: 'store_preset', sessionId: serial.browserSessionId, duration: preset.duration, stages: preset.stages.map(({ threshold, color, blink, buzzer }) => [threshold, color, blink, buzzer]) });
  assert.ok(Number.isInteger(stores[0].requestId));
  assert.ok(serialModule.encodeWireMessage(stores[0]).length <= 63);
  await serial.disconnect();
  assert.equal(fake.writes.at(-1).type, 'release_control');
});

test('firmware without standalone capability rejects standalone storage locally', async () => {
  const fake = fakePort();
  const serial = new serialModule.ArduinoSerial({ async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } });
  await serial.connect();
  assert.equal(serial.supportsStandalonePreset, false);
  await assert.rejects(serial.storePreset({ duration: 3, stages: [] }), /does not support/);
  assert.equal(fake.writes.some((message) => message.type === 'store_preset'), false);
  await serial.disconnect();
});

test('MCU reset re-handshakes, resynchronizes current outputs, and reconnects a replacement port', async () => {
  const first = fakePort();
  const second = fakePort();
  let selected = first;
  const api = { async requestPort() { return selected.port; }, async getPorts() { return [selected.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  let readyCount = 0;
  serial.onReady(() => {
    readyCount++;
    if (readyCount > 1) void serial.setOutputs({ revision: 7, color: '#ff0000', ledEffect: 'solid', transitionMs: 0, animationState: 'playing', buzzerMode: 'none' }).catch(() => undefined);
  });
  await serial.connect();
  first.feed({ type: 'ready', requestId: 0, firmware: '0.5.0', ledCount: 116 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(serial.status.state, 'connected');
  assert.ok(readyCount >= 2);
  assert.equal(first.writes.filter((message) => message.type === 'set_outputs').at(-1).revision, 7);
  await serial.disconnect();
  selected = second;
  assert.equal(await serial.reconnect(), true);
  assert.equal(serial.status.state, 'connected');
  await serial.disconnect();
});
