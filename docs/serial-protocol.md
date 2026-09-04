# TimeLight serial protocol

The PWA communicates with the Arduino over a USB virtual serial port using **115200 baud, 8 data bits, no parity, and 1 stop bit**. The current hardware has a WS2812 strip on D6, a buzzer on D7, a play/pause button on D4, and a next-stage button on D5. Every message is one UTF-8 JSON object followed by `\n`. The protocol version is currently `1`.

The Arduino should read complete lines without blocking its timer, LED, buzzer, or physical-button loop. Unknown message types, invalid JSON, and invalid fields should produce an `error` response and then be discarded.

## Connection handshake

The operator starts the connection from the PWA with **Connect device**. Opening a Nano serial port may reset the board, so the PWA waits up to eight seconds for this message before treating the connection as failed:

```json
{"version":1,"type":"ready","device":"timelight-arduino","firmware":"0.1.0"}
```

The `device` and `firmware` fields are informational. The `version` and `type` fields are required.

## PWA to Arduino

Each command includes a unique `requestId`. The Arduino may acknowledge it with an `ack` message.

Configure the active preset:

```json
{"version":1,"requestId":"...","type":"configure","preset":{"name":"Four-minute speech","speaker":"Speaker name","duration":240,"stages":[{"name":"Beginning","threshold":0,"color":"#56a9ff","blink":false,"buzzer":"none"},{"name":"Time reached","threshold":180,"color":"#ff6678","blink":true,"buzzer":"repeat"}]}}
```

`duration` and each `threshold` are whole seconds from the start of the timer. Thresholds are ordered, start at zero or later, and must be less than `duration`. A preset has 3-5 stages. `buzzer` is one of `none`, `once`, or `repeat`; `color` is a six-digit CSS hex color. The optional boolean `blink` makes the light fade continuously on and off for that stage and defaults to `false` when omitted.

Control the active timer:

```json
{"version":1,"requestId":"...","type":"timer","action":"start"}
```

The valid actions are `start`, `pause`, `resume`, `reset`, and `advance`. The Arduino owns the monotonic timer clock; the browser does not send elapsed-time ticks.

## Arduino to PWA

Acknowledgement:

```json
{"version":1,"type":"ack","requestId":"...","command":"configure"}
```

Errors should identify the problem without stopping the firmware:

```json
{"version":1,"type":"error","requestId":"...","message":"Invalid stage threshold"}
```

The Arduino may periodically report timer state (recommended at 2-4 times per second):

```json
{"version":1,"type":"status","state":"running","elapsed":61,"stage":1}
```

`state` is `idle`, `running`, or `paused`. `elapsed` is whole seconds and `stage` is a zero-based stage index. Status messages are informational and do not need an acknowledgement.

While the timer is idle, the strip is off. It shows stage 1 only when a timer `start` action is accepted. The D4 button is equivalent to play/pause: it starts an idle timer, pauses a running timer, and resumes a paused timer. The D5 button is equivalent to `advance` and works while the timer is running or paused. Both buttons use the Arduino's internal pull-up and should connect their input pin to GND when pressed.

## Ownership and recovery

The PWA owns presets and sends the selected configuration. The Arduino owns timer execution, LEDs, buzzer output, and physical buttons. Disconnecting USB must leave the last valid configuration and local physical controls usable. Reconnecting requires the `ready` handshake again; the PWA retains the selected preset and sends it after the handshake.
