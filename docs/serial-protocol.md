# TimeLight serial protocol v3

Protocol v3 supports two exclusive owners. A browser session is authoritative whenever its lease is active; otherwise firmware 0.4.0 can run one EEPROM-backed preset locally. Older v3 firmware remains compatible for browser-owned timing but does not advertise standalone storage.

Messages are compact, newline-delimited UTF-8 JSON at 115200 baud (8-N-1). Commands carry a `requestId`; the browser retries an unacknowledged request twice after 500 ms, using the same command content. The controller acknowledges with `{"version":3,"type":"ack","requestId":"...","appliedRevision":12}` or returns an `error` with the same request ID.

## Handshake and ownership

The browser sends `hello` every 250 ms for up to eight seconds:

```json
{"version":3,"requestId":"...","type":"hello","sessionId":"browser-session-id"}
```

A valid hello immediately cancels standalone timing, turns outputs off, establishes a three-second browser lease, and returns:

```json
{"version":3,"type":"ready","requestId":"...","device":"timelight-arduino","firmware":"0.4.0","ledCount":116,"buttons":["play_pause","next_stage","reset"],"capabilities":["standalone-preset"]}
```

The browser sends session-bound `keepalive` once per second. Every valid session command renews the lease. `release_control` immediately releases a manual disconnect:

```json
{"version":3,"requestId":"...","type":"release_control","sessionId":"browser-session-id"}
```

Release or lease expiry clears volatile timer state and turns LEDs, animation, and sound off. On unexpected expiry the controller emits an unsolicited `ready`, allowing an open page to handshake again. Boot also emits unsolicited `ready`; a connected browser responds by re-handshaking and sending its current output snapshot. `ping` returns `pong` and an acknowledgement.

## Browser output commands

`set_outputs` remains the complete declarative browser-owned output snapshot. Revisions deduplicate retries. Effects are `off`, `solid`, or `blink`; animation is `playing` or `paused`; buzzer mode is `none` or `repeat`. A newly commanded color may transition for up to 5000 ms. Blink and transitions run on the controller, and paused animation freezes the rendered frame.

```json
{"version":3,"requestId":"...","type":"set_outputs","sessionId":"browser-session-id","revision":12,"color":"#ff0000","ledEffect":"blink","transitionMs":1000,"animationState":"playing","buzzerMode":"repeat","leaseMs":3000}
```

One-shot chimes remain retry-safe through a session-scoped event ID:

```json
{"version":3,"requestId":"...","type":"buzz_once","sessionId":"browser-session-id","eventId":"run-id:stage-index"}
```

## Standalone preset storage

Only controllers whose `ready.capabilities` contains `standalone-preset` accept `store_preset`. It is acknowledged, session-bound, and contains only timing/output data. Stage count is 3–5, thresholds are strictly increasing and below duration, colors are six-digit CSS hex values, and buzzer is `none`, `once`, or `repeat`.

```json
{"version":3,"requestId":"...","type":"store_preset","sessionId":"browser-session-id","duration":180,"stages":[[0,"#0000ff",false,"none"],[60,"#ffff00",false,"once"],[120,"#ff0000",true,"repeat"]]}
```

Each compact stage tuple is `[threshold, color, blink, buzzer]`. This bounded representation keeps the complete five-stage command within the Nano's receive buffer without taking memory needed by the LED strip.

Only this explicit command writes EEPROM. Save and Connect do not. Firmware stores fixed-width data in alternating versioned slots with monotonic sequence numbers and checksums, committing the magic marker last. It loads the newest valid slot at boot and uses the compiled four-stage default if both slots are empty or corrupt. Elapsed time, current stage, and pause state are never stored. Storing while connected resets any dormant standalone run without changing current browser-owned outputs.

## Buttons and standalone behavior

During a browser lease, controls only produce sequenced events: `play_pause`, `next_stage`, or `reset`. Reset is emitted when Next is held for three seconds; a short Next is emitted on release, so a long hold never advances first. The website routes all three through its timer reducer.

Without a browser owner, Play/Pause starts at stage 1, pauses while preserving elapsed time and the exact light frame, and resumes. Thresholds automatically select colors, blinking, one-shot chimes, and repeating alerts; the final stage continues indefinitely. Short Next while running or paused anchors elapsed time at the next stage threshold. It renders that stage immediately, stays paused when applicable, and does nothing while idle or final. Holding Next for three seconds resets and turns every output off immediately.

Runtime state always boots idle/off. Connecting mid-run cancels standalone operation. After manual release or a three-second unexpected-loss timeout, the device is idle/off and the stored preset can be started locally again.
