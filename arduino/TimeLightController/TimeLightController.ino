// TimeLight controller: a WS2812 strip, one buzzer, and two push buttons.
// Hardware: WS2812 data in on D6, buzzer on D7, play/pause button on D4,
// and next-stage button on D5. Buttons connect the pin to GND when pressed.
// Requires the Adafruit NeoPixel library.

#include <Adafruit_NeoPixel.h>
#include <string.h>

const uint8_t LED_PIN = 6;
const uint8_t BUZZER_PIN = 7; //7 to use it;
const uint8_t PLAY_PAUSE_BUTTON_PIN = 6;
const uint8_t NEXT_STAGE_BUTTON_PIN = 5;
const uint8_t LED_COUNT = 100;
const uint8_t MAX_STAGES = 5;
const uint32_t BAUD_RATE = 115200;
const uint32_t STATUS_INTERVAL_MS = 500;
const uint32_t BUZZER_DELAY_MS = 3000;
const uint16_t BUZZER_DURATION_MS = 800;
const uint16_t COLOR_TRANSITION_MS = 300;
const uint8_t COLOR_TRANSITION_FRAME_MS = 10;
const uint16_t BUTTON_DEBOUNCE_MS = 35;
const size_t RX_BUFFER_SIZE = 768;

Adafruit_NeoPixel pixel(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

enum TimerState : uint8_t { IDLE, RUNNING, PAUSED };
enum BuzzerMode : uint8_t { BUZZER_NONE, BUZZER_ONCE, BUZZER_REPEAT };

struct Stage {
  uint32_t threshold;
  uint32_t color;
  bool blink;
  BuzzerMode buzzer;
};

Stage stages[MAX_STAGES] = {
  { 0, 0x56A9FF, false, BUZZER_NONE },
  { 60, 0xFFD166, false, BUZZER_ONCE },
  { 120, 0xFF914B, false, BUZZER_ONCE },
  { 180, 0xFF6678, false, BUZZER_REPEAT },
};
uint8_t stageCount = 4;
uint32_t durationSeconds = 240;
uint8_t currentStage = 0;
TimerState timerState = IDLE;

char inputBuffer[RX_BUFFER_SIZE];
size_t inputLength = 0;
bool inputOverflow = false;
uint32_t accumulatedMillis = 0;
uint32_t runStartedMillis = 0;
uint32_t nextBuzzerMillis = 0;
uint32_t lastStatusMillis = 0;
uint32_t displayedColor = 0;
uint32_t transitionStartColor = 0;
uint32_t transitionTargetColor = 0;
uint32_t transitionStartedMillis = 0;
uint32_t lastTransitionFrameMillis = 0;
bool colorTransitionActive = false;

struct ButtonState {
  uint8_t pin;
  bool lastReading;
  bool stableReading;
  uint32_t lastDebounceMillis;
};

ButtonState playPauseButton = { PLAY_PAUSE_BUTTON_PIN, HIGH, HIGH, 0 };
ButtonState nextStageButton = { NEXT_STAGE_BUTTON_PIN, HIGH, HIGH, 0 };

struct Span {
  const char* begin;
  const char* end;
};

void skipWhitespace(const char*& cursor, const char* end) {
  while (cursor < end && (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n')) cursor++;
}

bool isHex(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F');
}

uint8_t hexValue(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return value - 'A' + 10;
}

bool sameText(const char* value, size_t length, const char* expected) {
  size_t expectedLength = strlen(expected);
  return length == expectedLength && strncmp(value, expected, expectedLength) == 0;
}

bool readJsonString(Span value, char* output, size_t outputSize) {
  if (value.begin >= value.end || *value.begin != '"' || value.end[-1] != '"' || outputSize == 0) return false;
  const char* cursor = value.begin + 1;
  const char* limit = value.end - 1;
  size_t outputLength = 0;
  while (cursor < limit) {
    char character = *cursor++;
    if (character == '\\') {
      if (cursor >= limit) return false;
      character = *cursor++;
      if (character == '"' || character == '\\' || character == '/') {
        // Keep the escaped character.
      } else if (character == 'n') {
        character = '\n';
      } else if (character == 'r') {
        character = '\r';
      } else if (character == 't') {
        character = '\t';
      } else {
        return false;
      }
    } else if (character < 0x20) {
      return false;
    }
    if (outputLength + 1 >= outputSize) return false;
    output[outputLength++] = character;
  }
  output[outputLength] = '\0';
  return true;
}

bool valueSpan(Span input, Span& output) {
  const char* cursor = input.begin;
  skipWhitespace(cursor, input.end);
  if (cursor >= input.end) return false;
  const char* start = cursor;
  if (*cursor == '"') {
    cursor++;
    bool escaped = false;
    while (cursor < input.end) {
      char character = *cursor++;
      if (escaped) {
        escaped = false;
      } else if (character == '\\') {
        escaped = true;
      } else if (character == '"') {
        output = { start, cursor };
        return true;
      }
    }
    return false;
  }
  if (*cursor == '{' || *cursor == '[') {
    char opening = *cursor;
    char closing = opening == '{' ? '}' : ']';
    uint8_t depth = 0;
    bool inString = false;
    bool escaped = false;
    while (cursor < input.end) {
      char character = *cursor++;
      if (inString) {
        if (escaped) escaped = false;
        else if (character == '\\') escaped = true;
        else if (character == '"') inString = false;
        continue;
      }
      if (character == '"') {
        inString = true;
      } else if (character == opening) {
        if (depth == 255) return false;
        depth++;
      } else if (character == closing) {
        if (depth == 0) return false;
        depth--;
        if (depth == 0) {
          output = { start, cursor };
          return true;
        }
      }
    }
    return false;
  }
  while (cursor < input.end && *cursor != ',' && *cursor != '}' && *cursor != ']' && *cursor != ' ' && *cursor != '\t' && *cursor != '\r' && *cursor != '\n') cursor++;
  output = { start, cursor };
  return output.begin != output.end;
}

bool findKey(Span object, const char* key, Span& value) {
  const char* cursor = object.begin;
  while (cursor < object.end) {
    if (*cursor != '"') {
      cursor++;
      continue;
    }
    const char* previous = cursor;
    while (previous > object.begin && (previous[-1] == ' ' || previous[-1] == '\t' || previous[-1] == '\r' || previous[-1] == '\n')) previous--;
    bool couldBeKey = previous > object.begin && (previous[-1] == '{' || previous[-1] == ',');
    const char* keyStart = ++cursor;
    bool escaped = false;
    while (cursor < object.end) {
      if (escaped) {
        escaped = false;
      } else if (*cursor == '\\') {
        escaped = true;
      } else if (*cursor == '"') {
        break;
      }
      cursor++;
    }
    if (cursor >= object.end) return false;
    if (couldBeKey && sameText(keyStart, cursor - keyStart, key)) {
      cursor++;
      skipWhitespace(cursor, object.end);
      if (cursor >= object.end || *cursor != ':') return false;
      Span remainder = { cursor + 1, object.end };
      return valueSpan(remainder, value);
    }
    cursor++;
  }
  return false;
}

bool readUnsigned(Span value, uint32_t& output) {
  const char* cursor = value.begin;
  skipWhitespace(cursor, value.end);
  if (cursor >= value.end) return false;
  uint32_t result = 0;
  bool foundDigit = false;
  while (cursor < value.end && *cursor >= '0' && *cursor <= '9') {
    foundDigit = true;
    uint8_t digit = *cursor++ - '0';
    if (result > (0xFFFFFFFFUL - digit) / 10UL) return false;
    result = result * 10UL + digit;
  }
  skipWhitespace(cursor, value.end);
  if (cursor != value.end || !foundDigit) return false;
  output = result;
  return true;
}

bool readBoolean(Span value, bool& output) {
  const char* cursor = value.begin;
  skipWhitespace(cursor, value.end);
  const char* start = cursor;
  while (cursor < value.end && *cursor != ' ' && *cursor != '\t' && *cursor != '\r' && *cursor != '\n') cursor++;
  const char* finish = cursor;
  skipWhitespace(cursor, value.end);
  if (cursor != value.end) return false;
  if (sameText(start, finish - start, "true")) output = true;
  else if (sameText(start, finish - start, "false")) output = false;
  else return false;
  return true;
}

bool readColor(Span value, uint32_t& output) {
  char color[8];
  if (!readJsonString(value, color, sizeof(color)) || color[0] != '#' || strlen(color) != 7) return false;
  for (uint8_t index = 1; index < 7; index++) if (!isHex(color[index])) return false;
  output = ((uint32_t)hexValue(color[1]) << 20) | ((uint32_t)hexValue(color[2]) << 16) | ((uint32_t)hexValue(color[3]) << 12) | ((uint32_t)hexValue(color[4]) << 8) | ((uint32_t)hexValue(color[5]) << 4) | hexValue(color[6]);
  return true;
}

bool readBuzzer(Span value, BuzzerMode& output) {
  char buzzer[8];
  if (!readJsonString(value, buzzer, sizeof(buzzer))) return false;
  if (strcmp(buzzer, "none") == 0) output = BUZZER_NONE;
  else if (strcmp(buzzer, "once") == 0) output = BUZZER_ONCE;
  else if (strcmp(buzzer, "repeat") == 0) output = BUZZER_REPEAT;
  else return false;
  return true;
}

bool readText(Span object, const char* key, char* output, size_t outputSize) {
  Span value;
  return findKey(object, key, value) && readJsonString(value, output, outputSize);
}

bool parseStage(Span object, Stage& output) {
  Span value;
  if (!findKey(object, "threshold", value) || !readUnsigned(value, output.threshold)) return false;
  if (!findKey(object, "color", value) || !readColor(value, output.color)) return false;
  output.blink = false;
  if (findKey(object, "blink", value) && !readBoolean(value, output.blink)) return false;
  if (!findKey(object, "buzzer", value) || !readBuzzer(value, output.buzzer)) return false;
  return true;
}

bool parseStages(Span array, Stage* output, uint8_t& count) {
  if (array.begin >= array.end || *array.begin != '[' || array.end[-1] != ']') return false;
  const char* cursor = array.begin + 1;
  const char* end = array.end - 1;
  uint8_t parsed = 0;
  while (true) {
    skipWhitespace(cursor, end);
    if (cursor > end) return false;
    if (cursor == end || *cursor == ']') break;
    if (*cursor != '{' || parsed >= MAX_STAGES) return false;
    Span item;
    if (!valueSpan({ cursor, end }, item) || !parseStage(item, output[parsed])) return false;
    parsed++;
    cursor = item.end;
    skipWhitespace(cursor, end);
    if (cursor < end && *cursor == ',') {
      cursor++;
      skipWhitespace(cursor, end);
      if (cursor >= end) return false;
      continue;
    }
    if (cursor == end || (cursor < end && *cursor == ']')) break;
    return false;
  }
  if (parsed < 3 || parsed > MAX_STAGES) return false;
  count = parsed;
  return true;
}

bool parseConfiguration(Span message, Stage* parsedStages, uint8_t& parsedCount, uint32_t& parsedDuration) {
  Span preset;
  if (!findKey(message, "preset", preset) || *preset.begin != '{') return false;
  Span value;
  if (!findKey(preset, "duration", value) || !readUnsigned(value, parsedDuration) || parsedDuration == 0) return false;
  Span stageArray;
  if (!findKey(preset, "stages", stageArray) || !parseStages(stageArray, parsedStages, parsedCount)) return false;
  for (uint8_t index = 0; index < parsedCount; index++) {
    if (parsedStages[index].threshold >= parsedDuration) return false;
    if (index > 0 && parsedStages[index].threshold <= parsedStages[index - 1].threshold) return false;
  }
  return true;
}

bool parseAction(Span message, char* action, size_t actionSize) {
  Span value;
  return findKey(message, "action", value) && readJsonString(value, action, actionSize);
}

bool getRequestId(Span message, char* output, size_t outputSize) {
  Span value;
  if (!findKey(message, "requestId", value)) return false;
  if (!readJsonString(value, output, outputSize)) return false;
  for (size_t index = 0; output[index] != '\0'; index++) {
    if (!((output[index] >= 'a' && output[index] <= 'z') || (output[index] >= 'A' && output[index] <= 'Z') || (output[index] >= '0' && output[index] <= '9') || output[index] == '-')) return false;
  }
  return true;
}

void printJsonString(const char* value) {
  Serial.print('"');
  while (*value) {
    if (*value == '"' || *value == '\\') Serial.print('\\');
    Serial.print(*value++);
  }
  Serial.print('"');
}

void sendError(const char* message, const char* requestId = nullptr) {
  Serial.print(F("{\"version\":1,\"type\":\"error\""));
  if (requestId && requestId[0]) {
    Serial.print(F(",\"requestId\":"));
    printJsonString(requestId);
  }
  Serial.print(F(",\"message\":"));
  printJsonString(message);
  Serial.println('}');
}

void sendAck(const char* requestId, const char* command) {
  Serial.print(F("{\"version\":1,\"type\":\"ack\""));
  if (requestId && requestId[0]) {
    Serial.print(F(",\"requestId\":"));
    printJsonString(requestId);
  }
  Serial.print(F(",\"command\":"));
  printJsonString(command);
  Serial.println('}');
}

void sendReady() {
  Serial.println(F("{\"version\":1,\"type\":\"ready\",\"device\":\"timelight-arduino\",\"firmware\":\"0.1.0\"}"));
}

const char* stateName() {
  if (timerState == RUNNING) return "running";
  if (timerState == PAUSED) return "paused";
  return "idle";
}

uint32_t elapsedMillis() {
  if (timerState == RUNNING) return accumulatedMillis + (millis() - runStartedMillis);
  return accumulatedMillis;
}

uint32_t elapsedSeconds() {
  return elapsedMillis() / 1000UL;
}

void setStripColor(uint32_t color) {
  uint32_t stageColor = pixel.Color((color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF);
  for (uint16_t index = 0; index < LED_COUNT; index++) pixel.setPixelColor(index, stageColor);
  pixel.show();
  displayedColor = color;
}

uint8_t blendChannel(uint8_t start, uint8_t target, uint16_t elapsed) {
  int16_t difference = (int16_t)target - start;
  return start + ((int32_t)difference * elapsed) / COLOR_TRANSITION_MS;
}

void updateColorTransition() {
  if (!colorTransitionActive) return;

  uint32_t now = millis();
  uint32_t elapsed = now - transitionStartedMillis;
  if (elapsed >= COLOR_TRANSITION_MS) {
    setStripColor(transitionTargetColor);
    colorTransitionActive = false;
    return;
  }
  if (now - lastTransitionFrameMillis < COLOR_TRANSITION_FRAME_MS) return;
  lastTransitionFrameMillis = now;

  uint8_t red = blendChannel((transitionStartColor >> 16) & 0xFF, (transitionTargetColor >> 16) & 0xFF, elapsed);
  uint8_t green = blendChannel((transitionStartColor >> 8) & 0xFF, (transitionTargetColor >> 8) & 0xFF, elapsed);
  uint8_t blue = blendChannel(transitionStartColor & 0xFF, transitionTargetColor & 0xFF, elapsed);
  setStripColor(((uint32_t)red << 16) | ((uint32_t)green << 8) | blue);
}

void startColorTransition(uint32_t target) {
  if (target == displayedColor) return;
  transitionStartColor = displayedColor;
  transitionTargetColor = target;
  transitionStartedMillis = millis();
  lastTransitionFrameMillis = transitionStartedMillis;
  colorTransitionActive = true;
}

void updateBlink() {
  if (timerState != RUNNING || !stages[currentStage].blink || colorTransitionActive || stages[currentStage].color == 0) return;
  startColorTransition(displayedColor == 0 ? stages[currentStage].color : 0);
}

void showStage(bool notify, bool transition) {
  uint32_t color = stages[currentStage].color;
  if (transition && color != displayedColor) {
    // Continue smoothly from the currently displayed color if stages are
    // advanced again before the previous transition has finished.
    updateColorTransition();
    startColorTransition(color);
  } else {
    colorTransitionActive = false;
    setStripColor(color);
  }
  nextBuzzerMillis = 0;
  if (!notify) return;
  if (stages[currentStage].buzzer == BUZZER_ONCE) tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS);
  if (stages[currentStage].buzzer == BUZZER_REPEAT) {
    tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS);
    nextBuzzerMillis = millis() + BUZZER_DELAY_MS;
  }
}

void updateStage() {
  uint32_t elapsed = elapsedSeconds();
  // Stage changes are one-way during a timer run. This also preserves a
  // manually advanced stage until elapsed time reaches the next threshold.
  uint8_t target = currentStage;
  while (target + 1 < stageCount && elapsed >= stages[target + 1].threshold) target++;
  if (target != currentStage) {
    currentStage = target;
    showStage(true, true);
  }
}

void updateBuzzer() {
  if (timerState != RUNNING || stages[currentStage].buzzer != BUZZER_REPEAT || nextBuzzerMillis == 0) return;
  if ((int32_t)(millis() - nextBuzzerMillis) >= 0) {
    tone(BUZZER_PIN, 2400, BUZZER_DURATION_MS);
    nextBuzzerMillis = millis() + BUZZER_DELAY_MS;
  }
}

void sendStatus() {
  Serial.print(F("{\"version\":1,\"type\":\"status\",\"state\":"));
  printJsonString(stateName());
  Serial.print(F(",\"elapsed\":"));
  Serial.print(elapsedSeconds());
  Serial.print(F(",\"stage\":"));
  Serial.print(currentStage);
  Serial.println('}');
}

void resetTimer() {
  timerState = IDLE;
  noTone(BUZZER_PIN);
  accumulatedMillis = 0;
  currentStage = 0;
  colorTransitionActive = false;
  setStripColor(0);
}

bool controlTimer(const char* action) {
  if (strcmp(action, "start") == 0) {
    if (timerState != IDLE) return false;
    accumulatedMillis = 0;
    currentStage = 0;
    runStartedMillis = millis();
    timerState = RUNNING;
    showStage(false, false);
    return true;
  }
  if (strcmp(action, "pause") == 0) {
    if (timerState != RUNNING) return false;
    accumulatedMillis += millis() - runStartedMillis;
    timerState = PAUSED;
    nextBuzzerMillis = 0;
    return true;
  }
  if (strcmp(action, "resume") == 0) {
    if (timerState != PAUSED) return false;
    runStartedMillis = millis();
    timerState = RUNNING;
    return true;
  }
  if (strcmp(action, "reset") == 0) {
    resetTimer();
    return true;
  }
  if (strcmp(action, "advance") == 0) {
    if (timerState == IDLE) return false;
    if (currentStage + 1 < stageCount) currentStage++;
    showStage(true, true);
    return true;
  }
  return false;
}

void handleMessage() {
  inputBuffer[inputLength] = '\0';
  Span message = { inputBuffer, inputBuffer + inputLength };
  char requestId[41] = "";
  bool hasRequestId = getRequestId(message, requestId, sizeof(requestId));
  Span versionValue;
  uint32_t version = 0;
  if (!findKey(message, "version", versionValue) || !readUnsigned(versionValue, version) || version != 1) {
    sendError("Unsupported protocol version", hasRequestId ? requestId : nullptr);
    return;
  }

  char type[16];
  if (!readText(message, "type", type, sizeof(type))) {
    sendError("Missing message type", hasRequestId ? requestId : nullptr);
    return;
  }

  if (strcmp(type, "configure") == 0) {
    Stage parsedStages[MAX_STAGES];
    uint8_t parsedCount = 0;
    uint32_t parsedDuration = 0;
    if (!parseConfiguration(message, parsedStages, parsedCount, parsedDuration)) {
      sendError("Invalid preset configuration", hasRequestId ? requestId : nullptr);
      return;
    }
    memcpy(stages, parsedStages, sizeof(stages));
    stageCount = parsedCount;
    durationSeconds = parsedDuration;
    resetTimer();
    sendAck(hasRequestId ? requestId : nullptr, "configure");
    sendStatus();
    return;
  }

  if (strcmp(type, "timer") == 0) {
    char action[12];
    if (!parseAction(message, action, sizeof(action))) {
      sendError("Missing timer action", hasRequestId ? requestId : nullptr);
      return;
    }
    if (!controlTimer(action)) {
      sendError("Timer action is not valid in the current state", hasRequestId ? requestId : nullptr);
      return;
    }
    sendAck(hasRequestId ? requestId : nullptr, "timer");
    sendStatus();
    return;
  }

  sendError("Unsupported message type", hasRequestId ? requestId : nullptr);
}

void readSerial() {
  while (Serial.available() > 0) {
    char character = (char)Serial.read();
    if (character == '\r') continue;
    if (character == '\n') {
      if (inputOverflow) sendError("Message too long");
      else if (inputLength > 0) handleMessage();
      inputLength = 0;
      inputOverflow = false;
      continue;
    }
    if (inputLength + 1 >= RX_BUFFER_SIZE) {
      inputOverflow = true;
      continue;
    }
    inputBuffer[inputLength++] = character;
  }
}

bool buttonPressed(ButtonState& button) {
  bool reading = digitalRead(button.pin);
  uint32_t now = millis();
  if (reading != button.lastReading) {
    button.lastDebounceMillis = now;
    button.lastReading = reading;
  }
  if (now - button.lastDebounceMillis < BUTTON_DEBOUNCE_MS) return false;
  if (reading == button.stableReading) return false;
  button.stableReading = reading;
  return reading == LOW;
}

void handleButtons() {
  if (buttonPressed(playPauseButton)) {
    const char* action = timerState == RUNNING ? "pause" : timerState == PAUSED ? "resume" : "start";
    if (controlTimer(action)) sendStatus();
  }
  if (buttonPressed(nextStageButton)) {
    if (controlTimer("advance")) sendStatus();
  }
}

void setup() {
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(PLAY_PAUSE_BUTTON_PIN, INPUT_PULLUP);
  pinMode(NEXT_STAGE_BUTTON_PIN, INPUT_PULLUP);
  playPauseButton.lastReading = playPauseButton.stableReading = digitalRead(PLAY_PAUSE_BUTTON_PIN);
  nextStageButton.lastReading = nextStageButton.stableReading = digitalRead(NEXT_STAGE_BUTTON_PIN);
  pixel.begin();
  pixel.setBrightness(80);
  pixel.clear();
  pixel.show();
  Serial.begin(BAUD_RATE);
  delay(50);
  sendReady();
}

void loop() {
  readSerial();
  handleButtons();
  if (timerState == RUNNING) updateStage();
  updateColorTransition();
  updateBlink();
  updateBuzzer();
  if (millis() - lastStatusMillis >= STATUS_INTERVAL_MS) {
    lastStatusMillis = millis();
    sendStatus();
  }
}
