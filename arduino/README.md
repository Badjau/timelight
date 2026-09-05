# TimeLight Arduino controller

`TimeLightController.ino` is the standalone-capable protocol-v3 controller (firmware 0.4.0). An active browser lease owns all timing and outputs. With no browser owner, the controller runs its stored preset from the physical buttons.

## Wiring

- WS2812 data in -> D6
- Buzzer positive -> D7, buzzer negative -> GND
- Play/pause push button -> D5 and GND
- Next-stage push button -> D4 and GND
- WS2812 power and ground -> the appropriate 5 V supply and GND
- Connect the Nano and LED ground to a common ground

`LED_COUNT` is a compile-time firmware setting and defaults to **116**. Override it in the build if the physical strip has a different length. Install the **Adafruit NeoPixel** library from the Arduino IDE's Library Manager, select the correct Nano processor/port, and upload the sketch. The PWA uses 115200 baud.

Use the editor's paper-plane Send button to write one preset to EEPROM. Save and Connect never write it. Two checksummed, versioned slots protect the previous preset from an interrupted write; boot selects the newest valid slot or the compiled default if neither is valid. Runtime elapsed time, stage, and pause state are RAM-only, and every boot starts idle with LEDs and sound off.

Offline, Play/Pause starts, pauses, and resumes. A short Next release advances and anchors the timer at the new threshold; it also works while paused without sounding an alert. Hold Next for three seconds to reset and turn everything off. The final stage runs indefinitely.

A browser `hello` immediately cancels standalone operation. While its lease is active, the buttons report events to the website and Next's three-second hold reports Reset. Manual disconnect releases ownership immediately. If USB or the page disappears unexpectedly, the controller waits for the three-second keepalive lease, then becomes idle/off and advertises `ready` so an open page can recover. Browser snapshots retain complete control of fades, blinking, and buzzers.

The complete contract is in [`../docs/serial-protocol.md`](../docs/serial-protocol.md).
