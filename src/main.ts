import { registerSW } from 'virtual:pwa-register';
import { ArduinoSerial, type DeviceMessage, type SerialStatus } from './serial';
import { allottedTime, deriveOutputs, elapsedSeconds, effectiveStage, isGraceStage, persistableTimerRun, recoverTimerRun, reduceTimer, type PresetSnapshot, type Stage, type TimerAction, type TimerClock, type TimerRun } from './timer';
import { LiveTranscription } from './live-transcription';
import './style.css';

type Preset = PresetSnapshot & { id: string; updatedAt: string };
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}
const STORAGE_KEY = 'timelight-presets-v1';
const RUN_STORAGE_KEY = 'timelight-active-run-v2';
const HISTORY_STORAGE_KEY = 'timelight-history-v1';
type HistoryEntry = { id: string; presetTitle: string; speaker: string; club: string; duration: number; allottedTime?: number; stoppedAt: number; startedAt?: number; savedAt: string; variance: number; result: string; resultColor?: string };
const MAX_STAGES = 7;
const colors = ['#0000ff', '#ffff00', '#ff7b00', '#ff0000', '#b58cff', '#00c2a8', '#ff4fa3'];
const presetIcons = {
  new: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>',
  duplicate: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="3.5" width="9" height="10" rx="1.5" /><path d="M4.5 6.5v9a1 1 0 0 0 1 1h7" /></svg>',
  save: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h10.5L16.5 5v11.5H4z" /><path d="M7 3.5v5h6v-5M7 16.5v-4h6v4" /></svg>',
  revert: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 6.5H3.5V3.5M3.8 6.2A6.5 6.5 0 1 1 4 13" /></svg>',
  send: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4l14 6-14 6 2-6zM5 10h7" /></svg>',
  delete: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 3.5h4l1 2.5H7zM6 6l.6 10.5h6.8L14 6M8.5 8.5v5.5M11.5 8.5v5.5" /></svg>',
  history: '<svg class="toolbar-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.2 6.2V3.5M4.2 3.5h2.7M4.4 4.1A7 7 0 1 1 3 11"/><path d="M10 6v4.3l3 1.7"/></svg>',
} as const;
const controllerConnectIcon = '<svg class="toolbar-icon controller-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3.5v4M13 3.5v4M5.5 7.5h9v4a4 4 0 0 1-8 0zM10 15.5v2M7.5 17.5h5" /></svg>';
const defaultStages: Stage[] = [
  { name: 'Grace period', threshold: 0, color: '#0000ff', blink: false, grace: true, buzzer: 'once' },
  { name: 'Speech start', threshold: 15, color: '#00ff00', blink: false, grace: false, buzzer: 'none' },
  { name: 'Speech halfway point', threshold: 30, color: '#ffff00', blink: false, grace: false, buzzer: 'none' },
  { name: 'Grace after', threshold: 45, color: '#ff6400', blink: true, grace: true, buzzer: 'once' },
  { name: 'FAIL', threshold: 60, color: '#ff0000', blink: false, grace: false, buzzer: 'none' },
];
const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('TimeLight app root was not found.');
const app = appRoot;
const serial = new ArduinoSerial();
const starter: Preset = { id: crypto.randomUUID(), name: 'One-minute speech', speaker: 'Speaker name', club: 'Club name', duration: 90, stages: structuredClone(defaultStages), updatedAt: new Date().toISOString() };

function loadPresets(): Preset[] { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(value) ? value.map((preset) => ({ ...preset, club: String(preset?.club ?? '') })) as Preset[] : []; } catch { return []; } }
function persistPresets(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)); }
function loadHistory(): HistoryEntry[] { try { const value = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? '[]'); return Array.isArray(value) ? value.map((item) => ({ ...item, club: String(item?.club ?? '') })) : []; } catch { return []; } }
function persistHistory(): void { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history)); }
function clock(): TimerClock { return { wallMs: Date.now(), monotonicMs: performance.now() }; }
function formatTime(seconds: number): string { const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0)); return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`; }
function formatVariance(seconds: number): string { return `${seconds < 0 ? '-' : ''}${formatTime(Math.abs(seconds))}`; }
function timeInputMarkup(seconds: number, index: number): string { const [minutes, remainder] = formatTime(seconds).split(':'); return `<div class="time-input" role="group" aria-label="Stage ${index + 1} start time"><input data-field="threshold-minutes" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" value="${minutes}" aria-label="Minutes" aria-description="Minutes" autocomplete="off" enterkeyhint="next" /><span class="time-separator" aria-hidden="true">:</span><input data-field="threshold-seconds" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" value="${remainder}" aria-label="Seconds" aria-description="Seconds, 0 to 59" autocomplete="off" enterkeyhint="done" /></div>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character)); }
function speakerName(preset: PresetSnapshot): string { return String(preset.speaker ?? '').trim() || 'Speaker name'; }
function clubName(preset: PresetSnapshot): string { return String(preset.club ?? '').trim() || 'Club name'; }
function presetOptionMarkup(preset: Preset, active: boolean): string { return `<button type="button" class="saved-preset ${active ? 'active' : ''}" data-preset="${preset.id}"><span class="preset-option-club">${escapeHtml(clubName(preset))}</span><span class="preset-option-speaker">${escapeHtml(speakerName(preset))}</span><span class="preset-option-name">${escapeHtml(preset.name || 'Untitled preset')}</span></button>`; }
function samePreset(a: PresetSnapshot, b: PresetSnapshot): boolean { return a.name === b.name && a.speaker === b.speaker && a.club === b.club && a.duration === b.duration && JSON.stringify(a.stages) === JSON.stringify(b.stages); }

let presets = loadPresets();
let history = loadHistory();
let historyOpen = false;
let historyToolsExpanded = true;
let historySearch = '';
let historyPreset = '';
let historySort: { key: 'startedAt' | 'presetTitle' | 'stoppedAt'; direction: 'asc' | 'desc' } = { key: 'startedAt', direction: 'desc' };
let historyDateFrom = '';
let historyDateTo = '';
let historySearchRefreshTimer: number | undefined;
let current: Preset = structuredClone(presets[0] ?? starter);
let revertTarget: Preset = structuredClone(current);
// Keep this as the stage object, rather than its array index, so reordering a
// stage does not change which stage is expanded on narrow screens.
let expandedStage: Stage | null = current.stages[0] ?? null;
let saved = Boolean(presets.length);
let activeRun: TimerRun | null = (() => { try { return recoverTimerRun(JSON.parse(localStorage.getItem(RUN_STORAGE_KEY) ?? 'null'), clock()); } catch { return null; } })();
let liveViewOpen = Boolean(activeRun);
let timerInterval: number | undefined;
let outputRevision = 1;
let lastOutputs = deriveOutputs(null, clock());
let reconnectTimer: number | undefined;
let reconnectDelay = 250;
let manualDisconnect = false;
let lastButtonSequence = 0;
let wakeLock: { released: boolean; release(): Promise<void>; addEventListener(type: string, listener: () => void): void } | null = null;
let wakeLockWarning = false;
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let installPromptPending = false;
let shellReady = false;
const transcription = new LiveTranscription(() => {
  const run = activeRun;
  const preset = run?.preset ?? current;
  const seconds = run ? elapsedSeconds(run, clock()) : 0;
  const stageIndex = run ? effectiveStage(run, clock()) : 0;
  return { seconds, stage: structuredClone(preset.stages[stageIndex] ?? preset.stages[0] ?? defaultStages[0]) };
});

