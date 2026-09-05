# TimeLight Arduino controller

`TimeLightController.ino` is a protocol-v3 circuit controller. The website owns the timer, preset snapshot, stages, elapsed time, and button decisions. The sketch only parses bounded JSON lines, renders declarative LED/buzzer effects, debounces buttons, acknowledges commands, and reports health.

## Wiring

- WS2812 data in -> D6
- Buzzer positive -> D7, buzzer negative -> GND
- Play/pause push button -> D4 and GND
- Next-stage push button -> D5 and GND
- WS2812 power and ground -> the appropriate 5 V supply and GND
- Connect the Nano and LED ground to a common ground

`LED_COUNT` is a compile-time firmware setting and defaults to **116**. Override it in the build if the physical strip has a different length. Install the **Adafruit NeoPixel** library from the Arduino IDE's Library Manager, select the correct Nano processor/port, and upload the sketch. The PWA uses 115200 baud.

The controller does not store or interpret presets, thresholds, elapsed time, or timer controls. It renders local linear RGB fades and a 700 ms fade-out/fade-in breathing waveform so USB traffic and browser paint delays do not affect LED smoothness. Animation progress is frozen while paused and resumes from the retained frame. Repeating audio is protected by a three-second lease and stops if commands/keepalives stop. Physical buttons are silent until the browser handshake is established.

The complete contract is in [`../docs/serial-protocol.md`](../docs/serial-protocol.md).
