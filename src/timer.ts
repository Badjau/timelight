export type TimerState = 'idle' | 'running' | 'paused';
export type BuzzerMode = 'none' | 'once' | 'repeat';

export type Stage = {
  name: string;
  threshold: number;
  color: string;
  blink?: boolean;
  buzzer: BuzzerMode;
};

export type PresetSnapshot = {
  name: string;
  speaker: string;
  duration: number;
  stages: Stage[];
};

export type TimerRun = {
  preset: PresetSnapshot;
  runId: string;
  state: TimerState;
  accumulatedElapsed: number;
  lastPersistedElapsed: number;
  startedAtWallMs: number | null;
  lastPersistedWallMs: number;
  manualStageIndex: number | null;
  lastEffectiveStageIndex: number;
  clockWarning?: string;
  // This value is intentionally runtime-only. It is not a reliable clock after a reload.
  startedAtMonotonicMs?: number;
};

export type TimerClock = { wallMs: number; monotonicMs: number };
export type TimerAction =
  | { type: 'start'; preset: PresetSnapshot }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'reset' }
  | { type: 'next_stage' }
  | { type: 'tick' };

export type HardwareOutputs = {
  color: string;
  ledEffect: 'off' | 'solid' | 'blink';
  transitionMs: number;
  animationState: 'playing' | 'paused';
  buzzerMode: 'none' | 'repeat';
};

export type TimerActionResult = { run: TimerRun | null; stageChanged: boolean; chime: boolean };

export function elapsedSeconds(run: TimerRun, clock: TimerClock): number {
  if (run.state !== 'running' || run.startedAtWallMs === null) return Math.max(0, run.accumulatedElapsed);
  const delta = typeof run.startedAtMonotonicMs === 'number'
    ? (clock.monotonicMs - run.startedAtMonotonicMs) / 1000
    : (clock.wallMs - run.startedAtWallMs) / 1000;
  return Math.max(run.accumulatedElapsed, run.accumulatedElapsed + Math.max(0, delta));
}

export function thresholdStage(run: TimerRun, elapsed: number): number {
  return run.preset.stages.reduce((active, stage, index) => elapsed >= stage.threshold ? index : active, 0);
}

export function effectiveStage(run: TimerRun, clock: TimerClock): number {
  const derived = thresholdStage(run, elapsedSeconds(run, clock));
  return Math.max(derived, run.manualStageIndex ?? 0);
}

function clonePreset(preset: PresetSnapshot): PresetSnapshot {
  return structuredClone(preset);
}

function newId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function nextRun(preset: PresetSnapshot, clock: TimerClock): TimerRun {
  return {
    preset: clonePreset(preset), runId: newId(), state: 'running', accumulatedElapsed: 0, lastPersistedElapsed: 0,
    startedAtWallMs: clock.wallMs, lastPersistedWallMs: clock.wallMs, manualStageIndex: null, lastEffectiveStageIndex: 0,
    startedAtMonotonicMs: clock.monotonicMs,
  };
}

