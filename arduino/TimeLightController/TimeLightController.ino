#include <Adafruit_NeoPixel.h>
#include <EEPROM.h>

#ifndef LED_COUNT
#define LED_COUNT 116
#endif
#define LED_PIN 6
#define BUZZER_PIN 7
#define PLAY_PAUSE_BUTTON_PIN 5
#define NEXT_STAGE_BUTTON_PIN 4
#define BAUD_RATE 115200
#define PROTOCOL_VERSION 4
#define MAX_ENCODED_FRAME 80
#define MAX_RAW_FRAME 80
#define BUTTON_DEBOUNCE_MS 35
#define LONG_PRESS_MS 3000
#define CONTROL_LEASE_MS 3000
#define SERIAL_ACQUIRE_QUIET_MS 300
#define BLINK_FADE_MS 700
#define LED_FRAME_INTERVAL_MS 16
#define BUZZER_INTERVAL_MS 1500
#define BUZZER_DURATION_MS 75
#define PRESET_MAGIC 0x544C5053UL
#define PRESET_SCHEMA 1
#define MAX_STAGES 5
#define BUZZ_EVENT_SLOTS 4

enum FrameType { FRAME_HELLO=1, FRAME_READY, FRAME_ACK, FRAME_ERROR, FRAME_PING, FRAME_PONG, FRAME_KEEPALIVE, FRAME_RELEASE, FRAME_OUTPUTS, FRAME_BUZZ, FRAME_PRESET, FRAME_BUTTON };
enum ErrorCode { ERROR_MALFORMED=1, ERROR_VERSION, ERROR_SESSION, ERROR_OUTPUTS, ERROR_PRESET, ERROR_COMMAND };
enum LedEffect { EFFECT_OFF, EFFECT_SOLID, EFFECT_BLINK };
enum BuzzerMode { BUZZER_NONE, BUZZER_ONCE, BUZZER_REPEAT };
enum TimerState { TIMER_IDLE, TIMER_RUNNING, TIMER_PAUSED };
struct __attribute__((packed)) StoredStage { uint32_t threshold; uint32_t color; uint8_t flags; };
struct __attribute__((packed)) StoredPreset { uint32_t magic; uint32_t sequence; uint8_t schema; uint8_t stageCount; uint32_t duration; StoredStage stages[MAX_STAGES]; uint16_t checksum; };
struct ButtonState { uint8_t pin; bool lastReading; bool stableReading; uint32_t changedAt; uint32_t pressedAt; bool longReported; };

