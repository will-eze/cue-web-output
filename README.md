# Cue Web Output

A small Windows app that puts a web page fullscreen on a chosen monitor, the same way Cue's Web Output does, without installing Cue. Useful for overlay output URLs (UNO, H2R, Singular) or Cue's Remote Output link on a machine that only drives a screen.

## Install

Download `Cue-Web-Output-Setup-<version>.exe` from [Releases](../../releases/latest) and run it. The installer isn't code-signed, so Windows SmartScreen may warn: click **More info → Run anyway**.

## Use

1. Paste the URL.
2. Pick the display.
3. Pick the background: green, blue or black key colour (shows through wherever the page is transparent), or **Page** to keep the page's own background.
4. Click **Go Live**.

The output is frameless, always on top and fullscreen. It retries every 3 seconds if the page fails to load or crashes, reopens if the monitor is unplugged and reconnected, and comes back on launch if it was live when the app last closed. Tick **Start when Windows starts** for a dedicated screen machine. Press **Esc** on the output (or **Stop** in the app) to take it down.

## Build

```
npm install
npm start        # run locally
npm run dist     # build the Windows installer into dist/
```

Pushing a `v*` tag builds the installer on GitHub Actions and attaches it to a release.
