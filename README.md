# TimeLight

TimeLight is a programmable visual timing system for speeches, presentations, debates, and other timed events. The PWA configures timing presets and communicates with a future Arduino Nano controller over USB serial. The controller drives WS2812 LEDs and a buzzer while keeping timer execution accurate if the browser is busy or disconnected.

## Current milestone

The installable static PWA shell includes:

- locally stored timing presets with 3–5 configurable stages;
- reliable `MM:SS` timer inputs for total duration and stage thresholds;
- Web Serial connection and handshake with an Arduino controller;
- versioned newline-delimited JSON configuration and timer commands for a 12-pixel WS2812 strip;
- Start, pause, resume, reset, and next-stage controls;
- device connection, error, and runtime status feedback;
- offline operation after the installed shell has been opened once online.

The Arduino firmware, physical controls, preset import/export, and richer timer views are separate follow-up work. The PWA interface and protocol contract are ready for firmware integration.

## Local development

Requires Node.js 20 or newer.

```sh
npm ci
npm run dev
```

Check the production build locally with:

```sh
npm run build
npm run preview
```

The preview uses the project path, so open `/timelight/` rather than a loose local `index.html` file.

## Arduino connection

Use desktop Chrome or Microsoft Edge over the HTTPS production origin. Select **Connect device** in the Arduino controller panel and choose the Nano's USB serial port. The current hardware layout is a 12-pixel WS2812 strip on D6 and a buzzer on D7. The default connection is `115200` baud. Opening the port can reset a Nano; the PWA waits for the firmware's versioned `ready` message before sending the preset or timer commands.

The complete message contract is in [`docs/serial-protocol.md`](docs/serial-protocol.md), and Nano wiring/upload instructions are in [`arduino/README.md`](arduino/README.md). In brief, messages are UTF-8 JSON objects separated by newlines and use `version: 1`. The PWA sends `configure` and `timer` messages. The Arduino sends `ready`, `ack`, `status`, and `error` messages. The Arduino must continue its timer, LED, buzzer, and physical-button loops while parsing serial input.

Some Nano variants use a CH340 USB-to-serial chip and may need an operating-system driver. Web Serial is not available in Firefox, Safari, or most mobile browsers; the interface reports this and directs operators to desktop Chrome or Edge.

## Offline installation and verification

1. Open <https://badjau.github.io/timelight/> in desktop Chrome or Microsoft Edge.
2. Use the browser's install control in the address bar or application menu.
3. Open the installed TimeLight application once while online.
4. Disable networking, close every TimeLight window, and launch it again.
5. Confirm the shell opens and the status changes to **Offline · Running from the cached shell**.

The generated service worker precaches the complete build. There is no runtime API or runtime network cache. New builds use the service worker's waiting lifecycle: an update can download while the application is open, but it does not reload that application. Once all TimeLight windows are closed, the waiting worker can activate and the update appears on the next launch. Browser storage for future presets remains independent of these caches.

## Deployment and rollback

The canonical application origin is <https://badjau.github.io/timelight/>. GitHub Actions builds and deploys `dist/` from `main` through the protected `github-pages` environment. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

Every push to `main` and every manual workflow dispatch builds and deploys the site. The workflow uses GitHub's Pages deployment identity token; no deployment credentials belong in this repository. Do not commit `dist/` or create a `gh-pages` branch.

If a deployment fails, GitHub Pages keeps serving the previous successful release. To roll back a successful but unwanted release, revert the responsible commit and push the revert to `main`, or redeploy the desired commit from the workflow's manual dispatch.

## Responsibility boundaries

The PWA owns presets, speaker names, stage definitions, colors, thresholds, and buzzer configuration. The Arduino owns real-time timer execution, LED output, buzzer output, physical-button handling, and the last valid configuration received from the PWA. Once a timer starts, the Arduino uses its own monotonic clock; browser rendering delays must not affect timing accuracy.