Adafruit_NeoPixel pixel(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
uint8_t encodedFrame[MAX_ENCODED_FRAME]; uint8_t encodedLength = 0;
StoredPreset preset; uint8_t activeSlot = 0; TimerState timerState = TIMER_IDLE; uint8_t standaloneStage = 0; uint32_t accumulatedMs = 0, runStartedMillis = 0;
uint32_t desiredColor = 0, displayedColor = 0, transitionStartColor = 0, transitionTargetColor = 0, transitionElapsed = 0, blinkElapsed = 0, lastAnimationMillis = 0, lastLedFrameMillis = 0, nextBuzzerMillis = 0;
uint16_t transitionDuration = 0; LedEffect ledEffect = EFFECT_OFF; bool animationPlaying = false; BuzzerMode buzzerMode = BUZZER_NONE;
uint32_t appliedRevision = 0, buttonSequence = 0, browserLeaseExpires = 0, lastSerialActivityMillis = 0, browserSessionId = 0, lastStoreRequestId = 0, buzzEventIds[BUZZ_EVENT_SLOTS] = {}; bool serialActivitySeen = false; uint8_t buzzEventCount = 0;
ButtonState playPauseButton = { PLAY_PAUSE_BUTTON_PIN, HIGH, HIGH, 0, 0, false }, nextStageButton = { NEXT_STAGE_BUTTON_PIN, HIGH, HIGH, 0, 0, false };

uint16_t read16(const uint8_t* p) { return (uint16_t)p[0] | (uint16_t)p[1] << 8; }
uint32_t read32(const uint8_t* p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
void write16(uint8_t* p, uint16_t value) { p[0] = value; p[1] = value >> 8; }
void write32(uint8_t* p, uint32_t value) { p[0] = value; p[1] = value >> 8; p[2] = value >> 16; p[3] = value >> 24; }
uint16_t crc16Bytes(const uint8_t* bytes, uint8_t length) { uint16_t result = 0xFFFF; for (uint8_t i = 0; i < length; i++) { result ^= bytes[i]; for (uint8_t bit = 0; bit < 8; bit++) result = result & 1 ? result >> 1 ^ 0xA001 : result >> 1; } return result; }
uint8_t cobsEncode(const uint8_t* input, uint8_t length, uint8_t* output) { uint8_t read = 0, write = 1, codeIndex = 0, code = 1; while (read < length) { if (!input[read]) { output[codeIndex] = code; codeIndex = write++; code = 1; read++; } else { output[write++] = input[read++]; if (++code == 0xFF) { output[codeIndex] = code; codeIndex = write++; code = 1; } } } output[codeIndex] = code; return write; }
uint8_t cobsDecode(const uint8_t* input, uint8_t length, uint8_t* output) { uint8_t read = 0, write = 0; while (read < length) { uint8_t code = input[read++]; if (!code || read + code - 1 > length) return 0; for (uint8_t i = 1; i < code; i++) output[write++] = input[read++]; if (code != 0xFF && read < length) output[write++] = 0; } return write; }
void sendFrame(uint8_t type, uint32_t requestId, const uint8_t* payload = 0, uint8_t payloadLength = 0) { uint8_t raw[MAX_RAW_FRAME], wire[MAX_ENCODED_FRAME]; uint8_t length = 12 + payloadLength; raw[0] = 0x54; raw[1] = 0x4C; raw[2] = PROTOCOL_VERSION; raw[3] = type; write32(raw + 4, requestId); write16(raw + 8, payloadLength); if (payloadLength) memcpy(raw + 10, payload, payloadLength); write16(raw + 10 + payloadLength, crc16Bytes(raw, 10 + payloadLength)); uint8_t wireLength = cobsEncode(raw, length, wire); Serial.write(wire, wireLength); Serial.write((uint8_t)0); }
void sendError(uint8_t code, uint32_t requestId = 0) { sendFrame(FRAME_ERROR, requestId, &code, 1); }
void sendAck(uint32_t requestId) { uint8_t payload[4]; write32(payload, appliedRevision); sendFrame(FRAME_ACK, requestId, payload, sizeof(payload)); }
void sendReady(uint32_t requestId = 0) { uint8_t payload[7]; write16(payload, LED_COUNT); payload[2] = 0; payload[3] = 5; payload[4] = 0; payload[5] = 7; payload[6] = 1; sendFrame(FRAME_READY, requestId, payload, sizeof(payload)); }
void sendButton(uint8_t button) { uint8_t payload[5]; payload[0] = button; write32(payload + 1, ++buttonSequence); sendFrame(FRAME_BUTTON, 0, payload, sizeof(payload)); }

uint16_t presetChecksum(const StoredPreset& value) { return crc16Bytes((const uint8_t*)&value, offsetof(StoredPreset, checksum)); }
bool validPreset(const StoredPreset& value) { if (value.magic != PRESET_MAGIC || value.schema != PRESET_SCHEMA || value.stageCount < 3 || value.stageCount > MAX_STAGES || !value.duration || value.checksum != presetChecksum(value)) return false; for (uint8_t i = 0; i < value.stageCount; i++) if (value.stages[i].threshold >= value.duration || (i && value.stages[i].threshold <= value.stages[i - 1].threshold) || (value.stages[i].flags & 3) > BUZZER_REPEAT || (value.stages[i].flags & ~7)) return false; return true; }
void compiledDefault() { memset(&preset, 0, sizeof(preset)); preset.magic = PRESET_MAGIC; preset.schema = PRESET_SCHEMA; preset.stageCount = 4; preset.duration = 240; uint32_t times[] = {0,60,120,180}, colors[] = {0x0000FF,0xFFFF00,0xFF7B00,0xFF0000}; for (uint8_t i = 0; i < 4; i++) { preset.stages[i].threshold = times[i]; preset.stages[i].color = colors[i]; preset.stages[i].flags = i == 0 ? BUZZER_NONE : i == 3 ? BUZZER_REPEAT : BUZZER_ONCE; } preset.checksum = presetChecksum(preset); }
void loadPreset() { StoredPreset slots[2]; EEPROM.get(0, slots[0]); EEPROM.get(sizeof(StoredPreset), slots[1]); bool a = validPreset(slots[0]), b = validPreset(slots[1]); if (!a && !b) { compiledDefault(); return; } activeSlot = b && (!a || (int32_t)(slots[1].sequence - slots[0].sequence) > 0); preset = slots[activeSlot]; }
void persistPreset() { uint8_t target = activeSlot ^ 1; int base = target * sizeof(StoredPreset); preset.magic = PRESET_MAGIC; preset.schema = PRESET_SCHEMA; preset.sequence++; preset.checksum = presetChecksum(preset); uint32_t invalid = 0; EEPROM.put(base, invalid); const uint8_t* bytes = (const uint8_t*)&preset; for (size_t i = 4; i < sizeof(preset); i++) EEPROM.update(base + i, bytes[i]); for (uint8_t i = 0; i < 4; i++) EEPROM.update(base + i, bytes[i]); activeSlot = target; }

void setStripColor(uint32_t color) { uint32_t value = pixel.Color(color >> 16 & 255, color >> 8 & 255, color & 255); for (uint16_t i = 0; i < LED_COUNT; i++) pixel.setPixelColor(i, value); pixel.show(); displayedColor = color; lastLedFrameMillis = millis(); }
uint8_t blend(uint8_t from, uint8_t to, uint32_t elapsed, uint16_t duration) { if (!duration || elapsed >= duration) return to; int32_t difference = (int32_t)to - (int32_t)from; return (uint8_t)((int32_t)from + difference * (int32_t)elapsed / (int32_t)duration); }
uint32_t scaleColor(uint32_t color, uint8_t brightness) { return ((uint32_t)(color >> 16 & 255) * brightness / 255 << 16) | ((uint32_t)(color >> 8 & 255) * brightness / 255 << 8) | (color & 255) * brightness / 255; }
uint32_t transitionColor() { return (uint32_t)blend(transitionStartColor >> 16 & 255, transitionTargetColor >> 16 & 255, transitionElapsed, transitionDuration) << 16 | (uint32_t)blend(transitionStartColor >> 8 & 255, transitionTargetColor >> 8 & 255, transitionElapsed, transitionDuration) << 8 | blend(transitionStartColor & 255, transitionTargetColor & 255, transitionElapsed, transitionDuration); }
uint32_t renderedColor() { uint32_t color = transitionDuration && transitionElapsed < transitionDuration ? transitionColor() : desiredColor; if (ledEffect == EFFECT_OFF) return 0; if (ledEffect == EFFECT_BLINK && (!transitionDuration || transitionElapsed >= transitionDuration)) { uint32_t phase = blinkElapsed; uint8_t brightness = phase < BLINK_FADE_MS ? 255 - phase * 255 / BLINK_FADE_MS : (phase - BLINK_FADE_MS) * 255 / BLINK_FADE_MS; return scaleColor(desiredColor, brightness); } return color; }
void updateLeds() { uint32_t now = millis(), delta = now - lastAnimationMillis; lastAnimationMillis = now; if (animationPlaying) { if (transitionDuration && transitionElapsed < transitionDuration) transitionElapsed = min((uint32_t)transitionDuration, transitionElapsed + delta); else if (ledEffect == EFFECT_BLINK) blinkElapsed = (blinkElapsed + delta) % (BLINK_FADE_MS * 2UL); } uint32_t color = renderedColor(); if (!browserSessionId && serialActivitySeen && now - lastSerialActivityMillis < SERIAL_ACQUIRE_QUIET_MS) return; if (now - lastLedFrameMillis >= LED_FRAME_INTERVAL_MS && color != displayedColor) setStripColor(color); }
void applyOutputs(uint32_t color, LedEffect effect, uint16_t transition, bool playing, BuzzerMode buzzer) { bool changed = effect != ledEffect || color != desiredColor; if (effect == EFFECT_OFF) { desiredColor = 0; ledEffect = EFFECT_OFF; transitionDuration = transitionElapsed = blinkElapsed = 0; animationPlaying = false; setStripColor(0); } else { if (changed) { transitionStartColor = renderedColor(); desiredColor = transitionTargetColor = color; transitionDuration = transition; transitionElapsed = blinkElapsed = 0; } ledEffect = effect; animationPlaying = playing; } lastAnimationMillis = millis(); buzzerMode = buzzer; nextBuzzerMillis = 0; if (buzzer != BUZZER_REPEAT) noTone(BUZZER_PIN); updateLeds(); }
void updateBuzzer() { if (buzzerMode != BUZZER_REPEAT) return; uint32_t now = millis(); if (!nextBuzzerMillis || (int32_t)(now - nextBuzzerMillis) >= 0) { tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS); nextBuzzerMillis = now + BUZZER_INTERVAL_MS; } }
void stopTimerAndOutputs() { timerState = TIMER_IDLE; accumulatedMs = 0; standaloneStage = 0; applyOutputs(0, EFFECT_OFF, 0, false, BUZZER_NONE); }
uint32_t standaloneElapsed() { return accumulatedMs + (timerState == TIMER_RUNNING ? millis() - runStartedMillis : 0); }
void showStage(uint8_t index, bool alert) { StoredStage& stage = preset.stages[index]; BuzzerMode sound = (BuzzerMode)(stage.flags & 3); applyOutputs(stage.color, stage.flags & 4 ? EFFECT_BLINK : EFFECT_SOLID, 0, timerState == TIMER_RUNNING, timerState == TIMER_RUNNING && sound == BUZZER_REPEAT ? BUZZER_REPEAT : BUZZER_NONE); if (alert && timerState == TIMER_RUNNING && sound == BUZZER_ONCE) tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS); }
void toggleStandalone() { if (timerState == TIMER_IDLE) { timerState = TIMER_RUNNING; accumulatedMs = 0; runStartedMillis = millis(); standaloneStage = 0; showStage(0, false); } else if (timerState == TIMER_RUNNING) { accumulatedMs = standaloneElapsed(); timerState = TIMER_PAUSED; animationPlaying = false; buzzerMode = BUZZER_NONE; noTone(BUZZER_PIN); } else { timerState = TIMER_RUNNING; runStartedMillis = millis(); animationPlaying = true; buzzerMode = (preset.stages[standaloneStage].flags & 3) == BUZZER_REPEAT ? BUZZER_REPEAT : BUZZER_NONE; nextBuzzerMillis = 0; } }
void nextStandalone() { if (timerState == TIMER_IDLE || standaloneStage + 1 >= preset.stageCount) return; standaloneStage++; accumulatedMs = preset.stages[standaloneStage].threshold * 1000UL; if (timerState == TIMER_RUNNING) runStartedMillis = millis(); showStage(standaloneStage, timerState == TIMER_RUNNING); }
void updateStandalone() { if (timerState != TIMER_RUNNING) return; uint32_t elapsed = standaloneElapsed(); uint8_t stage = standaloneStage; while (stage + 1 < preset.stageCount && elapsed >= preset.stages[stage + 1].threshold * 1000UL) stage++; if (stage != standaloneStage) { standaloneStage = stage; showStage(stage, true); } }
void renewLease() { browserLeaseExpires = millis() + CONTROL_LEASE_MS; }
void acquireBrowser(uint32_t session) { stopTimerAndOutputs(); if (browserSessionId != session) { browserSessionId = session; appliedRevision = 0; buzzEventCount = 0; lastStoreRequestId = 0; } renewLease(); }
void releaseBrowser(bool announce) { if (!browserSessionId) return; browserSessionId = 0; browserLeaseExpires = 0; stopTimerAndOutputs(); if (announce) sendReady(); }
bool rememberBuzz(uint32_t id) { for (uint8_t i = 0; i < buzzEventCount; i++) if (buzzEventIds[i] == id) return false; if (buzzEventCount < BUZZ_EVENT_SLOTS) buzzEventIds[buzzEventCount++] = id; else { for (uint8_t i = 1; i < BUZZ_EVENT_SLOTS; i++) buzzEventIds[i - 1] = buzzEventIds[i]; buzzEventIds[BUZZ_EVENT_SLOTS - 1] = id; } return true; }

