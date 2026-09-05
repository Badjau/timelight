# TimeLight serial protocol v4

Protocol v4 is a compact binary protocol for firmware 0.5.0. The website and controller must be upgraded together; protocol-v3 JSON firmware cannot parse v4 frames.

## Framing

Communication is 115200 baud (8-N-1). Each decoded frame contains:

| Offset | Size | Value |
| --- | ---: | --- |
| 0 | 2 | Magic bytes `54 4c` (`TL`) |
| 2 | 1 | Protocol version `04` |
| 3 | 1 | Message type |
| 4 | 4 | Unsigned request ID, little-endian; zero means unsolicited |
| 8 | 2 | Payload length, little-endian |
| 10 | n | Message payload |
| 10+n | 2 | CRC-16/MODBUS over every preceding byte |

The decoded frame is COBS-encoded and terminated by `00`. COBS provides an unambiguous frame delimiter; the length and CRC reject incomplete or corrupted frames. All multi-byte integers are unsigned and little-endian. Commands are retried twice after 500 ms with the same request ID and content.

| Code | Message | Payload |
| ---: | --- | --- |
| 1 | `hello` | session ID `u32` |
| 2 | `ready` | LED count `u16`, firmware major/minor/patch `u8x3`, button flags `u8`, capability flags `u8` |
| 3 | `ack` | applied output revision `u32` |
| 4 | `error` | error code `u8` |
| 5 | `ping` | empty |
| 6 | `pong` | empty |
| 7 | `keepalive` | session ID `u32` |
| 8 | `release_control` | session ID `u32` |
| 9 | `set_outputs` | fixed output snapshot described below |
| 10 | `buzz_once` | session ID `u32`, event ID `u32` |
| 11 | `store_preset` | compact preset described below |
| 12 | `button` | button code `u8`, sequence `u32` |

## Handshake and ownership

The browser sends `hello` every 250 ms for up to eight seconds. A valid hello cancels standalone timing, turns outputs off, claims a three-second browser lease, and receives a correlated `ready`. Boot and lease expiry send an unsolicited `ready` with request ID zero. A connected browser responds by handshaking again and restoring its current output snapshot.

The browser sends `keepalive` once per second. Every valid session command renews the lease. `release_control` releases a manual disconnect immediately. Release or lease expiry clears volatile timer state and turns every output off.

The `ready` button bits are play/pause, next stage, and reset in bits 0-2. Capability bit 0 is `standalone-preset`. Button codes 1-3 use the same order.

## Output snapshots

`set_outputs` has an 18-byte payload: session ID `u32`, revision `u32`, RGB color `u8x3`, LED effect `u8`, transition milliseconds `u16`, animation state `u8`, buzzer mode `u8`, and buzzer lease milliseconds `u16`.

LED effects are off `0`, solid `1`, and blink `2`. Animation is paused `0` or playing `1`. Browser output buzzer mode is none `0` or repeat `2`. Revisions and one-shot event IDs make retries idempotent.

## Standalone preset storage

`store_preset` contains session ID `u32`, duration seconds `u32`, stage count `u8`, followed by 3-5 eight-byte stages. Each stage contains threshold seconds `u32`, RGB `u8x3`, and flags `u8`. Flags use bits 0-1 for buzzer mode (none `0`, once `1`, repeat `2`) and bit 2 for blink.

The maximum five-stage preset payload is 49 bytes and its complete COBS wire frame is at most 63 bytes. It no longer depends on a large receive buffer or textual field lengths.

Only this explicit command writes EEPROM. Two checksummed, versioned slots protect the previous preset from an interrupted write. Runtime elapsed time, stage, and pause state remain volatile, and boot always starts idle/off.

## Diagnostics

Connection lifecycle, retries, malformed frames, and failures are logged to the browser console with a `[TimeLight serial]` prefix. To include per-frame transmit/receive summaries, run this in DevTools and reload:

```js
localStorage.setItem('timelight-serial-debug', '1')
```

Disable verbose frame logging with:

```js
localStorage.removeItem('timelight-serial-debug')
```
