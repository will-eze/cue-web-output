// The key colour behind the output page.
//
// Painting it as the window's background and making html/body transparent is
// not enough: a page (or any iframe in it) that declares `color-scheme: dark`
// gets Chromium's dark canvas colour, rgb(18,18,18), wherever it is transparent,
// and that grey covers the key. CTV OS's overlays pages do exactly that (its
// global stylesheet sets `:root { color-scheme: dark }`), so the output came up
// grey. And an iframe whose colour scheme differs from its parent's is given an
// opaque backdrop, so iframes need the same treatment as the page.
//
// So, for a key colour: the top page gets the key painted on its root with the
// colour scheme reset, and every iframe is reset to transparent. 'page' undoes
// all of it and shows the page as it is.

const BG = { green: '#00FF00', blue: '#0000FF', black: '#000000' };
const STYLE_ID = '__cue_web_output_key__';

const topCss = (color) =>
  `:root, html { color-scheme: normal !important; background: ${color} !important; background-color: ${color} !important; }
   body { background: transparent !important; background-color: transparent !important; }`;

const FRAME_CSS = `:root, html, body { color-scheme: normal !important; background: transparent !important; background-color: transparent !important; }`;

// Runs inside a sub-frame (any origin). Adds or removes one <style> element.
const frameScript = (css) => `(() => {
  const old = document.getElementById(${JSON.stringify(STYLE_ID)});
  if (old) old.remove();
  if (${JSON.stringify(css)}) {
    const s = document.createElement('style');
    s.id = ${JSON.stringify(STYLE_ID)};
    s.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(s);
  }
})();`;

function subFrames(wc) {
  try {
    return wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame && !f.detached);
  } catch {
    return [];
  }
}

function paintFrame(frame, bg) {
  try {
    frame.executeJavaScript(frameScript(BG[bg] ? FRAME_CSS : '')).catch(() => {});
  } catch {
    /* frame went away */
  }
}

/** Apply (or, for 'page', remove) the key colour on the window, the page and every iframe. */
function applyBackground(w, bg) {
  if (!w || w.isDestroyed()) return;
  const wc = w.webContents;
  const color = BG[bg];
  w.setBackgroundColor(color || '#000000');
  const old = w._bgCssKey;
  w._bgCssKey = null;
  if (old) wc.removeInsertedCSS(old).catch(() => {});
  if (color) {
    wc.insertCSS(topCss(color))
      .then((key) => {
        if (w.isDestroyed()) return;
        // a newer call may have run while this one was in flight
        if (w._bgCssKey) wc.removeInsertedCSS(key).catch(() => {});
        else w._bgCssKey = key;
      })
      .catch(() => {});
  }
  for (const f of subFrames(wc)) paintFrame(f, bg);
}

module.exports = { BG, applyBackground, paintFrame };