void handleFrame(const uint8_t* frame, uint8_t length) {
  if (length < 12 || frame[0] != 0x54 || frame[1] != 0x4C) { sendError(ERROR_MALFORMED); return; }
  uint32_t requestId = read32(frame + 4); uint16_t payloadLength = read16(frame + 8); if (frame[2] != PROTOCOL_VERSION) { sendError(ERROR_VERSION, requestId); return; } if (length != 12 + payloadLength || read16(frame + length - 2) != crc16Bytes(frame, length - 2)) { sendError(ERROR_MALFORMED, requestId); return; }
  uint8_t type = frame[3]; const uint8_t* p = frame + 10;
  if (type == FRAME_HELLO) { if (payloadLength != 4 || !read32(p)) { sendError(ERROR_MALFORMED, requestId); return; } acquireBrowser(read32(p)); sendReady(requestId); return; }
  if (type == FRAME_PING && !payloadLength) { sendFrame(FRAME_PONG, requestId); sendAck(requestId); return; }
  if (payloadLength < 4 || read32(p) != browserSessionId || !browserSessionId) { sendError(ERROR_SESSION, requestId); return; }
  if (type == FRAME_RELEASE && payloadLength == 4) { sendAck(requestId); releaseBrowser(false); return; }
  renewLease();
  if (type == FRAME_KEEPALIVE && payloadLength == 4) { sendAck(requestId); return; }
  if (type == FRAME_BUZZ && payloadLength == 8) { if (rememberBuzz(read32(p + 4))) tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS); sendAck(requestId); return; }
  if (type == FRAME_OUTPUTS && payloadLength == 18) { uint32_t revision = read32(p + 4), color = (uint32_t)p[8] << 16 | (uint32_t)p[9] << 8 | p[10]; uint8_t effect = p[11], animation = p[14], buzzer = p[15]; uint16_t transition = read16(p + 12), lease = read16(p + 16); if (effect > EFFECT_BLINK || animation > 1 || (buzzer != BUZZER_NONE && buzzer != BUZZER_REPEAT) || transition > 5000 || lease > 3000) { sendError(ERROR_OUTPUTS, requestId); return; } if (revision > appliedRevision) { appliedRevision = revision; applyOutputs(color, (LedEffect)effect, transition, animation, (BuzzerMode)buzzer); } sendAck(requestId); return; }
  if (type == FRAME_PRESET && payloadLength >= 33) { uint32_t duration = read32(p + 4); uint8_t count = p[8]; if (count < 3 || count > MAX_STAGES || payloadLength != 9 + count * 8 || !duration || duration > 86400) { sendError(ERROR_PRESET, requestId); return; } if (requestId && requestId == lastStoreRequestId) { sendAck(requestId); return; } StoredPreset candidate = preset; memset(candidate.stages, 0, sizeof(candidate.stages)); candidate.duration = duration; candidate.stageCount = count; for (uint8_t i = 0; i < count; i++) { const uint8_t* stage = p + 9 + i * 8; uint32_t threshold = read32(stage), color = (uint32_t)stage[4] << 16 | (uint32_t)stage[5] << 8 | stage[6]; uint8_t flags = stage[7]; if (threshold >= duration || (i && threshold <= candidate.stages[i - 1].threshold) || (flags & 3) > BUZZER_REPEAT || (flags & ~7)) { sendError(ERROR_PRESET, requestId); return; } candidate.stages[i].threshold = threshold; candidate.stages[i].color = color; candidate.stages[i].flags = flags; } preset = candidate; persistPreset(); timerState = TIMER_IDLE; accumulatedMs = 0; lastStoreRequestId = requestId; sendAck(requestId); return; }
  sendError(ERROR_COMMAND, requestId);
}
void readSerial() { while (Serial.available()) { uint8_t value = Serial.read(); lastSerialActivityMillis = millis(); serialActivitySeen = true; if (!value) { if (encodedLength) { uint8_t raw[MAX_RAW_FRAME]; uint8_t rawLength = cobsDecode(encodedFrame, encodedLength, raw); if (rawLength) handleFrame(raw, rawLength); else sendError(ERROR_MALFORMED); } encodedLength = 0; } else if (encodedLength < MAX_ENCODED_FRAME) encodedFrame[encodedLength++] = value; else encodedLength = 0; } }
bool updateButton(ButtonState& b) { bool reading = digitalRead(b.pin); uint32_t now = millis(); if (reading != b.lastReading) { b.lastReading = reading; b.changedAt = now; } if (now - b.changedAt < BUTTON_DEBOUNCE_MS || reading == b.stableReading) return false; b.stableReading = reading; if (reading == LOW) { b.pressedAt = now; b.longReported = false; } return true; }
void handleButtons() { bool play = updateButton(playPauseButton), next = updateButton(nextStageButton), owned = browserSessionId; if (play && playPauseButton.stableReading == HIGH) { if (owned) sendButton(1); else toggleStandalone(); } if (nextStageButton.stableReading == LOW && !nextStageButton.longReported && millis() - nextStageButton.pressedAt >= LONG_PRESS_MS) { nextStageButton.longReported = true; if (owned) sendButton(3); else stopTimerAndOutputs(); } if (next && nextStageButton.stableReading == HIGH && !nextStageButton.longReported) { if (owned) sendButton(2); else nextStandalone(); } }
void setup() { pinMode(BUZZER_PIN, OUTPUT); pinMode(PLAY_PAUSE_BUTTON_PIN, INPUT_PULLUP); pinMode(NEXT_STAGE_BUTTON_PIN, INPUT_PULLUP); playPauseButton.lastReading = playPauseButton.stableReading = digitalRead(PLAY_PAUSE_BUTTON_PIN); nextStageButton.lastReading = nextStageButton.stableReading = digitalRead(NEXT_STAGE_BUTTON_PIN); pixel.begin(); pixel.setBrightness(80); pixel.clear(); pixel.show(); loadPreset(); stopTimerAndOutputs(); Serial.begin(BAUD_RATE); delay(50); sendReady(); }
void loop() { readSerial(); if (browserSessionId && (int32_t)(millis() - browserLeaseExpires) >= 0) releaseBrowser(true); handleButtons(); updateStandalone(); updateLeds(); updateBuzzer(); }
