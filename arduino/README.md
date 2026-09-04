# TimeLight Arduino controller

`TimeLightController.ino` is the minimal controller firmware for the current WS2812 strip prototype.

## Wiring

- WS2812 data in -> D6
- Buzzer positive -> D7, buzzer negative -> GND
- Play/pause push button -> D4 and GND
- Next-stage push button -> D5 and GND
- WS2812 power and ground -> the appropriate 5 V supply and GND
- Connect the Nano and the LED ground to a common ground

The sketch configures a 100-pixel WS2812 strip. The PWA sends the active stage colors; the strip remains off while the timer is idle and shows the first stage only when the timer actually starts. The play/pause button on D4 starts, pauses, or resumes the timer; the next-stage button on D5 advances the active stage while the timer is running or paused. The buzzer follows its configured alert mode. In the five seconds leading up to a stage change, the strip gives a non-blocking breathing transition: the old color fades through several breaths, then the final breath rises in the new color.

Install the **Adafruit NeoPixel** library from the Arduino IDE's Library Manager, select the correct Nano processor/port, and upload the sketch. Open the serial monitor at `115200` baud only for diagnostics; the PWA uses the same speed.

The serial message contract is documented in [`../docs/serial-protocol.md`](../docs/serial-protocol.md). The sketch sends `ready` after boot, then accepts `configure` and `timer` messages. Its serial reader is line-buffered and bounded, so malformed or oversized input is rejected without blocking the timer loop.
