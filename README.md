# TimeLight

TimeLight is a programmable visual timing system for speeches, presentations, debates, and other timed events.

The website owns timer state whenever it is connected: it stores preset snapshots, derives elapsed time from timestamps, selects stages, and routes screen and physical controls through one reducer. Active browser runs survive refreshes and continue beyond the configured duration in the final stage until Pause or Reset. The site remains fully usable without hardware.

The optional Arduino Nano can also run one device-owned preset when no browser session is active. The paper-plane Send action explicitly stores the current editor values—including unsaved edits—in dual checksummed EEPROM slots. Save and Connect never overwrite device memory. Timer progress remains volatile, so reset and power-up are always idle/off. Protocol v3 capability detection keeps older browser-only v3 firmware usable.

## Local development

Requires Node.js 20 or newer.

```sh
npm ci
npm run dev
```

Check the production build locally with `npm run build` and `npm run preview`; open `/timelight/` in the preview.

## Arduino connection

Use desktop Chrome or Microsoft Edge over the HTTPS production origin. A handshake gives the browser exclusive control and immediately cancels any standalone run. Manual disconnect releases the controller idle/off at once; unexpected loss does so after the three-second keepalive lease and then advertises readiness for recovery. Offline, Play/Pause starts or pauses the stored preset, short Next advances on release, and a three-second Next hold resets. During browser ownership those gestures are routed to the website instead. The default strip is 116 WS2812 LEDs on D6; the buzzer is D7, play/pause is D4, and next-stage is D5. Some Nano variants use a CH340 USB-to-serial chip and may need an operating-system driver.

See [`docs/serial-protocol.md`](docs/serial-protocol.md) and [`arduino/README.md`](arduino/README.md) for the complete protocol and upload instructions.

### Nano LED transition troubleshooting

On AVR-based Arduino Nano boards, keep color interpolation arithmetic explicitly signed. Mixing a signed negative channel difference with an unsigned elapsed-time value converts the calculation to unsigned arithmetic. The resulting overflow can make stage transitions snap to their target and can produce seemingly random LED flicker, even when power and wiring are sound.

Cast both the channel difference and elapsed time to `int32_t` before multiplying. In particular, preserve the signed pattern used by the firmware's `blend()` function. If snapping or isolated color flicker returns after animation changes, check the interpolation types before investigating the circuit. Also keep `pixel.show()` frame-paced rather than calling it continuously from the main loop.

## Offline installation and verification

1. Open <https://badjau.github.io/timelight/> in desktop Chrome or Microsoft Edge.
2. Install the PWA from the browser address bar or application menu.
3. Open it once while online, then close all TimeLight windows.
4. Disable networking and launch the installed application again.
5. Confirm the shell opens and reports **Offline · Running from the cached shell**.

The generated service worker precaches the complete build and has no runtime API cache. Updates use the service worker waiting lifecycle; an open timer is not reloaded by an update.

## Deployment

GitHub Actions builds and deploys `dist/` from `main` through the protected `github-pages` environment. Keep Pages configured to use **GitHub Actions**. Do not commit `dist/` or create a `gh-pages` branch.