export function reduceTimer(previous: TimerRun | null, action: TimerAction, clock: TimerClock): TimerActionResult {
  if (action.type === 'reset') return { run: null, stageChanged: Boolean(previous), chime: false };
  if (action.type === 'start') return { run: nextRun(action.preset, clock), stageChanged: true, chime: false };
  if (!previous) return { run: previous, stageChanged: false, chime: false };

  const beforeStage = Number.isFinite(previous.lastEffectiveStageIndex) ? previous.lastEffectiveStageIndex : effectiveStage(previous, clock);
  const run: TimerRun = { ...previous };
  if (action.type === 'pause' && run.state === 'running') {
    run.accumulatedElapsed = elapsedSeconds(run, clock); run.lastPersistedElapsed = run.accumulatedElapsed;
    run.state = 'paused'; run.startedAtWallMs = null; delete run.startedAtMonotonicMs;
  } else if (action.type === 'resume' && run.state === 'paused') {
    run.state = 'running'; run.startedAtWallMs = clock.wallMs; run.lastPersistedWallMs = clock.wallMs; run.startedAtMonotonicMs = clock.monotonicMs;
  } else if (action.type === 'next_stage' && run.state !== 'idle') {
    run.manualStageIndex = Math.min((run.manualStageIndex ?? beforeStage) + 1, run.preset.stages.length - 1);
  } else if (action.type === 'tick' && run.state === 'running') {
    if (clock.wallMs < run.lastPersistedWallMs) {
      run.accumulatedElapsed = Math.max(run.accumulatedElapsed, run.lastPersistedElapsed);
      run.state = 'paused'; run.startedAtWallMs = null; delete run.startedAtMonotonicMs;
      run.clockWarning = 'The system clock moved backward; the timer was paused for safety.';
    } else {
      run.lastPersistedElapsed = elapsedSeconds(run, clock);
      run.lastPersistedWallMs = clock.wallMs;
    }
  }
  const afterStage = effectiveStage(run, clock);
  run.lastEffectiveStageIndex = afterStage;
  const enteredStage = run.preset.stages[afterStage];
  return { run, stageChanged: afterStage !== beforeStage, chime: afterStage > beforeStage && run.state === 'running' && enteredStage?.buzzer === 'once' };
}

export function deriveOutputs(run: TimerRun | null, clock: TimerClock): HardwareOutputs {
  if (!run) return { color: '#000000', ledEffect: 'off', transitionMs: 0, animationState: 'paused', buzzerMode: 'none' };
  const stage = run.preset.stages[effectiveStage(run, clock)] ?? run.preset.stages[0];
  if (!stage) return { color: '#000000', ledEffect: 'off', transitionMs: 0, animationState: 'paused', buzzerMode: 'none' };
  return {
    color: stage.color,
    ledEffect: stage.blink ? 'blink' : 'solid',
    transitionMs: 0,
    animationState: run.state === 'running' ? 'playing' : 'paused',
    buzzerMode: run.state === 'running' && stage.buzzer === 'repeat' ? 'repeat' : 'none',
  };
}

export function recoverTimerRun(value: unknown, clock: TimerClock): TimerRun | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TimerRun>;
  if (!candidate.preset || !Array.isArray(candidate.preset.stages) || !candidate.runId) return null;
  if (!['idle', 'running', 'paused'].includes(candidate.state ?? '')) return null;
  const run = structuredClone(candidate) as TimerRun;
  run.manualStageIndex = typeof run.manualStageIndex === 'number' ? Math.max(0, Math.min(run.manualStageIndex, run.preset.stages.length - 1)) : null;
  run.lastEffectiveStageIndex = Number.isFinite(run.lastEffectiveStageIndex) ? Math.max(0, Math.min(run.lastEffectiveStageIndex, run.preset.stages.length - 1)) : effectiveStage(run, clock);
  run.accumulatedElapsed = Number.isFinite(run.accumulatedElapsed) ? Math.max(0, run.accumulatedElapsed) : 0;
  run.lastPersistedElapsed = Number.isFinite(run.lastPersistedElapsed) ? Math.max(run.accumulatedElapsed, run.lastPersistedElapsed) : run.accumulatedElapsed;
  run.lastPersistedWallMs = Number.isFinite(run.lastPersistedWallMs) ? run.lastPersistedWallMs : clock.wallMs;
  delete run.startedAtMonotonicMs;
  if (run.state === 'running' && clock.wallMs < run.lastPersistedWallMs) {
    run.accumulatedElapsed = run.lastPersistedElapsed; run.state = 'paused'; run.startedAtWallMs = null;
    run.clockWarning = 'The system clock moved backward; the recovered timer was paused for safety.';
  }
  return run;
}

export function persistableTimerRun(run: TimerRun | null): TimerRun | null {
  if (!run) return null;
  const copy = structuredClone(run);
  delete copy.startedAtMonotonicMs;
  return copy;
}
