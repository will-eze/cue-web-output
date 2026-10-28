const $ = (id) => document.getElementById(id);
const boundsKey = (b) => (b ? `${b.x},${b.y},${b.width},${b.height}` : '');

let state = null;
let urlTouched = false;

function render(s) {
  state = s;
  if (!urlTouched) $('url').value = s.url || '';

  // Display picker: keep the current choice, default to the first non-primary screen.
  const sel = $('display');
  const prev = sel.value || boundsKey(s.displayBounds);
  sel.innerHTML = '';
  for (const d of s.displays) {
    const o = document.createElement('option');
    o.value = boundsKey(d.bounds);
    o.textContent = `${d.label} — ${d.bounds.width}×${d.bounds.height}${d.primary ? ' (main)' : ''}`;
    sel.appendChild(o);
  }
  const keys = s.displays.map((d) => boundsKey(d.bounds));
  if (keys.includes(prev)) sel.value = prev;
  else {
    const pick = s.displays.find((d) => !d.primary) || s.displays[0];
    if (pick) sel.value = boundsKey(pick.bounds);
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

function selectedBounds() {
  const d = state?.displays.find((x) => boundsKey(x.bounds) === $('display').value);
  return d ? d.bounds : null;
}

function updateGo() {
  const live = !!state?.live;
  const dirty = live && (
    ($('url').value.trim() && $('url').value.trim() !== state.url) ||
    $('display').value !== boundsKey(state.displayBounds)
  );
  $('go').textContent = !live ? 'Go Live' : dirty ? 'Update Output' : 'Live';
  $('go').classList.toggle('update', !!dirty);
  $('go').disabled = live && !dirty;
}

$('go').addEventListener('click', async () => {
  $('error').textContent = '';
  const r = await window.webOutput.start({ url: $('url').value, displayBounds: selectedBounds(), bg: state?.bg });
  if (!r?.ok) $('error').textContent = r?.error || 'Could not open the output.';
  else { urlTouched = false; render(await window.webOutput.get()); }
});
$('stop').addEventListener('click', () => { $('error').textContent = ''; window.webOutput.stop(); });
$('reload').addEventListener('click', () => window.webOutput.reload());
$('url').addEventListener('input', () => { urlTouched = true; updateGo(); });
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('go').disabled) $('go').click(); });
$('display').addEventListener('change', updateGo);
for (const b of document.querySelectorAll('#bg button')) {
  b.addEventListener('click', () => window.webOutput.configure({ bg: b.dataset.bg }));
}
$('muted').addEventListener('change', (e) => window.webOutput.configure({ muted: e.target.checked }));
$('login').addEventListener('change', (e) => window.webOutput.configure({ openAtLogin: e.target.checked }));

window.webOutput.onState(render);
window.webOutput.get().then(render);