function persistRun(): void { if (activeRun) localStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(persistableTimerRun(activeRun))); else localStorage.removeItem(RUN_STORAGE_KEY); }
function standaloneLaunch(): boolean { return window.matchMedia('(display-mode: standalone)').matches; }
function connectionMessage(): string { return navigator.onLine ? 'Online' : 'Offline · Running from the cached shell'; }
function connectionBadgeMarkup(): string { const online = navigator.onLine; return `<div class="connection-badge ${online ? 'online' : 'offline'}" id="connection-badge" role="status" aria-live="polite" data-shell-ready="${shellReady}"><i aria-hidden="true"></i><span id="connection-state">${connectionMessage()}</span></div>`; }
function installActionMarkup(): string { const hidden = !deferredInstallPrompt || standaloneLaunch(); return `<button type="button" class="install-button" id="install-app" ${hidden ? 'hidden' : ''}>Install app</button>`; }
function stageMarkup(stage: Stage, index: number): string { const last = index === current.stages.length - 1; const isExpanded = expandedStage === stage; const grace = isGraceStage(stage); return `<article class="stage-row ${isExpanded ? 'is-expanded' : ''} ${last ? 'last-stage' : ''} ${grace ? 'is-grace' : ''}" data-index="${index}" style="--stage-color:${stage.color}"><div class="stage-main"><span class="stage-number">${String(index + 1).padStart(2, '0')}</span><span class="stage-color" aria-hidden="true"></span><div class="stage-fields" id="stage-fields-${index}"><label>Stage stop output<input data-field="name" value="${escapeHtml(stage.name)}" maxlength="64" /></label><label>Starts at${timeInputMarkup(stage.threshold, index)}</label><label class="grace-field"><span>Grace Period </span><input data-field="grace" type="checkbox" ${grace ? 'checked' : ''} /></label><label>Light color<div class="color-picker"><input data-field="color" type="color" value="${stage.color}" /><span>${stage.color}</span></div></label><label class="blink-field"><span>Blink </span><input data-field="blink" type="checkbox" ${stage.blink ? 'checked' : ''} /></label><label>Buzzer<select data-field="buzzer"><option value="none" ${stage.buzzer === 'none' ? 'selected' : ''}>No sound</option><option value="once" ${stage.buzzer === 'once' ? 'selected' : ''}>Chime once</option><option value="repeat" ${stage.buzzer === 'repeat' ? 'selected' : ''}>Repeat alert</option></select></label></div>${last ? `<div class="result-fields"><label>Over time result<input id="fail-result-output" maxlength="80" value="${escapeHtml(current.failResultOutput ?? 'Over time')}" /></label></div>` : ''}</div><div class="stage-summary"><button type="button" class="stage-toggle" data-stage-toggle aria-expanded="${isExpanded}" aria-controls="stage-fields-${index}"><span class="stage-chevron" aria-hidden="true">&#8964;</span><span class="stage-summary-index">Stage ${index + 1}</span><strong class="stage-summary-name">${escapeHtml(stage.name || 'Untitled stage')}</strong><span class="stage-summary-threshold">${formatTime(stage.threshold)}</span><span class="stage-summary-color" aria-label="Light color ${stage.color}" title="Light color ${stage.color}"></span></button></div><div class="stage-actions"><button type="button" class="stage-drag-handle" data-stage-drag aria-label="Reorder stage ${index + 1}" title="Drag to reorder" aria-keyshortcuts="ArrowUp ArrowDown Home End"><span aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span></button><button type="button" class="icon-button desktop-stage-action remove-stage" data-stage-action ${current.stages.length <= 3 ? 'disabled' : ''}>&times;</button><button type="button" class="icon-button stage-menu-toggle" data-stage-menu-toggle aria-label="Stage actions" aria-expanded="false">&#8942;</button><div class="stage-menu" hidden><button type="button" class="stage-menu-action remove-stage" data-stage-action ${current.stages.length <= 3 ? 'disabled' : ''}>Delete stage</button></div></div></article>`; }
function deviceStatusMarkup(): string { const status = serial.status; const connected = status.state === 'connected'; const label = connected ? 'Disconnect TimeLight' : 'Connect TimeLight'; return `<div class="controller-strip" id="controller-strip" aria-label="Arduino controller status"><span class="device-badge ${status.state}" id="device-badge"><i></i><span id="device-state">${escapeHtml(status.message)}</span></span><span id="device-detail" class="${status.warning ? 'is-error' : ''}">${status.firmware ? `Firmware ${escapeHtml(status.firmware)}` : ''}</span><button type="button" class="text-button controller-connect" id="device-connect" title="${label}" aria-label="${label}" ${status.state === 'connecting' || status.state === 'unsupported' ? 'disabled' : ''}>${controllerConnectIcon}</button></div>`; }

