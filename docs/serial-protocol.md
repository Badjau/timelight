# TimeLight serial protocol v2

The website is authoritative for presets, elapsed time, stages, timer state, and control decisions. The Arduino is a low-latency output renderer and button reporter. It never receives a preset, threshold, elapsed time, or start/pause/advance command.

Messages are newline-delimited UTF-8 JSON over 115200 baud, 8 data bits, no parity, and one stop bit. The current wiring is WS2812 data on D6, buzzer on D7, play/pause on D4, and next-stage on D5. The firmware default is `LED_COUNT=116`, a documented compile-time setting.

## Handshake and health

The browser sends `hello` repeatedly every 250 ms for up to eight seconds after opening a port. This handles Nano auto-reset without requiring the browser to catch the one boot message. A hello establishes the browser session; the Arduino responds to every hello with `ready`.

```json
{"version":2,"requestId":"...","type":"hello","sessionId":"browser-session-id"}
```

```json
{"version":2,"type":"ready","requestId":"...","device":"timelight-arduino","firmware":"0.2.0","ledCount":116,"buttons":["play_pause","next_stage"]}
```

The Arduino also emits `ready` after boot. A ready message received on an already-open port causes the browser to repeat the handshake and resend its current output snapshot. It does not replay old timer transitions or chimes.

`ping` produces `pong`. `keepalive` is sent once per second while connected and renews a repeating-buzzer lease. Commands that have a `requestId` are acknowledged as follows:

```json
{"version":2,"type":"ack","requestId":"...","appliedRevision":12}
```

The browser waits 500 ms and retries twice. The Arduino treats malformed or oversized lines as recoverable errors and continues its output and button loops. A v1 command receives a clear unsupported-protocol error.

## Website to Arduino

`set_outputs` is a complete declarative snapshot. Newer revisions supersede older revisions; duplicate or stale revisions are acknowledged without being applied.

```json
{"version":2,"requestId":"...","type":"set_outputs","sessionId":"browser-session-id","revision":12,"color":"#ff0000","ledEffect":"blink","transitionMs":450,"buzzerMode":"repeat","leaseMs":3000}
```

`ledEffect` is `off`, `solid`, or `blink`. `buzzerMode` is `none` or `repeat`. `leaseMs` is at most 3000 and is renewed by keepalive. If the lease expires, repeating audio is silenced while the last LED state remains.

Stage-entry one-shot alerts use a session-scoped event ID. The Arduino deduplicates recent event IDs, making retries safe:

```json
{"version":2,"requestId":"...","type":"buzz_once","sessionId":"browser-session-id","eventId":"run-id:stage-index"}
```

## Arduino to website

Debounced buttons are reported only after a browser session has been established:

```json
{"version":2,"type":"button","button":"play_pause","sequence":42}
```

`button` is `play_pause` or `next_stage`. The sequence is monotonic for the current MCU boot and the website deduplicates already-seen sequences before routing the event through the same reducer action as an on-screen control.

## Loss and recovery

The website timer continues while USB is unavailable. A lost link is shown persistently in the live timer. The browser reopens an already-authorized port with bounded backoff from 250 ms to five seconds, and the Reconnect control can close/reopen and re-handshake without a page reload. After each handshake it sends exactly the current output snapshot. Repeating audio is guaranteed to stop within the three-second lease; LEDs retain their last commanded state.

On pause, the browser sends the current stage with repeating audio disabled, so the LEDs hold their appearance. Resume restores that stage's behavior. Reset sends `off` and clears the manual stage override.
