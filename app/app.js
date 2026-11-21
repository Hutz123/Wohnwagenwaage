'use strict';

// BLE-Protokoll, muss zu firmware/waage/waage.ino passen
const SVC_UUID = '6f1a0001-3c2b-4d5e-8f90-a1b2c3d4e5f6';
const TILT_UUID = '6f1a0002-3c2b-4d5e-8f90-a1b2c3d4e5f6';
const CTRL_UUID = '6f1a0003-3c2b-4d5e-8f90-a1b2c3d4e5f6';
const CMD_SET_ZERO = 0x01;
const CMD_CLEAR_ZERO = 0x02;
const FLAG_STABLE = 0x01;
const FLAG_ZERO_SET = 0x02;

const ZERO_DURATION_MS = 4500;     // Firmware mittelt 3 s, plus Reserve
const DETECT_THRESHOLD_DEG = 1.0;  // so weit muss die Deichsel für die Lageerkennung kippen
const DETECT_TIMEOUT_MS = 60000;
const DIAGRAM_GAIN = 4;            // Neigung in der Grafik überhöht darstellen
const DIAGRAM_MAX_DEG = 15;

const DEMO = new URLSearchParams(location.search).has('demo');

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'waage.settings';
const DEFAULTS = { track: 1800, hitch: null, tolerance: 3, forward: '+x', forwardDetected: false };

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ohne Speicher gelten die Werte nur bis zum Neuladen
  }
}

let settings = loadSettings();

// ---------------------------------------------------------------------------
// Einbaulage: welche Sensorachse zeigt nach vorne (zur Deichsel).
// Bei Bauteilseite oben liegt "links" 90° gegen den Uhrzeigersinn davon.
// ---------------------------------------------------------------------------
const LEFT_OF = { '+x': '+y', '+y': '-x', '-x': '-y', '-y': '+x' };

function elevation(axis, m) {
  const v = axis[1] === 'x' ? m.x : m.y;
  return axis[0] === '-' ? -v : v;
}

// ---------------------------------------------------------------------------
// Sensor-Verbindung
// ---------------------------------------------------------------------------
function parseTilt(view) {
  return {
    x: view.getInt16(0, true) / 100,
    y: view.getInt16(2, true) / 100,
    stable: (view.getUint8(4) & FLAG_STABLE) !== 0,
    zeroSet: (view.getUint8(4) & FLAG_ZERO_SET) !== 0,
  };
}

class BleSensor {
  constructor(onData, onState) {
    this.onData = onData;
    this.onState = onState;
    this.device = null;
    this.tilt = null;
    this.ctrl = null;
    this.userDisconnect = false;
    this.handleValue = (e) => this.onData(parseTilt(e.target.value));
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC_UUID] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    this.userDisconnect = false;
    await this.open();
  }

  async open() {
    this.onState('connecting');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SVC_UUID);
    this.tilt = await svc.getCharacteristic(TILT_UUID);
    this.ctrl = await svc.getCharacteristic(CTRL_UUID);
    this.tilt.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.tilt.addEventListener('characteristicvaluechanged', this.handleValue);
    await this.tilt.startNotifications();
    this.onState('connected');
  }

  async handleDisconnect() {
    if (this.userDisconnect) {
      this.onState('disconnected');
      return;
    }
    // Verbindung abgerissen: einige Male still neu versuchen
    for (let attempt = 0; attempt < 8; attempt++) {
      this.onState('reconnecting');
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
      if (this.userDisconnect) break;
      try {
        await this.open();
        return;
      } catch {
        // nächster Versuch
      }
    }
    this.onState('disconnected');
  }

  async send(cmd) {
    await this.ctrl.writeValueWithResponse(Uint8Array.of(cmd));
  }

  disconnect() {
    this.userDisconnect = true;
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    else this.onState('disconnected');
  }
}

// Simulierter Sensor für Tests ohne Hardware (index.html?demo)
class DemoSensor {
  constructor(onData, onState) {
    this.onData = onData;
    this.onState = onState;
    this.offset = { x: 0, y: 0 };
    this.zeroSet = false;
    this.zeroUntil = 0;
  }

  raw(t) {
    return {
      x: 1.2 + 0.8 * Math.sin(t / 9000) + 0.6 + (Math.random() - 0.5) * 0.02,
      y: -0.9 + 1.1 * Math.sin(t / 6000) + 0.4 + (Math.random() - 0.5) * 0.02,
    };
  }

  async connect() {
    this.onState('connected');
    this.timer = setInterval(() => {
      const t = Date.now();
      const r = this.raw(t);
      if (this.zeroUntil && t >= this.zeroUntil) {
        this.offset = r;
        this.zeroSet = true;
        this.zeroUntil = 0;
      }
      this.onData({
        x: r.x - this.offset.x,
        y: r.y - this.offset.y,
        stable: Math.abs(Math.cos(t / 6000)) < 0.6,
        zeroSet: this.zeroSet,
      });
    }, 200);
  }

