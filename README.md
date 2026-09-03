# TimeLight

## Project Summary

A programmable visual timing system designed for speech competitions, presentations, debates, and other timed events.

The system uses a stoplight-style physical display divided into **3–5 illuminated sections**, with each section representing a different stage of the allotted time. Each section is illuminated using **WS2812 addressable LEDs**, allowing its color and behavior to be configured through software.

For example, a four-stage configuration could use:

* **Blue** — beginning / safe time
* **Yellow** — approaching the target
* **Orange** — nearing the limit
* **Red** — time limit reached

An **Arduino Nano** controls the LEDs and buzzer and communicates with a computer running a **Progressive Web App (PWA)**. The web application acts as the main control interface and allows the operator to configure and run timers without modifying the Arduino firmware.

### Timer Presets

The application can store presets for different competition categories or timing rules. Each preset can define:

* Contestant or speaker name
* Timer/stage name
* Total duration
* Number of timing stages
* Time at which each stage activates
* Color assigned to each stage
* Buzzer behavior

Example preset:

* Blue — 0:00
* Yellow — 1:00
* Orange — 2:00
* Red — 3:00

When the timer starts, the first section illuminates. As each configured threshold is reached, the previous section turns off and the next section activates.

A short buzzer notification sounds whenever the timer advances to a new stage. Once the final/red stage is reached, the buzzer can sound repeatedly at a configurable interval to indicate that the speaker has exceeded or reached the maximum allotted time.

### Controls

The system can be operated primarily through the web application, with controls such as:

* Start
* Pause
* Resume
* Reset
* Manually advance to the next stage
* Select or edit presets
* View elapsed and remaining time
* Display the current contestant/speaker

The physical unit can also include one or more buttons for standalone operation. At minimum, a button could reset the timer or manually advance the current light stage, allowing the device to remain usable even without the web interface.

### Platform and Deployment Requirements

* The hardware controller is an Arduino Nano. The MCU must not host the web interface and does not require Wi-Fi.
* The control interface must be a static, installable PWA hosted using GitHub Pages.
* Operators install the PWA from its HTTPS GitHub Pages URL using a supported desktop Chromium browser, primarily Google Chrome or Microsoft Edge.
* After its first successful load, the PWA must remain fully usable without internet access. Its application shell and required assets must be cached by a service worker.
* Wi-Fi and internet access must not be required while operating a timer. Runtime communication is exclusively over USB.
* The deployment must not depend on opening a loose local `index.html` file. GitHub Pages is the canonical application origin for installation, updates, storage, and device permissions.
* Updates to the web interface are deployed by publishing a new static build to GitHub Pages. The PWA must detect and activate updated cached assets without losing locally stored presets.
* Presets and hardware settings must be stored locally in the browser. Operators must be able to export and import presets as JSON for backup and transfer between computers.

### USB Communication Requirements

* The PWA communicates with the Arduino Nano through its USB virtual serial port using the Web Serial API.
* The first connection must be initiated by an explicit **Connect Device** action so the browser can display its required serial-port permission prompt.
* The application must clearly show disconnected, connecting, connected, and communication-error states.
* Serial messages must use a documented, versioned protocol. Prefer newline-delimited JSON commands and events so messages are easy to inspect and extend.
* The default serial baud rate is `115200` unless hardware testing requires a different rate.
* Opening the serial port may reset the Arduino Nano. The PWA must wait for a firmware `ready` message before sending configuration or timer commands.
* The PWA must handle device disconnection and reconnection without losing the selected preset or current configuration.
* The firmware must reject malformed or unsupported commands without blocking its timer, button, LED, or buzzer processing loops.
* Web Serial browser support must be checked at startup. Unsupported browsers must receive a concise message directing the operator to desktop Chrome or Edge.
* Some Nano variants use USB-to-serial chips such as CH340 and may require an operating-system driver. This dependency must be documented as part of hardware setup.

### Responsibility Boundaries

* The PWA owns presets, contestant names, stage definitions, colors, thresholds, and buzzer configuration.
* The Arduino owns real-time timer execution, LED output, buzzer output, physical-button handling, and the last configuration received from the PWA.
* Once a timer has started, temporary browser rendering delays must not affect timing accuracy. The Arduino must use its own monotonic clock for active timer execution.
* Physical controls must continue to work when the PWA is disconnected.

The overall goal is to provide judges, speakers, and event organizers with an immediately understandable visual indication of timing status without requiring participants to constantly look at a clock.
