import { registerSW } from 'virtual:pwa-register';
import { ArduinoSerial, type ControllerPreset, type DeviceMessage, type DeviceStatusMessage, type SerialStatus, type TimerCommand } from './serial';
import './style.css';

type Stage = { name: string; threshold: number; color: string; buzzer: 'none' | 'once' | 'repeat' };
type Preset = ControllerPreset & { id: string; updatedAt: string };

const STORAGE_KEY = 'timelight-presets-v1';
const colors = ['#56a9ff', '#ffd166', '#ff914b', '#ff6678', '#b58cff'];
const defaultStages: Stage[] = [
  { name: 'Beginning', threshold: 0, color: '#56a9ff', buzzer: 'none' },
  { name: 'Approaching', threshold: 60, color: '#ffd166', buzzer: 'once' },
  { name: 'Nearing limit', threshold: 120, color: '#ff914b', buzzer: 'once' },
  { name: 'Time reached', threshold: 180, color: '#ff6678', buzzer: 'repeat' },
];

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('TimeLight app root was not found.');
const app = appRoot;
const serial = new ArduinoSerial();

function loadPresets(): Preset[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Preset[]; } catch { return []; }
}
function persist(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)); }
function formatTime(seconds: number): string { const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0)); return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`; }
function toSeconds(value: string): number { const parts = value.trim().split(':'); if (!value.trim() || parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) return Number.NaN; if (parts.length === 1) return Number(parts[0]); const seconds = Number(parts[1]); return seconds > 59 ? Number.NaN : Number(parts[0]) * 60 + seconds; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character)); }

const starter: Preset = { id: crypto.randomUUID(), name: 'Four-minute speech', speaker: 'Speaker name', duration: 240, stages: structuredClone(defaultStages), updatedAt: new Date().toISOString() };
let presets: Preset[] = loadPresets();
let current: Preset = structuredClone(presets[0] ?? starter);
let saved = Boolean(presets.length);
let runtime: DeviceStatusMessage = { type: 'status', state: 'idle', elapsed: 0, stage: 0 };
let timerInterval: number | undefined;
let localTimerRunning = false;
let localTimerStartedAt = 0;
let localTimerElapsed = 0;

function stageMarkup(stage: Stage, index: number): string {
  return `<article class="stage-row" data-index="${index}" style="--stage-color:${stage.color}">
    <span class="stage-number">${String(index + 1).padStart(2, '0')}</span><span class="stage-color" aria-hidden="true"></span>
    <div class="stage-fields"><label>Stage name<input data-field="name" value="${escapeHtml(stage.name)}" maxlength="32" /></label><label>Starts at<input class="time-input" data-field="threshold" type="text" inputmode="numeric" maxlength="6" value="${formatTime(stage.threshold)}" /></label><label>Light color<div class="color-picker"><input data-field="color" type="color" value="${stage.color}" /><span>${stage.color}</span></div></label><label>Buzzer<select data-field="buzzer"><option value="none" ${stage.buzzer === 'none' ? 'selected' : ''}>No sound</option><option value="once" ${stage.buzzer === 'once' ? 'selected' : ''}>Chime once</option><option value="repeat" ${stage.buzzer === 'repeat' ? 'selected' : ''}>Repeat alert</option></select></label></div>
    <div class="stage-actions"><button type="button" class="icon-button move-up" title="Move stage up" ${index === 0 ? 'disabled' : ''}>&uarr;</button><button type="button" class="icon-button move-down" title="Move stage down" ${index === current.stages.length - 1 ? 'disabled' : ''}>&darr;</button><button type="button" class="icon-button remove-stage" title="Remove stage" ${current.stages.length <= 3 ? 'disabled' : ''}>&times;</button></div>
  </article>`;
}

function deviceStatusMarkup(): string {
  const status = serial.status; const connected = status.state === 'connected';
  return `<div class="controller-strip"><span class="device-badge ${status.state}" id="device-badge"><i></i><span id="device-state">${escapeHtml(status.message)}</span></span><span id="device-detail">${status.firmware ? `Firmware ${escapeHtml(status.firmware)}` : 'Optional USB controller'}</span><button type="button" class="text-button" id="device-connect" ${status.state === 'connecting' || status.state === 'unsupported' ? 'disabled' : ''}>${connected ? 'Disconnect' : 'Connect controller'}</button><button type="button" class="text-button send-config" id="send-config" ${connected ? '' : 'disabled'}>Send preset</button></div>`;
}

function render(): void {
  const name = current.name || 'Untitled preset';
  app.innerHTML = `<div class="page-shell"><header class="topbar"><a class="brand" href="/timelight/" aria-label="TimeLight home"><span class="brand-mark"><span class="lamp lamp-blue"></span><span class="lamp lamp-yellow"></span><span class="lamp lamp-red"></span></span><span>TimeLight</span></a><div class="topbar-right"><span class="version">v${__APP_VERSION__}</span><span class="status-pill"><i></i><span id="connection-status">${navigator.onLine ? 'Online' : 'Offline · Running from the cached shell'}</span></span></div></header>
  <main class="wireframe-flow"><section class="wireframe-card editor-card" aria-labelledby="editor-title"><header class="wireframe-toolbar"><div class="preset-control"><span class="toolbar-kicker">Preset</span><input id="preset-name" required maxlength="48" value="${escapeHtml(current.name)}" placeholder="Preset name" aria-label="Preset name" /></div><div class="toolbar-actions"><button type="button" class="toolbar-button" id="new-preset">+ New</button><button type="button" class="toolbar-button" id="duplicate-preset">Duplicate</button><button type="button" class="toolbar-button play-button" id="play-preset">Play <span>&rarr;</span></button><button type="button" class="toolbar-button danger-button" id="delete-preset" ${presets.some((preset) => preset.id === current.id) ? '' : 'hidden'}>Delete</button></div></header>
  <div class="saved-presets" aria-label="Saved presets">${presets.length ? `<span>Saved presets</span>${presets.map((preset) => `<button type="button" class="saved-preset ${preset.id === current.id ? 'active' : ''}" data-preset="${preset.id}">${escapeHtml(preset.name)}</button>`).join('')}` : '<span>No saved presets yet · changes stay on this screen until saved</span>'}</div>
  <div class="overview-canvas"><div class="canvas-label">Preset overview <span>/ edit inputs</span></div><div class="overview-layout"><div class="overview-summary"><div class="signal-line"><span class="pulse"></span> Timing sequence</div><h1 id="editor-title">Make time <em>visible.</em></h1><p>Shape how the light moves through your next event.</p><div class="overview-fields"><label>Speaker <span class="optional">optional</span><input id="speaker" maxlength="48" value="${escapeHtml(current.speaker)}" placeholder="Who is speaking?" /></label><label>Total duration<input id="duration" class="time-input" required type="text" inputmode="numeric" maxlength="6" value="${formatTime(current.duration)}" /></label></div></div><div class="stage-overview"><div class="stage-overview-heading"><span>Stages</span><strong id="stage-count">${current.stages.length} of 5</strong></div><div class="stage-list" id="stage-list">${current.stages.map(stageMarkup).join('')}</div><button type="button" class="add-stage" id="add-stage" ${current.stages.length >= 5 ? 'disabled' : ''}>+ Add stage</button></div></div></div>
  <footer class="editor-footer"><div class="save-state ${saved ? '' : 'unsaved'}" id="save-state"><span></span>${saved ? 'Saved locally' : 'Not saved yet'}</div><div><button type="button" class="secondary-button" id="reset-form">Revert</button><button type="button" class="primary-button" id="save-preset">Save preset <span>&rarr;</span></button></div></footer></section>
  <div class="flow-transition"><div class="flow-arrow" aria-hidden="true"></div><span>On clicking play</span></div>
  <section class="wireframe-card live-card" id="timer-panel" aria-labelledby="live-title"><header class="live-header"><button type="button" class="back-button" id="back-to-editor">&larr; back</button><div><span class="live-kicker">Live preset</span><h2 id="live-title">${escapeHtml(name)}</h2></div><span class="live-state" id="live-state">Ready</span></header><div class="live-layout"><div class="control-zone"><span class="zone-label">Controls</span><button type="button" class="big-control" id="local-play"><span>&#9654;</span><b>Play</b><small>start timer</small></button><div class="small-controls"><button type="button" class="secondary-button" id="local-pause">Pause</button><button type="button" class="secondary-button" id="local-reset">Reset</button></div><div class="controller-zone">${deviceStatusMarkup()}<div class="device-actions"><button type="button" class="device-command" data-command="start" ${serial.status.state === 'connected' ? '' : 'disabled'}>Start hardware</button><button type="button" class="device-command" data-command="pause" ${serial.status.state === 'connected' ? '' : 'disabled'}>Pause hardware</button></div></div></div><div class="timer-zone"><div class="timer-display"><span id="timer-value">${formatTime(localTimerElapsed)}</span><small>elapsed time</small></div><div class="progress-track"><span id="timer-progress"></span></div><div class="stage-progress" id="stage-progress">${current.stages.map((stage, index) => `<div class="stage-progress-item ${index === 0 ? 'active' : ''}" data-progress-index="${index}"><span style="--stage-color:${stage.color}"></span><b>${escapeHtml(stage.name)}</b><small>${formatTime(stage.threshold)}</small></div>`).join('')}</div><div class="timer-note">Overview: timer, stages, etc.</div></div></div></section></main><footer class="footer">Designed to stay useful when the network does.</footer></div>`;
  bindEvents(); updateTimerUi();
}

