const phases = {
  CAR_IDLE: 'รถเขียว · รอรอบข้าม', CAR_WARNING: 'รถเหลือง · เตรียมหยุด',
  BEFORE_WALK: 'แดงทั้งสองฝั่ง · ก่อนเริ่มข้าม', WALK: 'คนเดินเขียว · เริ่มข้ามได้',
  PED_CLEARANCE: 'คนเดินแดงกะพริบ · รอข้ามพ้น', BEFORE_CAR: 'แดงทั้งสองฝั่ง · ก่อนคืนไฟรถ'
};

export function parseSerialLine(line) {
  const phase = [
    [/^CAR GREEN/, 'CAR_IDLE'], [/^CAR YELLOW/, 'CAR_WARNING'],
    [/^ALL RED BEFORE WALK/, 'BEFORE_WALK'], [/^PEDESTRIAN GREEN|^START CROSSING/, 'WALK'],
    [/^FINISH CROSSING/, 'PED_CLEARANCE'], [/^ALL RED BEFORE CAR/, 'BEFORE_CAR']
  ].find(([pattern]) => pattern.test(line))?.[1];
  const rawDistance = line.match(/\|\s*distance_cm=(-?\d+(?:\.\d+)?)(?=\s|$)/)?.[1];
  if (!phase || rawDistance === undefined) return null;
  const distance = Number(rawDistance);
  const edge = line.match(/\|\s*crosswalk_(?:edge_)?cm=(\d+(?:\.\d+)?)(?=\s|$)/)?.[1];
  return { phase, distance: distance >= 2 && distance <= 400 ? distance : null, crosswalkCm: edge ? Number(edge) : null };
}

