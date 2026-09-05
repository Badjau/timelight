import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

globalThis.window = globalThis;
const source = ts.transpileModule(readFileSync(new URL('../src/serial.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const serialModule = await import(`data:text/javascript,${encodeURIComponent(source)}`);

function fakePort({ ignoreFirstHello = false, retryOutput = false, ignoreOutput = false, retryBuzz = false, malformedOutputAck = false, holdOutputAck = false, bootReady = false } = {}) {
  let controller;
  let helloCount = 0;
  let outputCount = 0;
  let buzzCount = 0;
  let heldOutput;
  const writes = [];
  const readable = new ReadableStream({ start(value) { controller = value; if (bootReady) queueMicrotask(() => controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, type: 'ready', firmware: 'boot', ledCount: 116 }) + '\n'))); } });
  const writable = new WritableStream({ write(chunk) {
    const message = JSON.parse(new TextDecoder().decode(chunk)); writes.push(message);
    if (message.type === 'hello') { helloCount++; if (ignoreFirstHello && helloCount === 1) return; controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, type: 'ready', requestId: message.requestId, firmware: 'test', ledCount: 116 }) + '\n')); }
    if (message.type === 'set_outputs') { outputCount++; if (ignoreOutput || retryOutput && outputCount === 1) return; if (holdOutputAck && outputCount === 1) { heldOutput = message; return; } if (malformedOutputAck && outputCount === 1) { controller.enqueue(new TextEncoder().encode('{bad-json\n')); return; } controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, type: 'ack', requestId: message.requestId, appliedRevision: message.revision }) + '\n')); }
    if (message.type === 'buzz_once') { buzzCount++; if (retryBuzz && buzzCount === 1) return; controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, type: 'ack', requestId: message.requestId, appliedRevision: outputCount }) + '\n')); }
    if (message.type === 'keepalive') controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, type: 'ack', requestId: message.requestId, appliedRevision: 0 }) + '\n'));
  } });
  return { port: { readable, writable, async open() {}, async close() { controller.close(); } }, writes, feed(line) { controller.enqueue(new TextEncoder().encode(line + '\n')); }, acknowledgeOutput() { if (!heldOutput) return; controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 3, type: 'ack', requestId: heldOutput.requestId, appliedRevision: heldOutput.revision }) + '\n')); heldOutput = undefined; }, get helloCount() { return helloCount; } };
}

test('handshake retries a missed boot message and malformed input remains recoverable', async () => {
  const fake = fakePort({ ignoreFirstHello: true });
  const api = { async requestPort() { return fake.port; }, async getPorts() { return [fake.port]; } };
  const serial = new serialModule.ArduinoSerial(api);
  await serial.connect();
  assert.equal(serial.status.state, 'connected');
  assert.ok(fake.helloCount >= 2);
  fake.feed('{not-json');
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
  first.feed(JSON.stringify({ version: 3, type: 'ready', firmware: 'test-reset', ledCount: 116 }));
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