function syncCurrentFromForm(): void {
  const value = (selector: string) => document.querySelector<HTMLInputElement>(selector)?.value;
  current.name = value('#preset-name') ?? current.name; current.speaker = value('#speaker') ?? current.speaker; current.duration = toSeconds(value('#duration') ?? '');
  document.querySelectorAll<HTMLElement>('.stage-row').forEach((row, index) => { const get = (field: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`); const stage = current.stages[index]; if (!stage) return; stage.name = get('name')?.value ?? stage.name; stage.threshold = toSeconds(get('threshold')?.value ?? ''); stage.color = get('color')?.value ?? stage.color; stage.buzzer = (get('buzzer')?.value ?? stage.buzzer) as Stage['buzzer']; });
}
function validCurrent(): boolean { return Boolean(current.name.trim()) && Number.isFinite(current.duration) && current.duration >= 1 && current.stages.every((stage, index) => Number.isFinite(stage.threshold) && stage.threshold >= 0 && stage.threshold < current.duration && (index === 0 || stage.threshold > current.stages[index - 1].threshold)); }
function showInvalid(): void { document.querySelector('.overview-canvas')?.classList.add('invalid'); window.setTimeout(() => document.querySelector('.overview-canvas')?.classList.remove('invalid'), 1200); }
function savePreset(): void { syncCurrentFromForm(); if (!validCurrent()) { showInvalid(); return; } current.updatedAt = new Date().toISOString(); const existing = presets.findIndex((preset) => preset.id === current.id); if (existing >= 0) presets[existing] = structuredClone(current); else presets.unshift(structuredClone(current)); persist(); saved = true; render(); if (serial.status.state === 'connected') void sendConfiguration(); }
async function sendConfiguration(): Promise<void> { syncCurrentFromForm(); if (!validCurrent()) { showInvalid(); return; } try { await serial.sendConfiguration(current); } catch (error) { const detail = document.querySelector('#device-detail'); if (detail) detail.textContent = error instanceof Error ? error.message : 'Could not send the preset'; } }
async function handleDeviceCommand(command: TimerCommand): Promise<void> { try { await serial.sendTimerCommand(command); } catch (error) { const detail = document.querySelector('#device-detail'); if (detail) detail.textContent = error instanceof Error ? error.message : 'Could not send timer command'; } }

function updateTimerUi(): void {
  const elapsed = localTimerRunning ? localTimerElapsed + (Date.now() - localTimerStartedAt) / 1000 : localTimerElapsed;
  if (localTimerRunning && Number.isFinite(current.duration) && elapsed >= current.duration) {
    localTimerElapsed = current.duration; localTimerRunning = false;
    if (timerInterval) window.clearInterval(timerInterval); timerInterval = undefined;
  }
  const safeElapsed = Math.min(current.duration || 0, localTimerRunning ? elapsed : localTimerElapsed);
  const timerValue = document.querySelector('#timer-value'); const progress = document.querySelector<HTMLElement>('#timer-progress'); if (timerValue) timerValue.textContent = formatTime(safeElapsed); if (progress) progress.style.width = `${current.duration > 0 ? Math.min(100, safeElapsed / current.duration * 100) : 0}%`;
  const stageIndex = current.stages.reduce((active, stage, index) => safeElapsed >= stage.threshold ? index : active, 0); document.querySelectorAll<HTMLElement>('[data-progress-index]').forEach((item, index) => item.classList.toggle('active', index === stageIndex)); const state = document.querySelector('#live-state'); if (state) state.textContent = localTimerRunning ? 'Running' : safeElapsed >= current.duration && current.duration > 0 ? 'Complete' : safeElapsed > 0 ? 'Paused' : 'Ready';
}
function startLocalTimer(): void { if (localTimerRunning) return; localTimerStartedAt = Date.now(); localTimerRunning = true; timerInterval = window.setInterval(updateTimerUi, 250); updateTimerUi(); }
function pauseLocalTimer(): void { if (!localTimerRunning) return; localTimerElapsed += (Date.now() - localTimerStartedAt) / 1000; localTimerRunning = false; if (timerInterval) window.clearInterval(timerInterval); timerInterval = undefined; updateTimerUi(); }
function resetLocalTimer(): void { localTimerRunning = false; localTimerElapsed = 0; if (timerInterval) window.clearInterval(timerInterval); timerInterval = undefined; updateTimerUi(); }

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => button.addEventListener('click', () => { current = structuredClone(presets.find((preset) => preset.id === button.dataset.preset) ?? starter); saved = true; resetLocalTimer(); render(); }));
  document.querySelector('#new-preset')?.addEventListener('click', () => { current = { id: crypto.randomUUID(), name: '', speaker: '', duration: 240, stages: structuredClone(defaultStages), updatedAt: '' }; saved = false; resetLocalTimer(); render(); document.querySelector<HTMLInputElement>('#preset-name')?.focus(); });
  document.querySelector('#duplicate-preset')?.addEventListener('click', () => { syncCurrentFromForm(); current = { ...structuredClone(current), id: crypto.randomUUID(), name: `${current.name || 'Untitled preset'} copy`, updatedAt: '' }; saved = false; render(); document.querySelector<HTMLInputElement>('#preset-name')?.focus(); });
  document.querySelector('#play-preset')?.addEventListener('click', () => { syncCurrentFromForm(); document.querySelector('#timer-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); startLocalTimer(); if (serial.status.state === 'connected') void handleDeviceCommand('start'); });
  document.querySelector('#back-to-editor')?.addEventListener('click', () => document.querySelector('.editor-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  document.querySelector('#save-preset')?.addEventListener('click', savePreset);
  document.querySelector('#reset-form')?.addEventListener('click', () => { current = structuredClone(presets.find((preset) => preset.id === current.id) ?? starter); saved = presets.some((preset) => preset.id === current.id); render(); });
  document.querySelector('#delete-preset')?.addEventListener('click', () => { presets = presets.filter((preset) => preset.id !== current.id); persist(); current = structuredClone(presets[0] ?? starter); saved = presets.length > 0; render(); });
  document.querySelector('#add-stage')?.addEventListener('click', () => { syncCurrentFromForm(); current.stages.push({ name: 'New stage', threshold: (current.stages[current.stages.length - 1]?.threshold || 0) + 60, color: colors[current.stages.length], buzzer: 'once' }); render(); });
  document.querySelector('#stage-list')?.addEventListener('click', (event) => { const action = (event.target as HTMLElement).closest<HTMLButtonElement>('.stage-actions button'); const row = action?.closest<HTMLElement>('.stage-row'); if (!action || !row) return; syncCurrentFromForm(); const index = Number(row.dataset.index); if (action.classList.contains('move-up')) [current.stages[index - 1], current.stages[index]] = [current.stages[index], current.stages[index - 1]]; if (action.classList.contains('move-down')) [current.stages[index], current.stages[index + 1]] = [current.stages[index + 1], current.stages[index]]; if (action.classList.contains('remove-stage')) current.stages.splice(index, 1); saved = false; render(); });
  document.querySelector('#stage-list')?.addEventListener('input', (event) => { const input = event.target as HTMLInputElement; if (input.dataset.field === 'color') { input.closest<HTMLElement>('.stage-row')?.style.setProperty('--stage-color', input.value); const label = input.parentElement?.querySelector('span'); if (label) label.textContent = input.value; } });
  document.querySelector('#local-play')?.addEventListener('click', () => { startLocalTimer(); if (serial.status.state === 'connected') void handleDeviceCommand('start'); }); document.querySelector('#local-pause')?.addEventListener('click', () => { pauseLocalTimer(); if (serial.status.state === 'connected') void handleDeviceCommand('pause'); }); document.querySelector('#local-reset')?.addEventListener('click', () => { resetLocalTimer(); if (serial.status.state === 'connected') void handleDeviceCommand('reset'); });
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => button.addEventListener('click', () => void handleDeviceCommand(button.dataset.command as TimerCommand))); document.querySelector('#send-config')?.addEventListener('click', () => void sendConfiguration());
  document.querySelector('#device-connect')?.addEventListener('click', async () => { const button = document.querySelector<HTMLButtonElement>('#device-connect'); if (serial.status.state === 'connected') { await serial.disconnect(); return; } if (button) button.disabled = true; try { await serial.connect(); await sendConfiguration(); } catch { /* status listener provides the reason */ } finally { updateDeviceUi(serial.status); } });
}

function updateDeviceUi(status: SerialStatus): void { const badge = document.querySelector('#device-badge'); const state = document.querySelector('#device-state'); const connect = document.querySelector<HTMLButtonElement>('#device-connect'); const detail = document.querySelector('#device-detail'); if (!badge || !state || !connect) return; badge.className = `device-badge ${status.state}`; state.textContent = status.message; if (status.firmware && detail) detail.textContent = `Firmware ${status.firmware}`; connect.disabled = status.state === 'connecting' || status.state === 'unsupported'; connect.textContent = status.state === 'connected' ? 'Disconnect' : 'Connect controller'; document.querySelectorAll<HTMLButtonElement>('[data-command], #send-config').forEach((button) => { button.disabled = status.state !== 'connected'; }); }
function updateRuntime(message: DeviceMessage): void { if (message.type !== 'status') return; runtime = message as DeviceStatusMessage; if (serial.status.state === 'connected' && !localTimerRunning) { localTimerElapsed = runtime.elapsed ?? 0; updateTimerUi(); } }
function updateConnectionStatus(): void { const online = navigator.onLine; const status = document.querySelector('#connection-status'); if (status) status.textContent = online ? 'Online' : 'Offline · Running from the cached shell'; document.querySelector('.status-pill')?.classList.toggle('offline', !online); }

serial.onStatus(updateDeviceUi); serial.onMessage(updateRuntime); render(); window.addEventListener('online', updateConnectionStatus); window.addEventListener('offline', updateConnectionStatus); registerSW({ immediate: true, onOfflineReady: updateConnectionStatus, onNeedRefresh: () => { document.body.dataset.updateWaiting = 'true'; } });
