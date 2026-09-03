import { registerSW } from 'virtual:pwa-register';
import './style.css';

type Stage = { name: string; threshold: number; color: string; buzzer: 'none' | 'once' | 'repeat' };
type Preset = { id: string; name: string; speaker: string; duration: number; stages: Stage[]; updatedAt: string };

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

function loadPresets(): Preset[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Preset[]; } catch { return []; } }
function persist(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)); }
function formatTime(seconds: number): string { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function toSeconds(value: string): number { const parts = value.split(':'); const minutes = Number(parts[0]); const seconds = Number(parts[1] ?? 0); return (minutes || 0) * 60 + (seconds || 0); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character)); }

const starter: Preset = { id: crypto.randomUUID(), name: 'Four-minute speech', speaker: 'Speaker name', duration: 240, stages: structuredClone(defaultStages), updatedAt: new Date().toISOString() };
let presets: Preset[] = loadPresets();
let current: Preset = structuredClone(presets[0] ?? starter);
let saved = Boolean(presets.length);

function stageMarkup(stage: Stage, index: number): string {
  return `<article class="stage-card" data-index="${index}" style="--stage-color:${stage.color}">
    <div class="stage-number">${String(index + 1).padStart(2, '0')}</div><div class="stage-color" aria-hidden="true"></div>
    <div class="stage-fields"><label>Stage name<input data-field="name" value="${escapeHtml(stage.name)}" maxlength="32" /></label><label>Starts at<input data-field="threshold" type="time" step="1" value="${formatTime(stage.threshold)}" /></label><label>Light color<div class="color-picker"><input data-field="color" type="color" value="${stage.color}" /><span>${stage.color}</span></div></label><label>Buzzer<select data-field="buzzer"><option value="none" ${stage.buzzer === 'none' ? 'selected' : ''}>No sound</option><option value="once" ${stage.buzzer === 'once' ? 'selected' : ''}>Chime once</option><option value="repeat" ${stage.buzzer === 'repeat' ? 'selected' : ''}>Repeat alert</option></select></label></div>
    <div class="stage-actions"><button class="icon-button move-up" title="Move stage up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button move-down" title="Move stage down" ${index === current.stages.length - 1 ? 'disabled' : ''}>↓</button><button class="icon-button remove-stage" title="Remove stage" ${current.stages.length <= 3 ? 'disabled' : ''}>×</button></div>
  </article>`;
}

function render(): void {
  app.innerHTML = `<div class="page-shell"><header class="topbar"><a class="brand" href="/timelight/" aria-label="TimeLight home"><span class="brand-mark"><span class="lamp lamp-blue"></span><span class="lamp lamp-yellow"></span><span class="lamp lamp-red"></span></span><span>TimeLight</span></a><div class="topbar-right"><span class="version">v${__APP_VERSION__}</span><span class="status-pill"><i></i><span id="connection-status">${navigator.onLine ? 'Online' : 'Offline'}</span></span></div></header>
    <main class="workspace"><aside class="sidebar"><div class="section-label">Your presets</div><button class="new-preset" id="new-preset"><span>＋</span> New preset</button><div class="preset-list">${presets.length ? presets.map((preset) => `<button class="preset-item ${preset.id === current.id ? 'active' : ''}" data-preset="${preset.id}"><span class="preset-light" style="--stage-color:${preset.stages[0].color}"></span><span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.speaker || 'No speaker')}</small></span><b>›</b></button>`).join('') : '<p class="empty-note">Your saved presets will appear here.</p>'}</div><div class="sidebar-foot">Stored locally on this device<br /><span>Works offline after installation</span></div></aside>
    <section class="editor" aria-labelledby="editor-title"><div class="editor-heading"><div><div class="eyebrow"><span class="pulse"></span> Preset builder</div><h1 id="editor-title">Set the <em>moment.</em></h1><p>Shape how the light moves through your next event.</p></div><div class="save-state ${saved ? '' : 'unsaved'}" id="save-state"><span></span>${saved ? 'Saved locally' : 'Not saved yet'}</div></div>
    <form id="preset-form" novalidate><section class="panel basics"><div class="panel-heading"><div><span class="step">01</span><div><h2>Preset details</h2><p>Name this timing sequence and set its total run time.</p></div></div></div><div class="basic-grid"><label>Preset name<input id="preset-name" required maxlength="48" value="${escapeHtml(current.name)}" placeholder="e.g. Debate opening" /></label><label>Speaker <span class="optional">optional</span><input id="speaker" maxlength="48" value="${escapeHtml(current.speaker)}" placeholder="Who is speaking?" /></label><label>Total duration<input id="duration" required type="time" step="1" value="${formatTime(current.duration)}" /></label></div></section>
    <section class="panel stages-panel"><div class="panel-heading"><div><span class="step">02</span><div><h2>Timing stages</h2><p>Stages activate in order as the timer counts up.</p></div></div><span class="stage-count" id="stage-count">${current.stages.length} of 5</span></div><div class="stage-list" id="stage-list">${current.stages.map(stageMarkup).join('')}</div><button type="button" class="add-stage" id="add-stage" ${current.stages.length >= 5 ? 'disabled' : ''}>＋ Add stage</button></section>
    <div class="form-footer"><button type="button" class="delete-button" id="delete-preset" ${presets.some((p) => p.id === current.id) ? '' : 'hidden'}>Delete preset</button><div><button type="button" class="secondary-button" id="reset-form">Reset changes</button><button class="primary-button" type="submit">Save preset <span>↗</span></button></div></div></form></section></main><footer class="footer">Designed to stay useful when the network does.</footer></div>`;
  bindEvents();
}