  async send(cmd) {
    this.offset = { x: 0, y: 0 };
    this.zeroSet = false;
    this.zeroUntil = cmd === CMD_SET_ZERO ? Date.now() + 3000 : 0;
  }

  disconnect() {
    clearInterval(this.timer);
    this.onState('disconnected');
  }
}

// ---------------------------------------------------------------------------
// Oberfläche
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fmtMm = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const fmtDeg = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rad = (deg) => (deg * Math.PI) / 180;
const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));

let sensor = null;
let latest = null;
let wakeLock = null;
let detect = null;      // laufende Lageerkennung
let draftForward = null; // im Einstellungsdialog erkannte, noch nicht gespeicherte Lage

function onState(state) {
  const status = $('status');
  const labels = {
    connecting: 'Verbinde …',
    connected: 'Verbunden',
    reconnecting: 'Verbindung verloren …',
    disconnected: 'Nicht verbunden',
  };
  status.textContent = labels[state];
  status.classList.toggle('on', state === 'connected');

  const live = state !== 'disconnected';
  $('connectView').hidden = live;
  $('liveView').hidden = !live;
  $('btnDetect').disabled = state !== 'connected';
  $('btnZero').disabled = state !== 'connected';
  $('btnClearZero').disabled = state !== 'connected';

  if (state === 'connected') requestWakeLock();
  if (state === 'disconnected') {
    latest = null;
    releaseWakeLock();
  }
}

function onData(m) {
  latest = m;
  if (detect) checkDetect(m);
  render(m);
}

function render(m) {
  const forward = settings.forward;
  const front = elevation(forward, m);        // > 0: vorne höher
  const leftUp = elevation(LEFT_OF[forward], m); // > 0: links höher
  const tol = settings.tolerance;

  // Schritt 1: Querneigung -> tiefer liegendes Rad unterbauen
  const hRoll = settings.track * Math.sin(rad(Math.abs(leftUp)));
  const rollAction = $('rollAction');
  const lowSide = leftUp > 0 ? 'rechts' : 'links';
  if (hRoll <= tol) {
    rollAction.textContent = 'Waagerecht ✓';
    rollAction.className = 'action ok';
  } else {
    rollAction.textContent = `Rad ${lowSide} ${fmtMm.format(hRoll)} mm unterbauen`;
    rollAction.className = 'action';
  }
  $('rollAngle').textContent = Math.abs(leftUp) < 0.005
    ? '0,00°'
    : `${fmtDeg.format(Math.abs(leftUp))}° · ${leftUp > 0 ? 'links' : 'rechts'} höher`;
  // Grafik um den Aufstandspunkt des tieferen Rads kippen, das bleibt am Boden
  const pivotX = leftUp > 0 ? 230 : 70;
  $('rearBody').setAttribute('transform', `rotate(${clamp(leftUp * DIAGRAM_GAIN, DIAGRAM_MAX_DEG)} ${pivotX} 106)`);
  $('wheelLeft').classList.toggle('raise', hRoll > tol && lowSide === 'links');
  $('wheelRight').classList.toggle('raise', hRoll > tol && lowSide === 'rechts');

  // Schritt 2: Längsneigung -> Deichsel über das Stützrad korrigieren
  const pitchAction = $('pitchAction');
  if (settings.hitch) {
    const hPitch = settings.hitch * Math.sin(rad(Math.abs(front)));
    if (hPitch <= tol) {
      pitchAction.textContent = 'Waagerecht ✓';
      pitchAction.className = 'action ok';
    } else {
      pitchAction.textContent = `Deichsel ${fmtMm.format(hPitch)} mm ${front > 0 ? 'absenken' : 'anheben'}`;
      pitchAction.className = 'action';
    }
  } else if (Math.abs(front) < 0.1) {
    pitchAction.textContent = 'Waagerecht ✓';
    pitchAction.className = 'action ok';
  } else {
    pitchAction.textContent = `Vorne ${front > 0 ? 'höher' : 'tiefer'}`;
    pitchAction.className = 'action neutral';
  }
  $('pitchAngle').textContent = Math.abs(front) < 0.005
    ? '0,00°'
    : `${fmtDeg.format(Math.abs(front))}° · vorne ${front > 0 ? 'höher' : 'tiefer'}`;
  $('sideBody').setAttribute('transform', `rotate(${clamp(front * DIAGRAM_GAIN, DIAGRAM_MAX_DEG)} 210 106)`);

  $('stability').textContent = m.stable ? 'Messwert ruhig' : 'Fahrzeug bewegt sich – Wert wartet auf Ruhe …';

  const notices = [];
  if (!m.zeroSet) notices.push('Nullpunkt noch nicht gesetzt: Die Werte enthalten den Montagefehler des Sensors.');
  if (!settings.forwardDetected) notices.push('Einbaulage noch nicht erkannt: Links/rechts und vorne/hinten können vertauscht sein.');
  const notice = $('notice');
  notice.hidden = notices.length === 0;
  notice.textContent = notices.join(' ') + (notices.length ? ' → Einstellungen' : '');
}

