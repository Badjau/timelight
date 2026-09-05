#include <Adafruit_NeoPixel.h>

// Hardware settings. LED_COUNT is intentionally compile-time configurable for a build's strip.
#ifndef LED_COUNT
#define LED_COUNT 116
#endif
#define LED_PIN 6
#define BUZZER_PIN 7
#define PLAY_PAUSE_BUTTON_PIN 4
#define NEXT_STAGE_BUTTON_PIN 5
#define BAUD_RATE 115200
#define PROTOCOL_VERSION 3
#define RX_BUFFER_SIZE 384
#define BUTTON_DEBOUNCE_MS 35
#define BLINK_FADE_MS 700
#define LED_FRAME_INTERVAL_MS 16
#define BUZZER_INTERVAL_MS 1500
#define BUZZER_DURATION_MS 75

Adafruit_NeoPixel pixel(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
char inputBuffer[RX_BUFFER_SIZE];
uint16_t inputLength = 0;
bool inputOverflow = false;

enum LedEffect { EFFECT_OFF, EFFECT_SOLID, EFFECT_BLINK };
enum BuzzerMode { BUZZER_NONE, BUZZER_REPEAT };
uint32_t desiredColor = 0;
uint32_t displayedColor = 0;
uint32_t transitionStartColor = 0;
uint32_t transitionTargetColor = 0;
uint32_t transitionElapsed = 0;
uint16_t transitionDuration = 0;
uint32_t blinkElapsed = 0;
uint32_t lastAnimationMillis = 0;
uint32_t lastLedFrameMillis = 0;
LedEffect ledEffect = EFFECT_OFF;
bool animationPlaying = false;
BuzzerMode buzzerMode = BUZZER_NONE;
uint32_t audibleLeaseExpires = 0;
uint32_t nextBuzzerMillis = 0;
uint32_t appliedRevision = 0;
uint32_t buttonSequence = 0;
char browserSession[41] = "";
char buzzEvents[8][41] = {};
uint8_t buzzEventCount = 0;

struct ButtonState { uint8_t pin; bool lastReading; bool stableReading; uint32_t lastDebounceMillis; };
ButtonState playPauseButton = { PLAY_PAUSE_BUTTON_PIN, HIGH, HIGH, 0 };
ButtonState nextStageButton = { NEXT_STAGE_BUTTON_PIN, HIGH, HIGH, 0 };

struct Span { const char* begin; const char* end; };

void skipWhitespace(const char*& cursor, const char* end) { while (cursor < end && (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n')) cursor++; }
bool sameText(const char* value, size_t length, const char* expected) { return length == strlen(expected) && strncmp(value, expected, length) == 0; }

bool valueSpan(Span input, Span& output) {
  const char* cursor = input.begin; skipWhitespace(cursor, input.end); if (cursor >= input.end) return false; const char* start = cursor;
  if (*cursor == '"') { cursor++; bool escaped = false; while (cursor < input.end) { char c = *cursor++; if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') { output = { start, cursor }; return true; } } return false; }
  while (cursor < input.end && *cursor != ',' && *cursor != '}' && *cursor != ']' && *cursor != ' ' && *cursor != '\t' && *cursor != '\r' && *cursor != '\n') cursor++;
  output = { start, cursor }; return output.begin != output.end;
}

bool findKey(Span object, const char* key, Span& value) {
  const char* cursor = object.begin;
  while (cursor < object.end) {
    if (*cursor != '"') { cursor++; continue; }
    const char* keyStart = ++cursor; bool escaped = false;
    while (cursor < object.end) { if (escaped) escaped = false; else if (*cursor == '\\') escaped = true; else if (*cursor == '"') break; cursor++; }
    if (cursor >= object.end) return false;
    const char* after = cursor + 1; skipWhitespace(after, object.end);
    if (after < object.end && *after == ':' && sameText(keyStart, cursor - keyStart, key)) return valueSpan({ after + 1, object.end }, value);
    cursor++;
  }
  return false;
}

bool readJsonString(Span value, char* output, size_t outputSize) {
  if (value.begin >= value.end || *value.begin != '"' || value.end[-1] != '"' || outputSize == 0) return false;
  const char* cursor = value.begin + 1; const char* limit = value.end - 1; size_t length = 0;
  while (cursor < limit) { char c = *cursor++; if (c == '\\') { if (cursor >= limit) return false; c = *cursor++; if (c != '"' && c != '\\' && c != '/' && c != '-' && c != '_') return false; } if (length + 1 >= outputSize) return false; output[length++] = c; }
  output[length] = '\0'; return true;
}
bool readText(Span object, const char* key, char* output, size_t outputSize) { Span value; return findKey(object, key, value) && readJsonString(value, output, outputSize); }
bool readUnsigned(Span value, uint32_t& output) { const char* cursor = value.begin; skipWhitespace(cursor, value.end); uint32_t result = 0; bool digit = false; while (cursor < value.end && *cursor >= '0' && *cursor <= '9') { digit = true; uint8_t n = *cursor++ - '0'; if (result > (0xFFFFFFFFUL - n) / 10UL) return false; result = result * 10UL + n; } skipWhitespace(cursor, value.end); if (!digit || cursor != value.end) return false; output = result; return true; }
bool readColor(Span value, uint32_t& output) { char color[8]; if (!readJsonString(value, color, sizeof(color)) || color[0] != '#' || strlen(color) != 7) return false; output = 0; for (uint8_t i = 1; i < 7; i++) { char c = color[i]; uint8_t n = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 255; if (n == 255) return false; output = (output << 4) | n; } return true; }
bool readRequestId(Span object, char* output, size_t size) { return readText(object, "requestId", output, size); }
bool sessionMatches(Span object) { char session[41]; return readText(object, "sessionId", session, sizeof(session)) && browserSession[0] && strcmp(session, browserSession) == 0; }

void printJsonString(const char* value) { Serial.print('"'); while (*value) { if (*value == '"' || *value == '\\') Serial.print('\\'); Serial.print(*value++); } Serial.print('"'); }
void sendError(const char* message, const char* requestId = nullptr) { Serial.print(F("{\"version\":3,\"type\":\"error\"")); if (requestId && requestId[0]) { Serial.print(F(",\"requestId\":")); printJsonString(requestId); } Serial.print(F(",\"message\":")); printJsonString(message); Serial.println('}'); }
void sendAck(const char* requestId, uint32_t revision) { Serial.print(F("{\"version\":3,\"type\":\"ack\",\"requestId\":")); printJsonString(requestId); Serial.print(F(",\"appliedRevision\":")); Serial.print(revision); Serial.println('}'); }
void sendReady(const char* requestId = nullptr) { Serial.print(F("{\"version\":3,\"type\":\"ready\"")); if (requestId && requestId[0]) { Serial.print(F(",\"requestId\":")); printJsonString(requestId); } Serial.print(F(",\"device\":\"timelight-arduino\",\"firmware\":\"0.3.0\",\"ledCount\":")); Serial.print(LED_COUNT); Serial.println(F(",\"buttons\":[\"play_pause\",\"next_stage\"]}")); }
void sendPong(const char* requestId) { Serial.print(F("{\"version\":3,\"type\":\"pong\",\"requestId\":")); printJsonString(requestId); Serial.println('}'); }

void setStripColor(uint32_t color) { uint32_t value = pixel.Color((color >> 16) & 255, (color >> 8) & 255, color & 255); for (uint16_t i = 0; i < LED_COUNT; i++) pixel.setPixelColor(i, value); pixel.show(); displayedColor = color; lastLedFrameMillis = millis(); }
uint8_t blend(uint8_t from, uint8_t to, uint32_t elapsed, uint16_t duration) { if (!duration || elapsed >= duration) return to; int32_t difference = (int32_t)to - (int32_t)from; return (uint8_t)((int32_t)from + difference * (int32_t)elapsed / (int32_t)duration); }
uint32_t scaleColor(uint32_t color, uint8_t brightness) { return ((uint32_t)((color >> 16 & 255) * brightness / 255) << 16) | ((uint32_t)((color >> 8 & 255) * brightness / 255) << 8) | ((color & 255) * brightness / 255); }
uint32_t transitionColor() { return ((uint32_t)blend((transitionStartColor >> 16) & 255, (transitionTargetColor >> 16) & 255, transitionElapsed, transitionDuration) << 16) | ((uint32_t)blend((transitionStartColor >> 8) & 255, (transitionTargetColor >> 8) & 255, transitionElapsed, transitionDuration) << 8) | blend(transitionStartColor & 255, transitionTargetColor & 255, transitionElapsed, transitionDuration); }
uint32_t renderedColor() {
  uint32_t color = transitionDuration && transitionElapsed < transitionDuration ? transitionColor() : desiredColor;
  if (ledEffect == EFFECT_OFF) return 0;
  if (ledEffect == EFFECT_BLINK && (!transitionDuration || transitionElapsed >= transitionDuration)) { uint32_t phase = blinkElapsed; uint8_t brightness = phase < BLINK_FADE_MS ? 255 - (phase * 255 / BLINK_FADE_MS) : ((phase - BLINK_FADE_MS) * 255 / BLINK_FADE_MS); return scaleColor(desiredColor, brightness); }
  return color;
}
void updateLeds() {
  uint32_t now = millis(); uint32_t delta = now - lastAnimationMillis; lastAnimationMillis = now;
  if (animationPlaying) {
    if (transitionDuration && transitionElapsed < transitionDuration) { transitionElapsed = min((uint32_t)transitionDuration, transitionElapsed + delta); if (transitionElapsed >= transitionDuration) blinkElapsed = 0; }
    else if (ledEffect == EFFECT_BLINK) blinkElapsed = (blinkElapsed + delta) % (BLINK_FADE_MS * 2UL);
  }
  uint32_t color = renderedColor();
  if (now - lastLedFrameMillis < LED_FRAME_INTERVAL_MS) return;
  if (color != displayedColor) setStripColor(color);
}
void applyOutputs(uint32_t color, LedEffect effect, uint16_t transition, bool playing, BuzzerMode buzzer, uint32_t lease) { uint32_t now = millis(); bool targetChanged = effect != ledEffect || color != desiredColor; if (effect == EFFECT_OFF) { desiredColor = 0; ledEffect = EFFECT_OFF; transitionDuration = 0; transitionElapsed = 0; blinkElapsed = 0; animationPlaying = false; setStripColor(0); } else { if (targetChanged) { transitionStartColor = renderedColor(); desiredColor = color; transitionTargetColor = color; transitionDuration = transition; transitionElapsed = 0; blinkElapsed = 0; } else { desiredColor = color; transitionTargetColor = color; } ledEffect = effect; animationPlaying = playing; } lastAnimationMillis = now; buzzerMode = buzzer; nextBuzzerMillis = 0; audibleLeaseExpires = buzzer == BUZZER_REPEAT && lease ? now + min(lease, (uint32_t)3000) : 0; if (buzzer != BUZZER_REPEAT) noTone(BUZZER_PIN); updateLeds(); }
void updateBuzzer() { uint32_t now = millis(); if (buzzerMode != BUZZER_REPEAT || !audibleLeaseExpires || (int32_t)(now - audibleLeaseExpires) >= 0) { if (buzzerMode != BUZZER_REPEAT || (int32_t)(now - audibleLeaseExpires) >= 0) { noTone(BUZZER_PIN); buzzerMode = BUZZER_NONE; } return; } if (!nextBuzzerMillis || (int32_t)(now - nextBuzzerMillis) >= 0) { tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS); nextBuzzerMillis = now + BUZZER_INTERVAL_MS; } }

bool rememberBuzzEvent(const char* eventId) { for (uint8_t i = 0; i < buzzEventCount; i++) if (strcmp(buzzEvents[i], eventId) == 0) return false; if (buzzEventCount < 8) strcpy(buzzEvents[buzzEventCount++], eventId); else { for (uint8_t i = 1; i < 8; i++) strcpy(buzzEvents[i - 1], buzzEvents[i]); strcpy(buzzEvents[7], eventId); } return true; }
void handleMessage() {
  inputBuffer[inputLength] = '\0'; Span message = { inputBuffer, inputBuffer + inputLength }; char requestId[41] = ""; readRequestId(message, requestId, sizeof(requestId));
  Span value; uint32_t version = 0; if (!findKey(message, "version", value) || !readUnsigned(value, version) || version != PROTOCOL_VERSION) { sendError("Unsupported protocol version", requestId); return; }
  char type[20]; if (!readText(message, "type", type, sizeof(type))) { sendError("Missing message type", requestId); return; }
  if (strcmp(type, "hello") == 0) { char session[41]; if (!readText(message, "sessionId", session, sizeof(session))) { sendError("Invalid browser session", requestId); return; } if (strcmp(browserSession, session) != 0) { strncpy(browserSession, session, sizeof(browserSession) - 1); browserSession[sizeof(browserSession) - 1] = '\0'; appliedRevision = 0; buzzEventCount = 0; } sendReady(requestId); return; }
  if (strcmp(type, "ping") == 0) { sendPong(requestId); sendAck(requestId, appliedRevision); return; }
  if (strcmp(type, "set_outputs") == 0) {
    if (!sessionMatches(message)) { sendError("Unknown browser session", requestId); return; }
    uint32_t revision = 0, transition = 0, lease = 0, color = 0; char effect[10], animation[10], buzzer[10]; if (!findKey(message, "revision", value) || !readUnsigned(value, revision) || !findKey(message, "color", value) || !readColor(value, color) || !readText(message, "ledEffect", effect, sizeof(effect)) || !findKey(message, "transitionMs", value) || !readUnsigned(value, transition) || transition > 5000 || !readText(message, "animationState", animation, sizeof(animation)) || !readText(message, "buzzerMode", buzzer, sizeof(buzzer)) || !findKey(message, "leaseMs", value) || !readUnsigned(value, lease) || lease > 3000) { sendError("Invalid output snapshot", requestId); return; }
    LedEffect parsedEffect = strcmp(effect, "off") == 0 ? EFFECT_OFF : strcmp(effect, "solid") == 0 ? EFFECT_SOLID : strcmp(effect, "blink") == 0 ? EFFECT_BLINK : (LedEffect)255; BuzzerMode parsedBuzzer = strcmp(buzzer, "none") == 0 ? BUZZER_NONE : strcmp(buzzer, "repeat") == 0 ? BUZZER_REPEAT : (BuzzerMode)255; if (parsedEffect == (LedEffect)255 || parsedBuzzer == (BuzzerMode)255 || (strcmp(animation, "playing") != 0 && strcmp(animation, "paused") != 0)) { sendError("Invalid output effect or animation state", requestId); return; }
    if (revision > appliedRevision) { appliedRevision = revision; applyOutputs(color, parsedEffect, transition, strcmp(animation, "playing") == 0, parsedBuzzer, lease); } sendAck(requestId, appliedRevision); return;
  }
  if (strcmp(type, "buzz_once") == 0) { if (!sessionMatches(message)) { sendError("Unknown browser session", requestId); return; } char eventId[41]; if (!readText(message, "eventId", eventId, sizeof(eventId))) { sendError("Invalid buzzer event", requestId); return; } if (rememberBuzzEvent(eventId)) tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS); sendAck(requestId, appliedRevision); return; }
  if (strcmp(type, "keepalive") == 0) { if (!sessionMatches(message)) { sendError("Unknown browser session", requestId); return; } if (buzzerMode == BUZZER_REPEAT) audibleLeaseExpires = millis() + 3000; sendAck(requestId, appliedRevision); return; }
  sendError("Unsupported command; the website owns timer state", requestId);
}

void readSerial() { while (Serial.available() > 0) { char c = (char)Serial.read(); if (c == '\r') continue; if (c == '\n') { if (inputOverflow) sendError("Message too long"); else if (inputLength) handleMessage(); inputLength = 0; inputOverflow = false; continue; } if (inputLength + 1 >= RX_BUFFER_SIZE) { inputOverflow = true; continue; } inputBuffer[inputLength++] = c; } }
bool buttonPressed(ButtonState& button) { bool reading = digitalRead(button.pin); uint32_t now = millis(); if (reading != button.lastReading) { button.lastDebounceMillis = now; button.lastReading = reading; } if (now - button.lastDebounceMillis < BUTTON_DEBOUNCE_MS || reading == button.stableReading) return false; button.stableReading = reading; return reading == LOW; }
void sendButton(const char* name) { Serial.print(F("{\"version\":3,\"type\":\"button\",\"button\":")); printJsonString(name); Serial.print(F(",\"sequence\":")); Serial.print(++buttonSequence); Serial.println('}'); }
void handleButtons() { if (!browserSession[0]) return; if (buttonPressed(playPauseButton)) sendButton("play_pause"); if (buttonPressed(nextStageButton)) sendButton("next_stage"); }

void setup() { pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW); pinMode(PLAY_PAUSE_BUTTON_PIN, INPUT_PULLUP); pinMode(NEXT_STAGE_BUTTON_PIN, INPUT_PULLUP); playPauseButton.lastReading = playPauseButton.stableReading = digitalRead(PLAY_PAUSE_BUTTON_PIN); nextStageButton.lastReading = nextStageButton.stableReading = digitalRead(NEXT_STAGE_BUTTON_PIN); pixel.begin(); pixel.setBrightness(80); pixel.clear(); pixel.show(); Serial.begin(BAUD_RATE); delay(50); sendReady(); }
void loop() { readSerial(); handleButtons(); updateLeds(); updateBuzzer(); }
