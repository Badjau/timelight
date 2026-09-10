import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/timer.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const timer = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const preset = { name: 'Test', speaker: '', duration: 10, stages: [
  { name: 'one', threshold: 0, color: '#0000ff', buzzer: 'none' },
  { name: 'two', threshold: 3, color: '#ffff00', buzzer: 'once' },
  { name: 'final', threshold: 8, color: '#ff0000', buzzer: 'repeat' },
] };
const at = (wallMs, monotonicMs = wallMs) => ({ wallMs, monotonicMs });

test('allotted time excludes every stage whose name contains the word grace', () => {
  const gracePreset = { ...preset, duration: 300, stages: [
    { ...preset.stages[0], name: 'Grace before', threshold: 0 },
    { ...preset.stages[1], name: 'Speech', threshold: 30 },
    { ...preset.stages[1], name: 'Mid-speech GRACE period', threshold: 120 },
    { ...preset.stages[1], name: 'Speech resumes', threshold: 135 },
    { ...preset.stages[2], name: 'Grace after', threshold: 270 },
    { ...preset.stages[2], name: 'Time reached', threshold: 300 },
  ] };

  assert.equal(timer.allottedTime(gracePreset, 300), 225);
  assert.equal(timer.allottedTime({ ...gracePreset, stages: [{ ...gracePreset.stages[0], name: 'Disgrace', threshold: 0 }, ...gracePreset.stages.slice(1)] }, 300), 255);
  assert.equal(timer.allottedTime({ ...preset, stages: preset.stages.map((stage, index) => index === 1 ? { ...stage, grace: true } : stage) }, 8), 3);
});

test('fake clock covers start, thresholds, pause, resume, and elapsed beyond duration', () => {
  let result = timer.reduceTimer(null, { type: 'start', preset }, at(0));
  assert.equal(result.run.state, 'running');
  result = timer.reduceTimer(result.run, { type: 'tick' }, at(3500));
  assert.equal(timer.elapsedSeconds(result.run, at(3500)), 3.5);
  assert.equal(timer.effectiveStage(result.run, at(3500)), 1);
  assert.equal(result.chime, true);
  result = timer.reduceTimer(result.run, { type: 'tick' }, at(12000));
  assert.equal(result.run.state, 'running');
  assert.equal(result.chime, false);
  assert.equal(timer.elapsedSeconds(result.run, at(12000)), 12);
  assert.equal(timer.deriveOutputs(result.run, at(12000)).buzzerMode, 'repeat');
  result = timer.reduceTimer(result.run, { type: 'pause' }, at(12000));
  assert.equal(result.run.state, 'paused');
  result = timer.reduceTimer(result.run, { type: 'resume' }, at(15000));
  assert.equal(timer.elapsedSeconds(result.run, at(16000)), 13);
});

test('next stage is a manual override and reset clears the run', () => {
  let result = timer.reduceTimer(null, { type: 'start', preset }, at(0));
  result = timer.reduceTimer(result.run, { type: 'next_stage' }, at(1000));
  assert.equal(result.run.accumulatedElapsed, 0);
  assert.equal(timer.effectiveStage(result.run, at(1000)), 1);
  assert.equal(result.chime, true);
  result = timer.reduceTimer(result.run, { type: 'next_stage' }, at(1500));
  assert.equal(timer.effectiveStage(result.run, at(1500)), 2);
  assert.equal(result.chime, false);
  result = timer.reduceTimer(result.run, { type: 'reset' }, at(2000));
  assert.equal(result.run, null);
});

test('one-shot alerts fire for the first stage and each later configured stage', () => {
  const chimePreset = { name: 'Chimes', speaker: '', duration: 30, stages: [
    { name: 'one', threshold: 0, color: '#0000ff', buzzer: 'once' },
    { name: 'two', threshold: 5, color: '#00ff00', buzzer: 'once' },
    { name: 'three', threshold: 10, color: '#ff7b00', buzzer: 'once' },
    { name: 'four', threshold: 20, color: '#ff0000', buzzer: 'repeat' },
  ] };
  let result = timer.reduceTimer(null, { type: 'start', preset: chimePreset }, at(0));
  assert.equal(result.chime, true);
  result = timer.reduceTimer(result.run, { type: 'tick' }, at(5000));
  assert.equal(result.chime, true);
  result = timer.reduceTimer(result.run, { type: 'tick' }, at(10000));
  assert.equal(result.chime, true);
  assert.equal(timer.effectiveStage(result.run, at(10000)), 2);
});

test('refresh recovery uses wall time and clamps backward-clock anomalies', () => {
  let result = timer.reduceTimer(null, { type: 'start', preset }, at(1000));
  result = timer.reduceTimer(result.run, { type: 'tick' }, at(4000));
  const saved = timer.persistableTimerRun(result.run);
  const recovered = timer.recoverTimerRun(saved, at(9000, 0));
  assert.equal(timer.elapsedSeconds(recovered, at(9000, 0)), 8);
  const backwards = timer.recoverTimerRun(saved, at(3000, 0));
  assert.equal(backwards.state, 'paused');
  assert.match(backwards.clockWarning, /backward/);
});