// ---------------------------------------------------------------------------
// Bildschirm anlassen, solange gemessen wird
// ---------------------------------------------------------------------------
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && latest) requestWakeLock();
});

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
function describeOrientation(forward, detected) {
  if (!detected) return 'Noch nicht erkannt.';
  return `Erkannt: Sensorachse ${forward.toUpperCase()} zeigt nach vorne.`;
}

function openSettings() {
  $('track').value = settings.track;
  $('hitch').value = settings.hitch ?? '';
  $('tolerance').value = settings.tolerance;
  draftForward = null;
  $('orientationText').textContent = describeOrientation(settings.forward, settings.forwardDetected);
  $('detectHint').hidden = true;
  $('zeroHint').hidden = true;
  $('settings').showModal();
}

function startDetect() {
  if (!latest) return;
  const hint = $('detectHint');
  hint.hidden = false;
  hint.textContent = 'Jetzt die Deichsel langsam etwas anheben (oder den Sensor vorne anheben) …';
  detect = {
    base: { x: latest.x, y: latest.y },
    timeout: setTimeout(() => {
      detect = null;
      hint.textContent = 'Keine Bewegung erkannt. Bitte erneut versuchen.';
    }, DETECT_TIMEOUT_MS),
  };
}

function checkDetect(m) {
  const dx = m.x - detect.base.x;
  const dy = m.y - detect.base.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < DETECT_THRESHOLD_DEG) return;
  clearTimeout(detect.timeout);
  detect = null;
  draftForward = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? '+x' : '-x') : (dy > 0 ? '+y' : '-y');
  $('orientationText').textContent = describeOrientation(draftForward, true);
  $('detectHint').textContent = 'Erkannt. Deichsel wieder absenken und „Speichern“ drücken.';
}

async function setZero() {
  if (!confirm('Steht das Fahrzeug exakt waagerecht? Der Sensor misst danach 3 Sekunden – bitte nicht bewegen.')) return;
  const hint = $('zeroHint');
  hint.hidden = false;
  hint.textContent = 'Messe … bitte nicht bewegen.';
  try {
    await sensor.send(CMD_SET_ZERO);
    await new Promise((r) => setTimeout(r, ZERO_DURATION_MS));
    hint.textContent = latest?.zeroSet
      ? 'Nullpunkt gespeichert.'
      : 'Nullpunkt wurde nicht übernommen. Ist der Sensor mehr als 60° schief montiert?';
  } catch (e) {
    hint.textContent = `Fehler: ${e.message}`;
  }
}

async function clearZero() {
  const hint = $('zeroHint');
  hint.hidden = false;
  try {
    await sensor.send(CMD_CLEAR_ZERO);
    hint.textContent = 'Nullpunkt gelöscht.';
  } catch (e) {
    hint.textContent = `Fehler: ${e.message}`;
  }
}

$('settingsForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const hitch = parseFloat($('hitch').value);
  settings.track = parseFloat($('track').value);
  settings.hitch = hitch > 0 ? hitch : null;
  settings.tolerance = parseFloat($('tolerance').value);
  if (draftForward) {
    settings.forward = draftForward;
    settings.forwardDetected = true;
  }
  saveSettings();
  if (latest) render(latest);
});

$('settings').addEventListener('close', () => {
  if (detect) {
    clearTimeout(detect.timeout);
    detect = null;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
$('btnSettings').addEventListener('click', openSettings);
$('btnDetect').addEventListener('click', startDetect);
$('btnZero').addEventListener('click', setZero);
$('btnClearZero').addEventListener('click', clearZero);
$('btnDisconnect').addEventListener('click', () => sensor?.disconnect());

$('btnConnect').addEventListener('click', async () => {
  sensor = DEMO ? new DemoSensor(onData, onState) : new BleSensor(onData, onState);
  try {
    await sensor.connect();
  } catch (e) {
    onState('disconnected');
    if (e.name !== 'NotFoundError') $('connectHint').textContent = `Verbindung fehlgeschlagen: ${e.message}`;
  }
});

if (!DEMO && !navigator.bluetooth) {
  $('noBluetooth').hidden = false;
  $('btnConnect').disabled = true;
}
if (DEMO) $('connectHint').textContent = 'Demo-Modus: simulierte Messwerte.';

onState('disconnected');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
