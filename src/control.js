const $ = (id) => document.getElementById(id);
// Options are keyed by the display's id for this listing only. What gets saved is
// the display's label + bounds (main matches by label, so it survives a replug).
const MISSING = 'missing';

let state = null;
let urlTouched = false;

function render(s) {
  state = s;
  if (!urlTouched) $('url').value = s.url || '';

  // Display picker: keep the current choice, default to the first non-primary screen.
  const sel = $('display');
  const saved = s.displayId != null ? String(s.displayId) : (s.displayLabel ? MISSING : '');
  const prev = sel.dataset.touched ? sel.value : saved;
  sel.innerHTML = '';
  for (const d of s.displays) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = `${d.label} — ${d.bounds.width}×${d.bounds.height}${d.primary ? ' (main)' : ''}`;
    sel.appendChild(o);
  }
  // The saved display is unplugged: keep showing it so the choice isn't silently lost.
  if (s.displayId == null && s.displayLabel) {
    const o = document.createElement('option');
    o.value = MISSING;
    o.disabled = true;
    o.textContent = `${s.displayLabel} — not connected`;
    sel.appendChild(o);
  }
  const keys = [...sel.options].map((o) => o.value);
  if (keys.includes(prev)) sel.value = prev;
  else {
    delete sel.dataset.touched;
    const pick = s.displays.find((d) => !d.primary) || s.displays[0];
    if (pick) sel.value = String(pick.id);
  }

  for (const b of document.querySelectorAll('#bg button')) b.classList.toggle('on', b.dataset.bg === s.bg);
  $('muted').checked = !!s.muted;
  $('login').checked = !!s.openAtLogin;

  const live = !!s.live;
  $('dot').className = 'dot' + (live ? (s.error ? ' err' : ' live') : '');
  $('status').textContent = !live ? 'Off' : s.error ? s.error : s.loading ? 'Loading…' : 'Live';
  $('stop').disabled = !live;
  $('reload').disabled = !live;
  updateGo();
}

function selectedDisplay() {
  const d = state?.displays.find((x) => String(x.id) === $('display').value);
  return d ? { label: d.label, bounds: d.bounds } : undefined;
}

function updateGo() {
  const live = !!state?.live;
  const dirty = live && (
    ($('url').value.trim() && $('url').value.trim() !== state.url) ||
    $('display').value !== String(state.displayId)
  );
  $('go').textContent = !live ? 'Go Live' : dirty ? 'Update Output' : 'Live';
  $('go').classList.toggle('update', !!dirty);
  $('go').disabled = live && !dirty;
}

$('go').addEventListener('click', async () => {
  $('error').textContent = '';
  const r = await window.webOutput.start({ url: $('url').value, display: selectedDisplay(), bg: state?.bg });
  if (!r?.ok) $('error').textContent = r?.error || 'Could not open the output.';
  else { urlTouched = false; delete $('display').dataset.touched; render(await window.webOutput.get()); }
});
$('stop').addEventListener('click', () => { $('error').textContent = ''; window.webOutput.stop(); });
$('reload').addEventListener('click', () => window.webOutput.reload());
$('url').addEventListener('input', () => { urlTouched = true; updateGo(); });
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('go').disabled) $('go').click(); });
$('display').addEventListener('change', () => { $('display').dataset.touched = '1'; updateGo(); });
for (const b of document.querySelectorAll('#bg button')) {
  b.addEventListener('click', () => window.webOutput.configure({ bg: b.dataset.bg }));
}
$('muted').addEventListener('change', (e) => window.webOutput.configure({ muted: e.target.checked }));
$('login').addEventListener('change', (e) => window.webOutput.configure({ openAtLogin: e.target.checked }));

window.webOutput.onState(render);
window.webOutput.get().then(render);