function syncCurrentFromForm(): void {
  const name = document.querySelector<HTMLInputElement>('#preset-name'); const speaker = document.querySelector<HTMLInputElement>('#speaker'); const duration = document.querySelector<HTMLInputElement>('#duration');
  if (name) current.name = name.value; if (speaker) current.speaker = speaker.value; if (duration) current.duration = toSeconds(duration.value);
  document.querySelectorAll<HTMLElement>('.stage-card').forEach((card, index) => { const get = (field: string) => card.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`); const stage = current.stages[index]; stage.name = get('name')?.value ?? stage.name; stage.threshold = toSeconds(get('threshold')?.value ?? '0:00'); stage.color = get('color')?.value ?? stage.color; stage.buzzer = (get('buzzer')?.value ?? stage.buzzer) as Stage['buzzer']; });
}
function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => button.addEventListener('click', () => { current = structuredClone(presets.find((p) => p.id === button.dataset.preset) ?? starter); saved = true; render(); }));
  document.querySelector('#new-preset')?.addEventListener('click', () => { current = { id: crypto.randomUUID(), name: '', speaker: '', duration: 240, stages: structuredClone(defaultStages), updatedAt: '' }; saved = false; render(); document.querySelector<HTMLInputElement>('#preset-name')?.focus(); });
  document.querySelector('#add-stage')?.addEventListener('click', () => { syncCurrentFromForm(); current.stages.push({ name: 'New stage', threshold: current.stages[current.stages.length - 1].threshold + 60, color: colors[current.stages.length], buzzer: 'once' }); render(); });
  document.querySelector('#stage-list')?.addEventListener('click', (event) => { const target = event.target as HTMLElement; const card = target.closest<HTMLElement>('.stage-card'); if (!card) return; syncCurrentFromForm(); const index = Number(card.dataset.index); if (target.closest('.move-up')) [current.stages[index - 1], current.stages[index]] = [current.stages[index], current.stages[index - 1]]; if (target.closest('.move-down')) [current.stages[index], current.stages[index + 1]] = [current.stages[index + 1], current.stages[index]]; if (target.closest('.remove-stage')) current.stages.splice(index, 1); render(); });
  document.querySelector('#stage-list')?.addEventListener('input', (event) => { const input = event.target as HTMLInputElement; if (input.dataset.field === 'color') { const picker = input.parentElement?.querySelector('span'); if (picker) picker.textContent = input.value; input.closest<HTMLElement>('.stage-card')?.style.setProperty('--stage-color', input.value); } });
  document.querySelector('#reset-form')?.addEventListener('click', () => { current = structuredClone(presets.find((p) => p.id === current.id) ?? starter); saved = presets.some((p) => p.id === current.id); render(); });
  document.querySelector('#delete-preset')?.addEventListener('click', () => { presets = presets.filter((p) => p.id !== current.id); persist(); current = structuredClone(presets[0] ?? starter); saved = presets.length > 0; render(); });
  document.querySelector('#preset-form')?.addEventListener('submit', (event) => { event.preventDefault(); syncCurrentFromForm(); if (!current.name.trim()) { document.querySelector<HTMLInputElement>('#preset-name')?.focus(); return; } if (current.duration < 1 || current.stages.some((stage, index) => stage.threshold < 0 || stage.threshold >= current.duration || (index > 0 && stage.threshold <= current.stages[index - 1].threshold))) { document.querySelector('.stages-panel')?.classList.add('invalid'); setTimeout(() => document.querySelector('.stages-panel')?.classList.remove('invalid'), 1200); return; } current.updatedAt = new Date().toISOString(); const existing = presets.findIndex((p) => p.id === current.id); if (existing >= 0) presets[existing] = structuredClone(current); else presets.unshift(structuredClone(current)); persist(); saved = true; render(); });
}
function updateConnectionStatus(): void { const online = navigator.onLine; const status = document.querySelector('#connection-status'); if (status) status.textContent = online ? 'Online' : 'Offline · Cached shell'; document.querySelector('.status-pill')?.classList.toggle('offline', !online); }

render(); window.addEventListener('online', updateConnectionStatus); window.addEventListener('offline', updateConnectionStatus);
registerSW({ immediate: true, onOfflineReady: updateConnectionStatus, onNeedRefresh: () => { document.body.dataset.updateWaiting = 'true'; } });