function start() {
  const $ = id => document.getElementById(id);
  const serial = navigator.serial;
  const clock = new Intl.DateTimeFormat('th-TH', { timeStyle: 'medium', timeZone: 'Asia/Bangkok' });
  const locationUrl = new URL(location.href);
  const suppliedKey = new URLSearchParams(locationUrl.hash.slice(1)).get('key');
  const validRelay = value => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value ?? '') ? value : null;
  let relay = validRelay(locationUrl.searchParams.get('relay'));
  if (suppliedKey && relay && /^[a-f0-9]{64}$/.test(suppliedKey)) {
    sessionStorage.setItem(`crossense:${relay}`, suppliedKey);
    locationUrl.hash = '';
    history.replaceState(null, '', locationUrl);
  }
  let approved = [];
  let active = null;
  let busy = false;
  let local = null;
  let remote = null;
  let pollingError = false;
  let sending = false;
  let lastSend = 0;

  function render() {
    const board = local && Date.now() - local.updatedAt < 4000 ? local : null;
    const shared = remote && Date.now() - remote.updatedAt < 5000 ? remote : null;
    const state = board ?? shared;
    const phase = state?.phase;
    const car = phase === 'CAR_IDLE' ? 'green' : phase === 'CAR_WARNING' ? 'yellow' : phase ? 'red' : null;
    const ped = phase === 'WALK' ? 'green' : phase ? 'red' : null;
    $('phase').textContent = phases[phase] ?? (pollingError ? 'ตัวส่งข้อมูลสดออฟไลน์' : 'รอข้อมูลสดจาก ESP32');
    $('live-badge').textContent = board ? 'ESP32 เครื่องนี้' : shared ? 'กำลังดูสด' : 'รอข้อมูล';
    $('live-badge').dataset.live = state ? 'yes' : 'no';
    $('car').textContent = ({ green: 'ไปได้', yellow: 'เตรียมหยุด', red: 'หยุด' })[car] ?? '—';
    $('ped').textContent = phase === 'PED_CLEARANCE' ? 'เดินต่อให้พ้น' : ped === 'green' ? 'เริ่มข้ามได้' : ped ? 'รอก่อน' : '—';
    for (const lamp of document.querySelectorAll('.lamps i')) {
      lamp.classList.toggle('on', lamp.id === `car-${car}` || lamp.id === `ped-${ped}`);
      lamp.classList.toggle('blink', lamp.id === 'ped-red' && phase === 'PED_CLEARANCE');
    }
    $('length').textContent = state?.crosswalkCm == null ? '—' : `${state.crosswalkCm} ซม.`;
    $('distance').textContent = state?.distance == null ? (state ? 'อ่านระยะไม่ได้' : '—') : `${state.distance.toFixed(1)} ซม.`;
    $('updated').textContent = state ? `ข้อมูลล่าสุด ${clock.format(state.updatedAt)} (เวลาไทย)` : 'อัปเดตอัตโนมัติเมื่อบอร์ดส่งข้อมูล';
  }

  function buttons() {
    $('ports').disabled = busy || !!active || !approved.length;
    $('connect').disabled = $('ports').disabled;
    $('choose').disabled = !serial || busy || !!active;
    $('disconnect').disabled = busy || !active;
  }

  async function refreshPorts() {
    try { approved = await serial?.getPorts() ?? []; } catch { approved = []; }
    $('ports').replaceChildren(...approved.map((port, index) => {
      const { usbVendorId, usbProductId } = port.getInfo();
      const id = usbVendorId != null && usbProductId != null ? ` · USB ${usbVendorId.toString(16)}:${usbProductId.toString(16)}` : '';
      return new Option(`พอร์ตที่อนุญาต ${index + 1}${id}`, index);
    }));
    if (!approved.length) $('ports').add(new Option('ยังไม่มีพอร์ตที่อนุญาต', ''));
    buttons();
  }

  async function publish(state) {
    const key = relay && sessionStorage.getItem(`crossense:${relay}`);
    if (!key || sending || (state && Date.now() - lastSend < 850)) return;
    sending = true;
    lastSend = Date.now();
    try {
      const response = await fetch(`${relay}/status`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(state), signal: AbortSignal.timeout(3500)
      });
      $('sharing-status').textContent = response.ok
        ? (state ? 'กำลังส่งสถานะให้ผู้ชม' : 'หยุดส่งสถานะแล้ว') : 'ส่งข้อมูลไม่ได้ ให้เปิดลิงก์ผู้ควบคุมใหม่';
    } catch { $('sharing-status').textContent = 'ตัวส่งข้อมูลสดติดต่อไม่ได้'; }
    finally { sending = false; }
  }

  async function readPort(connection) {
    const decoder = new TextDecoder();
    let partial = '';
    let skipLine = false;
    try {
      while (!connection.closing) {
        const { value, done } = await connection.reader.read();
        if (done) break;
        const lines = (partial + decoder.decode(value, { stream: true })).split('\n');
        partial = lines.pop();
        for (const line of lines) {
          const packet = !skipLine && line.length < 4096 ? parseSerialLine(line.trim()) : null;
          skipLine = false;
          if (!packet) continue;
          local = { ...packet, updatedAt: Date.now() };
          $('serial-status').textContent = 'เชื่อมต่อ ESP32 แล้ว กำลังรับข้อมูล';
          render();
          void publish(packet);
        }
        if (partial.length > 4096) { partial = ''; skipLine = true; }
      }
    } catch { /* USB can disconnect during read. */ }
    finally {
      connection.reader.releaseLock();
      try { await connection.port.close(); } catch { /* Device may have been unplugged. */ }
      active = null;
      local = null;
      busy = false;
      $('serial-status').textContent = 'ตัดการเชื่อมต่อ ESP32 แล้ว';
      await refreshPorts();
      void publish(null);
      render();
    }
  }

  async function connect(choosePort) {
    if (busy || active) return;
    busy = true;
    buttons();
    try {
      const port = await choosePort();
      if (!port) return;
      await port.open({ baudRate: 115200 });
      if (!port.readable) {
        await port.close();
        throw new Error('Serial port is not readable');
      }
      active = { port, reader: port.readable.getReader(), closing: false };
      $('serial-status').textContent = 'เปิดพอร์ตแล้ว รอข้อมูลจาก ESP32';
      void readPort(active);
    } catch (error) {
      $('serial-status').textContent = error.name === 'NotFoundError' ? 'ยังไม่ได้เลือกพอร์ต'
        : 'เปิดพอร์ตไม่ได้ ลองปิด Arduino Serial Monitor หรือ Node-RED ที่ใช้พอร์ตอยู่ แล้วเชื่อมใหม่';
    } finally { busy = false; await refreshPorts(); }
  }

  async function poll() {
    if (relay) {
      try {
        const response = await fetch(`${relay}/status`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('Relay unavailable');
        const status = await response.json();
        remote = status.online && Object.hasOwn(phases, status.phase) ? status : null;
        pollingError = false;
      } catch { remote = null; pollingError = true; }
    }
    render();
    setTimeout(poll, 1200);
  }

  $('serial-status').textContent = serial ? 'เสียบ ESP32 แล้วกดเลือก COM Port'
    : 'เปิดใน Chrome หรือ Edge บนคอมพิวเตอร์เพื่อเชื่อม USB';
  $('choose').onclick = () => connect(() => serial.requestPort());
  $('connect').onclick = () => connect(() => approved[Number($('ports').value)]);
  $('disconnect').onclick = () => {
    if (!active || active.closing) return;
    active.closing = true;
    busy = true;
    buttons();
    void active.reader.cancel().catch(() => {});
  };
  serial?.addEventListener('connect', refreshPorts);
  serial?.addEventListener('disconnect', refreshPorts);
  void refreshPorts();

  async function configureRelay() {
    if (!relay) {
      try { relay = validRelay((await (await fetch('./relay.json', { cache: 'no-store' })).json()).relay); }
      catch { /* The page can still read a locally connected board. */ }
    }
    if (relay && sessionStorage.getItem(`crossense:${relay}`)) {
      $('sharing-status').hidden = false;
      $('sharing-status').textContent = 'รอข้อมูลจาก ESP32 เพื่อส่งให้ผู้ชม';
      $('share-tools').hidden = false;
      $('copy-link').onclick = async () => {
        const viewer = new URL(location.href);
        viewer.hash = '';
        viewer.searchParams.set('relay', relay);
        try {
          await navigator.clipboard.writeText(viewer.href);
          $('copy-link').textContent = 'คัดลอกลิงก์แล้ว';
        } catch { $('copy-link').textContent = 'คัดลอกลิงก์จากแถบที่อยู่'; }
      };
    }
    void poll();
  }
  void configureRelay();
}

if (typeof document !== 'undefined') start();