function displayedHistory(): HistoryEntry[] { const q = historySearch.trim().toLowerCase(); const from = historyDateFrom ? Date.parse(historyDateFrom) : -Infinity; const to = historyDateTo ? Date.parse(historyDateTo) : Infinity; return history.filter((item) => { const started = item.startedAt ?? Date.parse(item.savedAt); return (!q || item.presetTitle.toLowerCase().includes(q) || item.speaker.toLowerCase().includes(q) || item.club.toLowerCase().includes(q)) && (!historyPreset || item.presetTitle === historyPreset) && started >= from && started <= to; }).sort((a, b) => { const av = historySort.key === 'presetTitle' ? a.presetTitle.toLowerCase() : historySort.key === 'stoppedAt' ? a.stoppedAt : (a.startedAt ?? Date.parse(a.savedAt)); const bv = historySort.key === 'presetTitle' ? b.presetTitle.toLowerCase() : historySort.key === 'stoppedAt' ? b.stoppedAt : (b.startedAt ?? Date.parse(b.savedAt)); return (av < bv ? -1 : av > bv ? 1 : 0) * (historySort.direction === 'asc' ? 1 : -1); }); }
function historyRowsMarkup(rows = displayedHistory()): string { return rows.length ? rows.map((item) => `<tr><td>${escapeHtml(item.presetTitle)}</td><td>${escapeHtml(item.club || '—')}</td><td>${escapeHtml(item.speaker)}</td><td>${item.startedAt ? new Date(item.startedAt).toLocaleString() : '—'}</td><td>${formatTime(item.duration)}</td><td>${formatTime(item.allottedTime ?? item.duration)}</td><td>${formatTime(item.stoppedAt)}</td><td>${formatVariance(item.variance)}</td><td><span class="result-badge" style="--result-color:${/^#[0-9a-f]{6}$/i.test(item.resultColor ?? '') ? item.resultColor : '#71859e'}">${escapeHtml(item.result)}</span></td><td><button type="button" class="text-button history-delete" data-history-id="${item.id}">Delete</button></td></tr>`).join('') : '<tr><td colspan="10" class="history-empty">No matching timers.</td></tr>'; }
function historyModalMarkup(): string { const presetsInHistory = [...new Set(history.map((item) => item.presetTitle))].sort(); const arrow = (key: typeof historySort.key) => historySort.key === key ? (historySort.direction === 'asc' ? ' ▲' : ' ▼') : ''; return `<div class="history-overlay" id="history-overlay" ${historyOpen ? '' : 'hidden'}><section class="history-card" role="dialog" aria-modal="true" aria-labelledby="history-title"><header><div class="history-heading"><h2 id="history-title">Timer History</h2><button type="button" class="history-tools-toggle" id="history-tools-toggle" aria-expanded="${historyToolsExpanded}" aria-controls="history-tools"><span>Search</span><span class="history-tools-caret" aria-hidden="true">&#8964;</span></button><div class="history-tools" id="history-tools" ${historyToolsExpanded ? '' : 'hidden'}><div class="history-filters"><input id="history-search" type="search" placeholder="Search club, speaker, or preset title" aria-label="Search timer history" value="${escapeHtml(historySearch)}"><select id="history-preset" aria-label="Filter by preset"><option value="">All presets</option>${presetsInHistory.map((p) => `<option ${p === historyPreset ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')} </select><label>From <input id="history-date-from" type="datetime-local" value="${escapeHtml(historyDateFrom)}"></label><label>To <input id="history-date-to" type="datetime-local" value="${escapeHtml(historyDateTo)}"></label></div></div></div><button type="button" class="history-close" id="history-close" aria-label="Close history">&times;</button></header><div class="history-table-wrap"><table><thead><tr><th><button data-history-sort="presetTitle">Preset title${arrow('presetTitle')}</button></th><th>Club name</th><th>Speaker name</th><th><button data-history-sort="startedAt">Start date &amp; time${arrow('startedAt')}</button></th><th>Total duration</th><th>Allotted Time</th><th><button data-history-sort="stoppedAt">Stop time${arrow('stoppedAt')}</button></th><th>Time remaining</th><th>Result</th><th>Action</th></tr></thead><tbody>${historyRowsMarkup()}</tbody></table></div><footer><span>${displayedHistory().length} of ${history.length} entries</span><button type="button" class="secondary-button" id="export-history" ${displayedHistory().length ? '' : 'disabled'}>Export CSV</button></footer></section></div>`; }
function refreshHistoryContents(): void { const rows = displayedHistory(); const tbody = document.querySelector<HTMLTableSectionElement>('#history-overlay tbody'); if (tbody) tbody.innerHTML = historyRowsMarkup(rows); const footer = document.querySelector<HTMLElement>('#history-overlay footer'); if (footer) footer.innerHTML = `<span>${rows.length} of ${history.length} entries</span><button type="button" class="secondary-button" id="export-history" ${rows.length ? '' : 'disabled'}>Export CSV</button>`; }

function render(): void {
  const timerPreset = activeRun?.preset ?? current; const name = timerPreset.name || 'Untitled preset'; const speaker = speakerName(timerPreset); const club = clubName(timerPreset);
  const timelineEnd = Math.max(1, timerPreset.stages[timerPreset.stages.length - 1]?.threshold ?? 0);
  app.innerHTML = `<div class="page-shell"><header class="topbar"><div class="title-block"><a class="brand" href="/timelight/" aria-label="TimeLight home"><span class="brand-mark"><span class="lamp lamp-blue"></span><span class="lamp lamp-yellow"></span><span class="lamp lamp-red"></span></span><span>TimeLight</span></a><div class="topbar-actions">${connectionBadgeMarkup()}${installActionMarkup()}${deviceStatusMarkup()}</div></div></header><main class="wireframe-flow"><section class="wireframe-card editor-card" aria-label="Preset editor"><header class="wireframe-toolbar"><div class="preset-control"><div class="toolbar-actions preset-actions"><button type="button" class="toolbar-button icon-toolbar-button" id="new-preset" title="New preset" aria-label="New preset">${presetIcons.new}</button><button type="button" class="toolbar-button icon-toolbar-button" id="duplicate-preset" title="Duplicate preset" aria-label="Duplicate preset">${presetIcons.duplicate}</button><button type="button" class="toolbar-button icon-toolbar-button revert-button" id="reset-form" title="Revert changes" aria-label="Revert changes" ${saved ? 'hidden' : ''}>${presetIcons.revert}</button><button type="button" class="toolbar-button icon-toolbar-button save-button" id="save-preset" title="Save preset" aria-label="Save preset" ${saved ? 'disabled' : ''}>${presetIcons.save}</button></div><div class="preset-picker"><div class="preset-input-wrap"><input id="preset-name" required maxlength="48" value="${escapeHtml(current.name)}" placeholder="Preset name" aria-label="Preset name" /><button type="button" class="preset-picker-toggle" id="preset-picker-toggle" aria-label="Show saved presets" aria-expanded="false">&#8964;</button></div><span class="preset-picker-meta"><span>${escapeHtml(clubName(current))}</span><span>${escapeHtml(speakerName(current))}</span></span><div class="preset-menu" id="preset-menu" hidden>${presets.length ? `<span class="preset-menu-label">Saved presets</span>${presets.map((preset) => presetOptionMarkup(preset, preset.id === current.id)).join('')}` : '<span class="preset-menu-empty">No saved presets yet</span>'}</div></div></div><div class="toolbar-actions"><button type="button" class="toolbar-button icon-toolbar-button danger-button" id="delete-preset" title="Delete preset" aria-label="Delete preset" ${presets.some((preset) => preset.id === current.id) ? '' : 'hidden'}>&times;</button></div></header><div class="overview-canvas"><div class="overview-layout"><div class="overview-summary"><div class="overview-fields"><label>Speaker name<input id="speaker" required maxlength="48" value="${escapeHtml(current.speaker)}" placeholder="Who is speaking?" /></label><label>Club name<input id="club" required maxlength="64" value="${escapeHtml(current.club)}" placeholder="Which club?" /></label><label>Total duration<input id="duration" class="time-input" required type="text" inputmode="numeric" maxlength="6" value="${formatTime(current.duration)}" /></label></div></div><div class="stage-overview"><div class="stage-overview-heading"><span>Stages</span><strong id="stage-count">${current.stages.length} of ${MAX_STAGES}</strong></div><div class="stage-list" id="stage-list">${current.stages.map(stageMarkup).join('')}</div><button type="button" class="add-stage" id="add-stage" ${current.stages.length >= MAX_STAGES ? 'disabled' : ''}>+ Add stage</button></div></div></div><footer class="editor-footer"><div class="footer-actions"><button type="button" class="primary-button" id="play-preset">${activeRun ? 'Open timer' : 'Start'} <span>&rarr;</span></button></div></footer></section></main><div class="live-overlay" id="live-overlay" ${liveViewOpen ? '' : 'hidden'}><section class="wireframe-card live-card" id="timer-panel" aria-labelledby="live-title" role="dialog" aria-modal="true"><header class="live-header"><button type="button" class="back-button" id="back-to-editor" aria-label="Back to editor">&larr;</button><div class="live-heading preset-picker timer-preset-picker" id="timer-preset-picker"><button type="button" class="timer-preset-toggle" id="timer-preset-toggle" aria-label="Show timer presets" aria-expanded="false"><span class="live-club" aria-label="Club">${escapeHtml(club)}</span><span class="live-speaker live-speaker-status" aria-label="Speaker">${escapeHtml(speaker)}</span><h2 id="live-title">${escapeHtml(name)}</h2><span class="timer-preset-chevron" aria-hidden="true">&#8964;</span></button><div class="preset-menu timer-preset-menu" id="timer-preset-menu" hidden>${presets.length ? `<span class="preset-menu-label">Timer presets</span>${presets.map((preset) => presetOptionMarkup(preset, samePreset(preset, timerPreset))).join('')}` : '<span class="preset-menu-empty">No saved presets yet</span>'}</div></div></header><div class="live-layout"><div class="timer-zone"><div class="timer-display"><span id="timer-value">00:00</span></div><div class="stage-progress" id="stage-progress" style="--stage-count:${timerPreset.stages.length}">${timerPreset.stages.map((stage, index, stages) => `<div class="stage-progress-item" data-progress-index="${index}" style="--stage-color:${stage.color};--next-stage-color:${stages[index + 1]?.color ?? stage.color}"><div class="stage-progress-bar" aria-hidden="true"><span></span></div><b>${escapeHtml(stage.name)}</b><small>${formatTime(stage.threshold)}</small></div>`).join('')}</div><div class="timer-warnings" id="timer-warnings" aria-live="polite"></div></div><div class="control-zone"><div class="player-controls"><button type="button" class="player-button" id="local-reset" aria-label="Reset timer"><span aria-hidden="true">&#8634;</span></button><button type="button" class="player-button player-button-main" id="local-play" aria-label="Play timer"><span id="play-icon" aria-hidden="true">&#9654;</span></button><button type="button" class="player-button" id="local-next-stage" aria-label="Advance to next stage"><span aria-hidden="true">&#9654;&#124;</span></button></div></div></div></section></div></div>`;
  document.querySelector('#duration')?.closest('label')?.remove();
  document.querySelector('.timer-display')?.insertAdjacentHTML('afterend', `<div class="timer-timeline" id="timer-timeline" role="progressbar" aria-label="Stage timeline progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="timer-timeline-track" aria-hidden="true"><span class="timer-timeline-fill"></span></div><div class="timer-checkpoints">${timerPreset.stages.map((stage, index) => `<div class="timer-checkpoint ${index === 0 ? 'is-active' : ''}" data-checkpoint-index="${index}" style="--checkpoint-position:${Math.min(100, Math.max(0, stage.threshold / timelineEnd * 100))}%;--stage-color:${stage.color}"><span class="timer-checkpoint-dot" aria-hidden="true"></span><b>${escapeHtml(stage.name)}</b><small>${formatTime(stage.threshold)}</small></div>`).join('')}</div></div>`);
  document.body.classList.toggle('live-open', liveViewOpen);
  const timerPicker = document.querySelector<HTMLElement>('#timer-preset-picker'); if (timerPicker) timerPicker.hidden = false;
  document.querySelector('#local-next-stage')?.insertAdjacentHTML('afterend', '<button type="button" class="player-button stop-button" id="local-stop" aria-label="Stop and save timer" title="Stop and save"><span aria-hidden="true">&#9632;</span></button>');
  app.insertAdjacentHTML('beforeend', historyModalMarkup());
  document.querySelector('.live-layout')?.insertAdjacentHTML('afterbegin', transcription.markup());
  const deleteButton = document.querySelector<HTMLButtonElement>('#delete-preset');
  if (deleteButton) {
    deleteButton.innerHTML = presetIcons.delete;
    deleteButton.insertAdjacentHTML('beforebegin', `<button type="button" class="toolbar-button icon-toolbar-button history-button" id="open-history" title="Timer History" aria-label="Open Timer History">${presetIcons.history}</button>`);
    deleteButton.insertAdjacentHTML('beforebegin', `<button type="button" class="toolbar-button icon-toolbar-button" id="send-preset" title="Send preset to controller" aria-label="Send preset to controller" ${serial.supportsStandalonePreset ? '' : 'disabled'}>${presetIcons.send}</button>`);
  }
  document.querySelector('#fail-result-output')?.closest('.result-fields')?.remove();
  bindEvents(); transcription.bind(); transcription.syncTimer(activeRun?.state === 'running'); updateEditorActions(); updateTimerUi(); syncTimerLoop(); void syncWakeLock();
}

function syncCurrentFromForm(): void { const value = (selector: string) => document.querySelector<HTMLInputElement>(selector)?.value; current.name = value('#preset-name') ?? current.name; current.speaker = value('#speaker') ?? current.speaker; current.club = value('#club') ?? current.club; document.querySelectorAll<HTMLElement>('.stage-row').forEach((row, index) => { const get = (field: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`); const stage = current.stages[index]; if (!stage) return; const minutes = get('threshold-minutes')?.value ?? ''; const seconds = get('threshold-seconds')?.value ?? ''; const parsedMinutes = minutes === '' ? 0 : Number(minutes); const parsedSeconds = seconds === '' ? 0 : Number(seconds); stage.name = get('name')?.value ?? stage.name; stage.threshold = Number.isInteger(parsedMinutes) && Number.isInteger(parsedSeconds) && parsedMinutes >= 0 && parsedSeconds >= 0 && parsedSeconds < 60 ? parsedMinutes * 60 + parsedSeconds : 0; stage.color = get('color')?.value ?? stage.color; stage.blink = (get('blink') as HTMLInputElement | null)?.checked ?? false; stage.grace = (get('grace') as HTMLInputElement | null)?.checked ?? false; stage.buzzer = (get('buzzer')?.value ?? stage.buzzer) as Stage['buzzer']; }); const lastStageTime = current.stages[current.stages.length - 1]?.threshold ?? 0; const durationInput = value('#duration') ?? ''; const durationParts = durationInput.split(':'); const duration = durationParts.length === 2 && durationParts.every((part) => /^\d+$/.test(part)) ? Number(durationParts[0]) * 60 + Number(durationParts[1]) : 0; current.duration = Math.max(duration, lastStageTime + 30); }
function validCurrent(): boolean { return Boolean(current.name.trim() && current.speaker.trim() && current.club.trim()) && current.stages.length >= 3 && current.stages.length <= MAX_STAGES && current.stages.every((stage, index) => Number.isFinite(stage.threshold) && stage.threshold >= 0 && (index === 0 || stage.threshold > current.stages[index - 1].threshold)); }
function showInvalid(): void { document.querySelector('.overview-canvas')?.classList.add('invalid'); window.setTimeout(() => document.querySelector('.overview-canvas')?.classList.remove('invalid'), 1200); }
function updateEditorActions(): void { const save = document.querySelector<HTMLButtonElement>('#save-preset'); const revert = document.querySelector<HTMLButtonElement>('#reset-form'); if (save) save.disabled = saved; if (revert) revert.hidden = saved; }
function configuredSnapshot(): PresetSnapshot { syncCurrentFromForm(); return { name: current.name, speaker: current.speaker, club: current.club, duration: current.duration, stages: structuredClone(current.stages) }; }
function reorderStage(from: number, to: number): void { if (from === to || to < 0 || to >= current.stages.length) return; const thresholds = current.stages.map((stage) => stage.threshold); const [stage] = current.stages.splice(from, 1); current.stages.splice(to, 0, stage); current.stages.forEach((item, index) => { item.threshold = thresholds[index]; }); }
function refreshStageOrderMarkup(list: HTMLElement): void { list.querySelectorAll<HTMLElement>('.stage-row').forEach((row, index) => { row.dataset.index = String(index); const number = row.querySelector('.stage-number'); const summary = row.querySelector('.stage-summary-index'); if (number) number.textContent = String(index + 1).padStart(2, '0'); if (summary) summary.textContent = `Stage ${index + 1}`; row.querySelector('[data-stage-drag]')?.setAttribute('aria-label', `Reorder stage ${index + 1}`); }); }
const stageReorderAnimationIds = new WeakMap<HTMLElement, number>();
function animateStageReorder(list: HTMLElement, before: Map<Element, DOMRect>): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const duration = 220;
  const easing = 'cubic-bezier(.2,.8,.2,1)';
  list.querySelectorAll<HTMLElement>('.stage-row:not(.is-dragging)').forEach((row) => {
    const previous = before.get(row);
    if (!previous) return;
    const delta = previous.top - row.getBoundingClientRect().top;
    if (!delta) return;
    // Use an explicit FLIP transition. This also animates the flex-column
    // layout used by narrow screens, where the previous WAAPI-only motion
    // could be skipped while the dragged row was collapsing.
    const animationId = (stageReorderAnimationIds.get(row) ?? 0) + 1;
    stageReorderAnimationIds.set(row, animationId);
    row.style.transition = 'none';
    row.style.transform = `translate3d(0, ${delta}px, 0)`;
    void row.offsetWidth;
    requestAnimationFrame(() => {
      if (stageReorderAnimationIds.get(row) !== animationId) return;
      row.style.transition = `transform ${duration}ms ${easing}`;
      row.style.transform = 'translate3d(0, 0, 0)';
    });
    const cleanup = (event: TransitionEvent) => {
      if (event.propertyName !== 'transform') return;
      if (stageReorderAnimationIds.get(row) !== animationId) return;
      row.style.transition = '';
      row.style.transform = '';
      stageReorderAnimationIds.delete(row);
      row.removeEventListener('transitionend', cleanup);
    };
    row.addEventListener('transitionend', cleanup);
  });
}
function animateStageHeight(row: HTMLElement, from: number, to: number): void { if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return; row.style.overflow = 'hidden'; const animation = row.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }); const cleanup = () => { row.style.overflow = ''; }; void animation.finished.then(cleanup, cleanup); }
function bindStageDragging(list: HTMLElement): void {
  list.addEventListener('keydown', (event) => { const handle = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-stage-drag]'); if (!handle || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; const row = handle.closest<HTMLElement>('.stage-row'); if (!row) return; const from = Number(row.dataset.index); const to = event.key === 'Home' ? 0 : event.key === 'End' ? current.stages.length - 1 : from + (event.key === 'ArrowUp' ? -1 : 1); if (to === from || to < 0 || to >= current.stages.length) return; event.preventDefault(); syncCurrentFromForm(); reorderStage(from, to); saved = false; render(); document.querySelectorAll<HTMLButtonElement>('[data-stage-drag]')[to]?.focus(); });
  list.addEventListener('pointerdown', (event) => { const handle = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-stage-drag]'); if (!handle || event.button !== 0) return; const row = handle.closest<HTMLElement>('.stage-row'); if (!row) return; event.preventDefault(); syncCurrentFromForm(); const pointerId = event.pointerId; const from = Number(row.dataset.index); let index = from; const restoreExpanded = matchMedia('(max-width: 720px)').matches && row.classList.contains('is-expanded'); const expandedHeight = row.getBoundingClientRect().height; let dragSpacer: HTMLDivElement | null = null; if (restoreExpanded) { row.classList.remove('is-expanded'); row.querySelector('[data-stage-toggle]')?.setAttribute('aria-expanded', 'false'); const collapsedHeight = row.getBoundingClientRect().height; dragSpacer = document.createElement('div'); dragSpacer.setAttribute('aria-hidden', 'true'); dragSpacer.style.height = `${Math.max(0, expandedHeight - collapsedHeight)}px`; dragSpacer.style.flex = '0 0 auto'; dragSpacer.style.pointerEvents = 'none'; dragSpacer.style.visibility = 'hidden'; row.before(dragSpacer); } const rect = row.getBoundingClientRect(); const grabOffsetX = event.clientX - rect.left; const grabOffsetY = Math.min(event.clientY - rect.top, rect.height); const ghost = row.cloneNode(true) as HTMLElement; ghost.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id')); ghost.classList.remove('is-dragging'); ghost.classList.add('stage-drag-ghost'); ghost.setAttribute('aria-hidden', 'true'); ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`; ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`; const positionGhost = (clientX: number, clientY: number) => { ghost.style.transform = `translate3d(${clientX - event.clientX}px, ${clientY - event.clientY}px, 0) scale(1.015) rotate(.3deg)`; }; document.body.append(ghost); positionGhost(event.clientX, event.clientY); handle.setPointerCapture(pointerId); row.classList.add('is-dragging'); list.classList.add('is-reordering');
    const onMove = (moveEvent: PointerEvent) => { if (moveEvent.pointerId !== pointerId) return; positionGhost(moveEvent.clientX, moveEvent.clientY); const rows = Array.from(list.querySelectorAll<HTMLElement>('.stage-row')); const siblings = rows.filter((item) => item !== row); const before = new Map<Element, DOMRect>(rows.map((item) => [item, item.getBoundingClientRect()])); const next = siblings.find((item) => moveEvent.clientY < item.getBoundingClientRect().top + item.offsetHeight / 2); if (next) list.insertBefore(row, next); else list.append(row); const newIndex = Array.from(list.children).indexOf(row); if (newIndex === index) return; index = newIndex; refreshStageOrderMarkup(list); animateStageReorder(list, before); const bounds = list.getBoundingClientRect(); const edge = Math.min(42, bounds.height / 4); if (moveEvent.clientY < bounds.top + edge) list.scrollBy({ top: -32, behavior: 'smooth' }); else if (moveEvent.clientY > bounds.bottom - edge) list.scrollBy({ top: 32, behavior: 'smooth' }); };
    const onEnd = (endEvent: PointerEvent) => { if (endEvent.pointerId !== pointerId) return; if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onEnd); document.removeEventListener('pointercancel', onEnd); ghost.remove(); dragSpacer?.remove(); row.classList.remove('is-dragging'); list.classList.remove('is-reordering'); if (index !== from) { reorderStage(from, index); saved = false; render(); document.querySelectorAll<HTMLButtonElement>('[data-stage-drag]')[index]?.focus(); } else refreshStageOrderMarkup(list); if (restoreExpanded) { const restoredRow = document.querySelectorAll<HTMLElement>('.stage-row')[index]; if (restoredRow) { const collapsedHeight = restoredRow.getBoundingClientRect().height; restoredRow.classList.add('is-expanded'); restoredRow.querySelector('[data-stage-toggle]')?.setAttribute('aria-expanded', 'true'); animateStageHeight(restoredRow, collapsedHeight, restoredRow.getBoundingClientRect().height); } } };
    document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onEnd); document.addEventListener('pointercancel', onEnd);
  });
}
function dispatch(action: TimerAction): void {
  const before = activeRun; const result = reduceTimer(activeRun, action, clock()); activeRun = result.run; persistRun();
  transcription.syncTimer(activeRun?.state === 'running', action.type === 'reset' || (action.type === 'start' && !before));
  const transitionMs = action.type === 'start' ? 300 : result.stageChanged ? 1000 : action.type === 'reset' ? 0 : 0;
  void applyOutputs(action.type === 'start' || result.stageChanged || action.type === 'reset', transitionMs, result.chime).catch(() => undefined);
  updateTimerUi(); syncTimerLoop(); void syncWakeLock();
  if (action.type === 'start' && !before) { liveViewOpen = true; const overlay = document.querySelector<HTMLElement>('#live-overlay'); if (overlay) overlay.hidden = false; document.body.classList.add('live-open'); }
}
function outputChanged(a: ReturnType<typeof deriveOutputs>, b: ReturnType<typeof deriveOutputs>): boolean { return a.color !== b.color || a.ledEffect !== b.ledEffect || a.animationState !== b.animationState || a.buzzerMode !== b.buzzerMode; }
function applyOutputs(force: boolean, transitionMs = 0, chime = false): Promise<void> { const next = deriveOutputs(activeRun, clock()); if (!force && !outputChanged(next, lastOutputs)) return Promise.resolve(); outputRevision++; lastOutputs = next; return serial.setOutputs({ ...next, buzzerMode: chime ? 'once' : next.buzzerMode, transitionMs, revision: outputRevision }); }
function savePreset(): void { syncCurrentFromForm(); if (!validCurrent()) { showInvalid(); return; } current.updatedAt = new Date().toISOString(); const existing = presets.findIndex((preset) => preset.id === current.id); if (existing >= 0) presets[existing] = structuredClone(current); else presets.unshift(structuredClone(current)); persistPresets(); revertTarget = structuredClone(current); saved = true; render(); }
async function sendPreset(): Promise<void> {
  syncCurrentFromForm();
  if (!validCurrent()) { showInvalid(); return; }
  const button = document.querySelector<HTMLButtonElement>('#send-preset');
  if (button) button.disabled = true;
  try {
    await serial.storePreset({ duration: current.duration, stages: current.stages.map(({ threshold, color, blink, buzzer }) => ({ threshold, color, blink: Boolean(blink), buzzer })) });
    updateDeviceMessage('Preset stored on controller', false);
  } catch (error) { updateDeviceMessage(error instanceof Error ? error.message : 'Controller could not store the preset', true); }
  finally { if (button) button.disabled = !serial.supportsStandalonePreset; }
}
function updateDeviceMessage(message: string, error: boolean): void { const state = document.querySelector('#device-state'); const detail = document.querySelector('#device-detail'); if (state) state.textContent = message; detail?.classList.toggle('is-error', error); }
function updateTimerUi(): void {
  const run = activeRun; if (!run) return; const elapsed = elapsedSeconds(run, clock()); const duration = Math.max(1, run.preset.duration); const timelineEnd = Math.max(1, run.preset.stages[run.preset.stages.length - 1]?.threshold ?? 0); const percent = Math.min(100, Math.max(0, elapsed / timelineEnd * 100));
  const value = document.querySelector('#timer-value'); if (value) value.textContent = formatTime(elapsed);
  const stage = effectiveStage(run, clock());
  const timeline = document.querySelector<HTMLElement>('#timer-timeline');
  const timelineFill = timeline?.querySelector<HTMLElement>('.timer-timeline-fill');
  if (timeline) timeline.setAttribute('aria-valuenow', String(Math.round(percent)));
  if (timelineFill) timelineFill.style.width = `${percent}%`;
  document.querySelectorAll<HTMLElement>('[data-checkpoint-index]').forEach((checkpoint, index) => {
    checkpoint.classList.toggle('is-active', index === stage);
    checkpoint.classList.toggle('is-passed', index < stage);
  });
  document.querySelectorAll<HTMLElement>('[data-progress-index]').forEach((item, index) => {
    item.classList.toggle('active', index === stage);
    const start = run.preset.stages[index]?.threshold ?? 0;
    const end = run.preset.stages[index + 1]?.threshold ?? duration;
    const stagePercent = end > start ? Math.min(100, Math.max(0, (elapsed - start) / (end - start) * 100)) : 0;
    const fill = item.querySelector<HTMLElement>('.stage-progress-bar span');
    if (fill) fill.style.width = `${stagePercent}%`;
  });
  const running = run.state === 'running'; const timerPicker = document.querySelector<HTMLElement>('#timer-preset-picker'); const timerPickerToggle = document.querySelector<HTMLButtonElement>('#timer-preset-toggle'); const timerMenu = document.querySelector<HTMLElement>('#timer-preset-menu'); timerPicker?.classList.toggle('is-running', running); if (timerPickerToggle) { timerPickerToggle.disabled = running; if (running) timerPickerToggle.setAttribute('aria-expanded', 'false'); } if (running && timerMenu) timerMenu.hidden = true; const icon = document.querySelector('#play-icon'); const playButton = document.querySelector<HTMLButtonElement>('#local-play'); if (icon) icon.innerHTML = running ? '&#10074;&#10074;' : '&#9654;'; if (playButton) playButton.ariaLabel = `${running ? 'Pause' : run.state === 'paused' ? 'Resume' : 'Play'} timer`;
  updateWarnings();
}
function syncTimerLoop(): void { if (activeRun?.state === 'running' && !timerInterval) timerInterval = window.setInterval(() => { dispatch({ type: 'tick' }); }, 250); if (activeRun?.state !== 'running' && timerInterval) { window.clearInterval(timerInterval); timerInterval = undefined; } }
function updateWarnings(): void { const target = document.querySelector<HTMLElement>('#timer-warnings'); if (!target) return; const warnings: string[] = []; if (activeRun?.state === 'running' && document.hidden) warnings.push('This page is hidden; keep it visible for reliable timing.'); if (activeRun?.state === 'running' && wakeLockWarning) warnings.push('Screen wake lock is unavailable or was released.'); if (activeRun?.state === 'running' && serial.status.state !== 'connected') warnings.push('Hardware link lost; the website timer continues and repeating audio will be silenced.'); if (activeRun?.clockWarning) warnings.push(activeRun.clockWarning); target.innerHTML = warnings.map((warning) => `<div class="timer-warning">${escapeHtml(warning)}</div>`).join(''); }
async function syncWakeLock(): Promise<void> { const wakeApi = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ released: boolean; release(): Promise<void>; addEventListener(type: string, listener: () => void): void }> } }).wakeLock; if (!activeRun || activeRun.state !== 'running' || document.hidden) { if (wakeLock) await wakeLock.release().catch(() => undefined); wakeLock = null; wakeLockWarning = false; updateWarnings(); return; } if (!wakeApi) { wakeLockWarning = true; updateWarnings(); return; } try { if (!wakeLock || wakeLock.released) { wakeLock = await wakeApi.request('screen'); wakeLockWarning = false; wakeLock.addEventListener('release', () => { wakeLockWarning = true; updateWarnings(); }); } } catch { wakeLockWarning = true; } updateWarnings(); }
function openLiveView(): void { syncCurrentFromForm(); if (!validCurrent()) { showInvalid(); return; } const overlay = document.querySelector<HTMLElement>('#live-overlay'); if (!overlay) return; liveViewOpen = true; overlay.hidden = false; document.body.classList.add('live-open'); window.setTimeout(() => document.querySelector<HTMLButtonElement>('#local-play')?.focus(), 0); updateTimerUi(); }
function closeLiveView(): void { const overlay = document.querySelector<HTMLElement>('#live-overlay'); if (!overlay || overlay.hidden) return; transcription.close(); liveViewOpen = false; overlay.hidden = true; document.body.classList.remove('live-open'); }
function selectPreset(presetId: string, fromTimer = false): void { const preset = presets.find((candidate) => candidate.id === presetId); if (!preset || (fromTimer && activeRun?.state === 'running')) return; current = structuredClone(preset); expandedStage = current.stages[0] ?? null; revertTarget = structuredClone(current); saved = true; if (fromTimer && activeRun) { activeRun = null; persistRun(); } render(); if (fromTimer) openLiveView(); }
function stopAndSave(): void {
  if (!activeRun) return;
  const startedAt = activeRun.startedAtWallMs ?? Date.now();
  if (activeRun.state === 'running') dispatch({ type: 'pause' });
  const run = activeRun; if (!run) return;
  const stoppedAt = Math.floor(elapsedSeconds(run, clock()));
  const stageIndex = effectiveStage(run, clock());
  // The final stage is the actual speaking deadline. The timer remains
  // active beyond it so that overtime can be measured and saved as negative
  // remaining time.
  const endAt = run.preset.stages[run.preset.stages.length - 1]?.threshold ?? run.preset.duration;
  const result = stoppedAt > endAt
    ? run.preset.stages[run.preset.stages.length - 1]?.name || 'Time reached'
    : run.preset.stages[stageIndex]?.name || `Stage ${stageIndex + 1}`;
  history.unshift({ id: crypto.randomUUID(), presetTitle: run.preset.name || 'Untitled preset', speaker: speakerName(run.preset), club: clubName(run.preset), duration: endAt, allottedTime: allottedTime(run.preset, endAt), startedAt, stoppedAt, savedAt: new Date().toISOString(), variance: endAt - stoppedAt, result, resultColor: run.preset.stages[stageIndex]?.color });
  persistHistory();
  const target = document.querySelector<HTMLElement>('#timer-warnings');
  target?.insertAdjacentHTML('afterbegin', '<div class="timer-saved">Timer stopped and saved to history.</div>');
}
function exportHistoryCsv(): void {
  const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = [['Preset title', 'Club name', 'Speaker name', 'Start date and time', 'Total duration', 'Allotted Time', 'Saved stop time', 'Time remaining', 'Result', 'Saved at'], ...displayedHistory().map((item) => [item.presetTitle, item.club, item.speaker, item.startedAt ? new Date(item.startedAt).toISOString() : '', formatTime(item.duration), formatTime(item.allottedTime ?? item.duration), formatTime(item.stoppedAt), formatVariance(item.variance), item.result, item.savedAt])];
  const blob = new Blob([`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `timelight-history-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
function closeHistory(): void { historyOpen = false; if (historySearchRefreshTimer !== undefined) { window.clearTimeout(historySearchRefreshTimer); historySearchRefreshTimer = undefined; } const modal = document.querySelector<HTMLElement>('#history-overlay'); if (modal) modal.hidden = true; }
function bindHistoryEvents(): void {
  const overlay = document.querySelector<HTMLElement>('#history-overlay');
  if (!overlay) return;
  // Delegate events that target the table/footer because those nodes are
  // replaced when the filters are refreshed. This keeps one listener per
  // modal instead of adding listeners after every keystroke.
  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (event.target === event.currentTarget || target.closest('#history-close')) { closeHistory(); return; }
    if (target.closest('#history-tools-toggle')) { const tools = overlay.querySelector<HTMLElement>('#history-tools'); const toggle = overlay.querySelector<HTMLButtonElement>('#history-tools-toggle'); if (!tools || !toggle) return; historyToolsExpanded = tools.hidden; tools.hidden = !historyToolsExpanded; toggle.setAttribute('aria-expanded', String(historyToolsExpanded)); return; }
    if (target.closest('#export-history')) { exportHistoryCsv(); return; }
    const sortButton = target.closest<HTMLButtonElement>('[data-history-sort]');
    if (sortButton) { const key = sortButton.dataset.historySort as typeof historySort.key; historySort = { key, direction: historySort.key === key && historySort.direction === 'asc' ? 'desc' : 'asc' }; openHistory(); return; }
    const deleteButton = target.closest<HTMLButtonElement>('.history-delete');
    if (deleteButton) { if (!confirm('Delete this timer history entry?')) return; history = history.filter((item) => item.id !== deleteButton.dataset.historyId); persistHistory(); openHistory(); }
  });
  document.querySelector<HTMLInputElement>('#history-search')?.addEventListener('input', (e) => {
    historySearch = (e.target as HTMLInputElement).value;
    if (historySearchRefreshTimer !== undefined) window.clearTimeout(historySearchRefreshTimer);
    historySearchRefreshTimer = window.setTimeout(() => { historySearchRefreshTimer = undefined; refreshHistoryContents(); }, 120);
  });
  document.querySelector<HTMLSelectElement>('#history-preset')?.addEventListener('change', (e) => { historyPreset = (e.target as HTMLSelectElement).value; refreshHistoryContents(); });
  document.querySelector<HTMLInputElement>('#history-date-from')?.addEventListener('change', (e) => { historyDateFrom = (e.target as HTMLInputElement).value; refreshHistoryContents(); });
  document.querySelector<HTMLInputElement>('#history-date-to')?.addEventListener('change', (e) => { historyDateTo = (e.target as HTMLInputElement).value; refreshHistoryContents(); });
}
function openHistory(): void {
  history = loadHistory(); historyOpen = true;
  const oldModal = document.querySelector<HTMLElement>('#history-overlay');
  oldModal?.insertAdjacentHTML('afterend', historyModalMarkup()); oldModal?.remove();
  bindHistoryEvents();
  document.querySelector<HTMLButtonElement>('#history-close')?.focus();
}

function bindEvents(): void {
  document.querySelector('#preset-picker-toggle')?.addEventListener('click', () => { const menu = document.querySelector<HTMLElement>('#preset-menu'); const toggle = document.querySelector<HTMLButtonElement>('#preset-picker-toggle'); if (!menu || !toggle) return; menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.querySelector('#timer-preset-toggle')?.addEventListener('click', () => { const menu = document.querySelector<HTMLElement>('#timer-preset-menu'); const toggle = document.querySelector<HTMLButtonElement>('#timer-preset-toggle'); if (!menu || !toggle) return; menu.hidden = !menu.hidden; toggle.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.querySelectorAll<HTMLButtonElement>('#preset-menu [data-preset]').forEach((button) => button.addEventListener('click', () => selectPreset(button.dataset.preset ?? '')));
  document.querySelectorAll<HTMLButtonElement>('#timer-preset-menu [data-preset]').forEach((button) => button.addEventListener('click', () => selectPreset(button.dataset.preset ?? '', true)));
  document.querySelector('.editor-card')?.addEventListener('input', () => { saved = false; const speaker = document.querySelector<HTMLInputElement>('#speaker')?.value.trim() || 'Speaker name'; const club = document.querySelector<HTMLInputElement>('#club')?.value.trim() || 'Club name'; const meta = document.querySelector<HTMLElement>('.preset-picker-meta'); if (meta) meta.innerHTML = `<span>${escapeHtml(club)}</span><span>${escapeHtml(speaker)}</span>`; updateEditorActions(); });
  document.querySelector('#new-preset')?.addEventListener('click', () => { current = { id: crypto.randomUUID(), name: '', speaker: '', club: '', duration: 90, stages: structuredClone(defaultStages), updatedAt: '' }; expandedStage = current.stages[0] ?? null; revertTarget = structuredClone(current); saved = false; render(); document.querySelector<HTMLInputElement>('#preset-name')?.focus(); });
  document.querySelector('#duplicate-preset')?.addEventListener('click', () => { syncCurrentFromForm(); current = { ...structuredClone(current), id: crypto.randomUUID(), name: `${current.name || 'Untitled preset'} copy`, updatedAt: '' }; expandedStage = current.stages[0] ?? null; revertTarget = structuredClone(current); saved = false; render(); document.querySelector<HTMLInputElement>('#preset-name')?.focus(); });
  document.querySelector('#play-preset')?.addEventListener('click', () => { if (!activeRun) { syncCurrentFromForm(); if (!validCurrent()) { showInvalid(); return; } openLiveView(); } else openLiveView(); });
  document.querySelector('#back-to-editor')?.addEventListener('click', closeLiveView); document.querySelector('#live-overlay')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeLiveView(); }); document.querySelector('#save-preset')?.addEventListener('click', savePreset);
  document.querySelector('#reset-form')?.addEventListener('click', () => { current = structuredClone(revertTarget); expandedStage = current.stages[0] ?? null; saved = presets.some((preset) => preset.id === current.id); render(); });
  document.querySelector('#send-preset')?.addEventListener('click', () => { void sendPreset(); });
  document.querySelector('#delete-preset')?.addEventListener('click', () => { presets = presets.filter((preset) => preset.id !== current.id); persistPresets(); current = structuredClone(presets[0] ?? starter); expandedStage = current.stages[0] ?? null; revertTarget = structuredClone(current); saved = presets.length > 0; render(); });
  document.querySelector('#add-stage')?.addEventListener('click', () => { syncCurrentFromForm(); current.stages.push({ name: 'New stage', threshold: (current.stages[current.stages.length - 1]?.threshold || 0) + 60, color: colors[current.stages.length], blink: false, buzzer: 'once' }); saved = false; render(); });
  const stageList = document.querySelector<HTMLElement>('#stage-list');
  stageList?.addEventListener('click', (event) => { const target = event.target as HTMLElement; const menuToggle = target.closest<HTMLButtonElement>('[data-stage-menu-toggle]'); if (menuToggle) { const menu = menuToggle.parentElement?.querySelector<HTMLElement>('.stage-menu'); if (!menu) return; const open = menu.hidden; document.querySelectorAll<HTMLElement>('.stage-menu').forEach((item) => { item.hidden = true; }); menu.hidden = !open; menuToggle.setAttribute('aria-expanded', String(open)); return; } const toggle = target.closest<HTMLButtonElement>('[data-stage-toggle]'); if (toggle) { const row = toggle.closest<HTMLElement>('.stage-row'); if (row) { const stage = current.stages[Number(row.dataset.index)]; const expanded = !row.classList.contains('is-expanded'); if (expanded) { expandedStage = stage ?? null; document.querySelectorAll<HTMLElement>('.stage-row.is-expanded').forEach((item) => { item.classList.remove('is-expanded'); item.querySelector<HTMLButtonElement>('[data-stage-toggle]')?.setAttribute('aria-expanded', 'false'); }); } else if (expandedStage === stage) expandedStage = null; row.classList.toggle('is-expanded', expanded); toggle.setAttribute('aria-expanded', String(expanded)); } return; } const action = target.closest<HTMLButtonElement>('[data-stage-action]'); const row = action?.closest<HTMLElement>('.stage-row'); if (!action || !row || action.disabled) return; syncCurrentFromForm(); const index = Number(row.dataset.index); if (action.classList.contains('remove-stage')) { if (expandedStage === current.stages[index]) expandedStage = null; current.stages.splice(index, 1); } saved = false; render(); });
  if (stageList) bindStageDragging(stageList);
  document.querySelector('#stage-list')?.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    const row = input.closest<HTMLElement>('.stage-row');
    if (!row) return;
    if (input.dataset.field === 'color') {
      row.style.setProperty('--stage-color', input.value);
      const label = input.parentElement?.querySelector('span');
      if (label) label.textContent = input.value;
    }
    if (input.dataset.field === 'name') {
      const element = row.querySelector<HTMLElement>('.stage-summary-name');
      if (element) element.textContent = input.value || 'Untitled stage';
      const graceCheckbox = row.querySelector<HTMLInputElement>('[data-field="grace"]');
      if (graceCheckbox && isGraceStage({ name: input.value })) graceCheckbox.checked = true;
    }
    if (input.dataset.field === 'name' || input.dataset.field === 'grace') {
      const name = row.querySelector<HTMLInputElement>('[data-field="name"]')?.value ?? '';
      const grace = row.querySelector<HTMLInputElement>('[data-field="grace"]')?.checked ?? false;
      row.classList.toggle('is-grace', isGraceStage({ name, grace }));
    }
    if (input.dataset.field?.startsWith('threshold-')) {
      input.value = input.value.replace(/\D/g, '').slice(0, input.maxLength);
      const group = input.closest('.time-input');
      const minutes = group?.querySelector<HTMLInputElement>('[data-field="threshold-minutes"]')?.value || '0';
      const seconds = group?.querySelector<HTMLInputElement>('[data-field="threshold-seconds"]')?.value || '0';
      const element = row.querySelector<HTMLElement>('.stage-summary-threshold');
      if (element) element.textContent = `${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
    }
  });
  document.querySelector('#stage-list')?.addEventListener('focusin', (event) => { const input = event.target as HTMLInputElement; if (input.dataset.field?.startsWith('threshold-')) input.select(); });
  document.querySelector('#stage-list')?.addEventListener('focusout', (event) => { const input = event.target as HTMLInputElement; if (!input.dataset.field?.startsWith('threshold-') || !input.value) return; if (input.dataset.field === 'threshold-seconds' && Number(input.value) > 59) input.value = '59'; input.value = input.value.padStart(2, '0'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  document.querySelector('#local-play')?.addEventListener('click', () => { if (!activeRun) dispatch({ type: 'start', preset: configuredSnapshot() }); else dispatch({ type: activeRun.state === 'running' ? 'pause' : 'resume' }); });
  document.querySelector('#local-reset')?.addEventListener('click', () => { dispatch({ type: 'reset' }); render(); openLiveView(); }); document.querySelector('#local-next-stage')?.addEventListener('click', () => dispatch({ type: 'next_stage' }));
  document.querySelector('#local-stop')?.addEventListener('click', stopAndSave);
  document.querySelector('#open-history')?.addEventListener('click', openHistory);
  bindHistoryEvents();
  document.querySelector('#device-connect')?.addEventListener('click', async () => { const button = document.querySelector<HTMLButtonElement>('#device-connect'); if (serial.status.state === 'connected') { manualDisconnect = true; await serial.disconnect(); return; } manualDisconnect = false; if (button) button.disabled = true; try { const recovered = await serial.reconnect(); if (!recovered) await serial.connect(); } catch { /* status UI contains the reason */ } finally { updateDeviceUi(serial.status); } });
  document.querySelector('#install-app')?.addEventListener('click', () => { void installApp(); });
}

function updateConnectionUi(): void {
  const badge = document.querySelector<HTMLElement>('#connection-badge');
  const state = document.querySelector<HTMLElement>('#connection-state');
  if (!badge || !state) return;
  const online = navigator.onLine;
  badge.className = `connection-badge ${online ? 'online' : 'offline'}`;
  badge.dataset.shellReady = String(shellReady);
  state.textContent = connectionMessage();
}

function updateInstallUi(): void {
  const button = document.querySelector<HTMLButtonElement>('#install-app');
  if (!button) return;
  button.hidden = !deferredInstallPrompt || standaloneLaunch();
  button.disabled = installPromptPending;
  button.setAttribute('aria-busy', String(installPromptPending));
}

async function installApp(): Promise<void> {
  const prompt = deferredInstallPrompt;
  if (!prompt || installPromptPending || standaloneLaunch()) return;
  installPromptPending = true;
  updateInstallUi();
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    // The browser owns the native dialog; a canceled or unavailable prompt is
    // treated like a dismissal and does not expose a stale action again.
  } finally {
    deferredInstallPrompt = null;
    installPromptPending = false;
    updateInstallUi();
  }
}

function updateDeviceUi(status: SerialStatus): void { const badge = document.querySelector('#device-badge'); const state = document.querySelector('#device-state'); const connect = document.querySelector<HTMLButtonElement>('#device-connect'); const send = document.querySelector<HTMLButtonElement>('#send-preset'); const detail = document.querySelector('#device-detail'); if (!badge || !state || !connect) return; badge.className = `device-badge ${status.state}`; state.textContent = status.message; if (detail) { detail.textContent = status.firmware ? `Firmware ${status.firmware}${status.ledCount ? ` · ${status.ledCount} LEDs` : ''}` : ''; detail.classList.toggle('is-error', Boolean(status.warning) || status.state === 'error'); } const connected = status.state === 'connected'; connect.disabled = status.state === 'connecting' || status.state === 'unsupported'; if (send) send.disabled = !serial.supportsStandalonePreset; connect.title = connected ? 'Disconnect TimeLight' : 'Connect TimeLight'; connect.setAttribute('aria-label', connect.title); updateWarnings(); if (connected) { reconnectDelay = 250; if (reconnectTimer) window.clearTimeout(reconnectTimer); reconnectTimer = undefined; } else if (!manualDisconnect && status.state !== 'unsupported') scheduleReconnect(); }
function scheduleReconnect(): void { if (reconnectTimer || manualDisconnect || serial.status.state === 'connected' || serial.status.state === 'connecting') return; reconnectTimer = window.setTimeout(async () => { reconnectTimer = undefined; try { if (await serial.reconnect()) reconnectDelay = 250; else reconnectDelay = Math.min(5000, reconnectDelay * 2); } catch { reconnectDelay = Math.min(5000, reconnectDelay * 2); } if (serial.status.state !== 'connected') scheduleReconnect(); }, reconnectDelay); }
function handleDeviceMessage(message: DeviceMessage): void { if (message.type !== 'button' || !['play_pause', 'next_stage', 'reset'].includes(String(message.button))) return; const sequence = typeof message.sequence === 'number' ? message.sequence : 0; if (sequence <= lastButtonSequence) return; lastButtonSequence = sequence; if (message.button === 'reset') { dispatch({ type: 'reset' }); return; } dispatch({ type: message.button === 'play_pause' ? (activeRun?.state === 'running' ? 'pause' : activeRun ? 'resume' : 'start') : 'next_stage', ...(message.button === 'play_pause' && !activeRun ? { preset: configuredSnapshot() } : {}) } as TimerAction); }

serial.onStatus(updateDeviceUi); serial.onMessage(handleDeviceMessage); serial.onReady(() => { lastButtonSequence = 0; void applyOutputs(true, 0).catch(() => undefined); });
render();
window.addEventListener('online', updateConnectionUi);
window.addEventListener('offline', updateConnectionUi);
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; installPromptPending = false; updateInstallUi(); });
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); if (standaloneLaunch()) return; deferredInstallPrompt = event as BeforeInstallPromptEvent; installPromptPending = false; updateInstallUi(); });
window.matchMedia('(display-mode: standalone)').addEventListener('change', () => { if (standaloneLaunch()) deferredInstallPrompt = null; updateInstallUi(); });
document.addEventListener('visibilitychange', () => { void syncWakeLock(); updateWarnings(); });
window.addEventListener('click', (event) => { const target = event.target as Node; const picker = document.querySelector('.preset-picker'); const timerPicker = document.querySelector('.timer-preset-picker'); if (picker?.contains(target) || timerPicker?.contains(target)) return; const menu = document.querySelector<HTMLElement>('#preset-menu'); const toggle = document.querySelector<HTMLButtonElement>('#preset-picker-toggle'); if (menu && toggle) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } const timerMenu = document.querySelector<HTMLElement>('#timer-preset-menu'); const timerToggle = document.querySelector<HTMLButtonElement>('#timer-preset-toggle'); if (timerMenu && timerToggle) { timerMenu.hidden = true; timerToggle.setAttribute('aria-expanded', 'false'); } });
window.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (historyOpen) closeHistory(); else closeLiveView(); });
registerSW({ immediate: true, onOfflineReady: () => { shellReady = true; updateConnectionUi(); }, onNeedRefresh: () => { document.body.dataset.updateWaiting = 'true'; } });
