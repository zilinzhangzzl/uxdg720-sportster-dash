/*
 * Sportster S 仪表盘交互原型
 * 所有页面、弹窗和按钮都读取同一个 state 对象。
 * 计时不使用分散的 setTimeout，而是把“截止时间”存进 state，
 * 由一个统一的 tick 检查。这样旧通知的计时器不可能误关新的弹窗，
 * 重置或关机时只要清空 state 里的截止时间即可。
 */
'use strict';

/* ---------- 常量（暂定原型决定，见 specification.md） ---------- */
const PAGES = ['home', 'map', 'media', 'vehicle', 'settings'];
const PAGE_LABEL = { home: '首页', map: '地图', media: '媒体', vehicle: '车辆', settings: '设置' };
const TRIP_ITEMS = ['odometer', 'ambient', 'range', 'tripA', 'tripB'];
const TRIP_LABEL = { odometer: '总里程', ambient: '环境温度', range: '预计续航', tripA: 'Trip A', tripB: 'Trip B' };
const BOOT_MS = 3000;
const NOTICE_MS = 5000;
const CALL_MS = 20000;
const QUEUE_MAX = 5;
const SPEED_MAX = 300;
const TICK_MS = 100;

const WARNING_TYPES = {
  tire: { label: '后轮胎压低', detail: '请减速并尽快检查后轮胎压', short: '胎压' },
  engine: { label: '发动机温度高', detail: '请靠边停车，让发动机降温', short: '温度' },
  battery: { label: '电池电压低', detail: '充电系统可能异常，请尽快检查', short: '电压' }
};
const CALLERS = ['小李', '妈妈', '王老师', '未知号码'];
const SMS_SENDERS = ['小李', '车队群', '张同学'];
const MESSAGES = ['手机电量低于 20%', '日历：19:00 小组讨论', '天气：前方路段有阵雨'];

const BUTTON_LABEL = {
  power: 'Power', home: 'Home', page: 'Page', trip: 'Trip',
  up: '上', down: '下', left: '左', right: '右', ok: '确认'
};

const BASE_VEHICLE = {
  odometer: 12873.4, // km
  ambient: 21,       // °C
  range: 214,        // km
  tripA: 46.3,       // km
  tripB: 318.9,      // km
  fuel: 0.62,        // 0–1
  tireFront: 2.5,    // bar
  tireRear: 2.8,     // bar
  coolant: 92,       // °C
  voltage: 13.9      // V
};

/* ---------- 统一状态 ---------- */
function initialState() {
  return {
    powerState: 'OFF',          // OFF | BOOTING | READY
    currentPage: 'home',
    speed: 0,
    tripIndex: 0,
    activeOverlay: null,        // {kind:'warning'|'call'|'notice', id, ...}
    pendingNotifications: [],   // 等待显示的普通通知
    callState: 'IDLE',          // IDLE | RINGING | CONNECTED
    call: null,                 // {id, caller, startedAt, deadline}
    warningConditions: [],      // 当前存在的警告条件 {id, type, raisedAt}
    activeWarning: null,        // 正在显示的警告（由 reconcile 计算）
    acknowledgedWarningIds: [],
    overlayDeadline: null,      // 当前普通通知的自动关闭时间
    bootDeadline: null,
    dataMissing: false,
    vehicle: { ...BASE_VEHICLE },
    seq: 0,
    lastNotice: null,
    lastInput: null
  };
}

let state = initialState();
const logLines = [];

/* 派生值：不单独保存，避免互相矛盾 */
const isMoving = () => state.speed > 0;
const isRestricted = () => state.powerState === 'READY' && state.currentPage === 'settings' && isMoving();
const now = () => Date.now();

function gearFor(speed) {
  if (speed <= 0) return 'N';
  if (speed < 20) return 1;
  if (speed < 35) return 2;
  if (speed < 55) return 3;
  if (speed < 75) return 4;
  if (speed < 95) return 5;
  return 6;
}
function rpmFor(speed) {
  if (speed <= 0) return 1000;
  const bands = [[0, 20], [20, 35], [35, 55], [55, 75], [75, 95], [95, SPEED_MAX]];
  const g = gearFor(speed);
  const [lo, hi] = bands[g - 1];
  const t = Math.min(1, (speed - lo) / (hi - lo));
  return Math.round((2200 + t * 4800) / 50) * 50;
}

function log(msg) {
  const d = new Date();
  const t = d.toTimeString().slice(0, 8);
  logLines.unshift(`${t}  ${msg}`);
  if (logLines.length > 12) logLines.length = 12;
}

/* ---------- 通知选择（状态机三） ---------- */
function trimQueue() {
  while (state.pendingNotifications.length > QUEUE_MAX) {
    // 删除最早到达的等待通知
    let idx = 0;
    state.pendingNotifications.forEach((n, i) => {
      if (n.receivedAt < state.pendingNotifications[idx].receivedAt) idx = i;
    });
    const [dropped] = state.pendingNotifications.splice(idx, 1);
    log(`队列已满，删除最早的等待通知 ${dropped.id}`);
  }
}

function reconcile() {
  const t = now();

  // 1. 电源
  if (state.powerState === 'BOOTING' && state.bootDeadline !== null && t >= state.bootDeadline) {
    state.powerState = 'READY';
    state.bootDeadline = null;
    state.currentPage = 'home';
    state.tripIndex = 0;
    log('开机完成，进入首页');
  }
  if (state.powerState !== 'READY') {
    state.activeOverlay = null;
    state.activeWarning = null;
    state.overlayDeadline = null;
    return;
  }

  // 2. 删除已失效的事件
  if (state.callState === 'RINGING' && state.call && t >= state.call.deadline) {
    log(`来电 ${state.call.id} 20 秒无人接听，已结束`);
    state.callState = 'IDLE';
    state.call = null;
  }
  let cur = state.activeOverlay;
  if (cur && cur.kind === 'notice' && state.overlayDeadline !== null && t >= state.overlayDeadline) {
    log(`通知 ${cur.id} 显示 5 秒，自动关闭`);
    cur = state.activeOverlay = null;
    state.overlayDeadline = null;
  }
  if (cur && cur.kind === 'call' && !(state.callState === 'RINGING' && state.call && state.call.id === cur.id)) {
    cur = state.activeOverlay = null;
  }
  if (cur && cur.kind === 'warning' &&
      (!state.warningConditions.some(w => w.id === cur.id) || state.acknowledgedWarningIds.includes(cur.id))) {
    cur = state.activeOverlay = null;
  }

  // 3. 按优先级选择：警告 > 来电 > 普通通知
  const warn = state.warningConditions.find(w => !state.acknowledgedWarningIds.includes(w.id));
  let desired = null;
  if (warn) {
    desired = { kind: 'warning', id: warn.id, type: warn.type, ...WARNING_TYPES[warn.type] };
  } else if (state.callState === 'RINGING' && state.call) {
    desired = { kind: 'call', id: state.call.id, caller: state.call.caller };
  }

  if (desired) {
    if (!cur || cur.id !== desired.id) {
      if (cur && cur.kind === 'notice') {
        // 被打断的普通通知回到队列前方，重新显示时重新计时
        const { kind, ...notice } = cur;
        state.pendingNotifications.unshift(notice);
        trimQueue();
        log(`通知 ${cur.id} 被${desired.kind === 'warning' ? '警告' : '来电'}打断，回到队列前方`);
      }
      state.activeOverlay = desired;
      state.overlayDeadline = null;
    }
  } else if (!cur && state.pendingNotifications.length) {
    const next = state.pendingNotifications.shift();
    state.activeOverlay = { kind: 'notice', ...next };
    state.overlayDeadline = t + NOTICE_MS;
  }

  state.activeWarning = state.activeOverlay && state.activeOverlay.kind === 'warning' ? state.activeOverlay : null;
}

function commit() {
  reconcile();
  render();
}

/* ---------- 按钮处理：电源 → 弹窗 → 页面 ---------- */
function press(btn) {
  reconcile(); // 先清除已过期的事件，再决定这次输入交给谁
  const result = route(btn);
  state.lastInput = { btn, result };
  commit();
}

function route(btn) {
  // 电源层
  if (btn === 'power') {
    if (state.powerState === 'OFF') {
      state.powerState = 'BOOTING';
      state.bootDeadline = now() + BOOT_MS;
      log('开机：进入 BOOTING');
      return '开机中（3 秒）';
    }
    powerOff();
    return '关机';
  }
  if (state.powerState === 'OFF') return '忽略：仪表已关机';
  if (state.powerState === 'BOOTING') return '忽略：正在开机';

  // 弹窗层：只执行弹窗允许的动作，然后结束
  const ov = state.activeOverlay;
  if (ov) {
    if (ov.kind === 'call') {
      if (btn === 'ok') {
        state.callState = 'CONNECTED';
        state.activeOverlay = null;
        log(`接听来电 ${ov.id}（${ov.caller}）`);
        return '接听来电';
      }
      if (btn === 'down') {
        state.callState = 'IDLE';
        state.call = null;
        state.activeOverlay = null;
        log(`拒接来电 ${ov.id}`);
        return '拒接来电';
      }
      return '忽略：来电弹窗只接受 确认 / 下';
    }
    if (ov.kind === 'notice') {
      if (btn === 'ok') {
        state.activeOverlay = null;
        state.overlayDeadline = null;
        log(`手动关闭通知 ${ov.id}`);
        return '关闭通知';
      }
      return '忽略：通知只接受 确认';
    }
    if (ov.kind === 'warning') {
      if (btn === 'ok') {
        state.acknowledgedWarningIds.push(ov.id);
        state.activeOverlay = null;
        log(`确认警告 ${ov.id}（故障条件仍存在，保留标记）`);
        return '确认警告';
      }
      return '忽略：警告只接受 确认';
    }
  }

  // 页面层
  if (btn === 'page') {
    const i = PAGES.indexOf(state.currentPage);
    state.currentPage = PAGES[(i + 1) % PAGES.length];
    return `切换到${PAGE_LABEL[state.currentPage]}`;
  }
  if (btn === 'home') {
    if (state.currentPage === 'home') return '已在首页，保持不变';
    state.currentPage = 'home';
    return '返回首页';
  }
  if (btn === 'trip') {
    if (state.currentPage !== 'home') return '无操作：Trip 只在首页可用';
    state.tripIndex = (state.tripIndex + 1) % TRIP_ITEMS.length;
    return `小窗口：${TRIP_LABEL[TRIP_ITEMS[state.tripIndex]]}`;
  }
  return '无操作：本页面没有方向 / 确认功能';
}

function powerOff() {
  const keep = { speed: state.speed, dataMissing: state.dataMissing, vehicle: state.vehicle, seq: state.seq };
  state = { ...initialState(), ...keep };
  log('关机：画面变黑，清除全部弹窗、队列、来电、警告和计时');
}

/* ---------- 演示面板事件 ---------- */
function requireReady(what) {
  if (state.powerState !== 'READY') {
    log(`忽略${what}：仪表未就绪（${state.powerState}）`);
    commit();
    return false;
  }
  return true;
}

function setSpeed(raw) {
  const msg = document.getElementById('speedMsg');
  const str = String(raw).trim();
  const v = Number(str);
  if (str === '' || !Number.isFinite(v) || v < 0 || v > SPEED_MAX) {
    msg.textContent = `车速无效：请输入 0–${SPEED_MAX} 的数字。保留上一次有效值 ${state.speed} km/h。`;
    msg.className = 'field-msg error';
    document.getElementById('speedInput').value = state.speed;
    log(`拒绝非法车速 “${str}”`);
    render();
    return;
  }
  const before = state.speed;
  state.speed = Math.round(v);
  msg.textContent = `车速已设为 ${state.speed} km/h`;
  msg.className = 'field-msg';
  document.getElementById('speedInput').value = state.speed;
  if (before === 0 && state.speed > 0) log(`车辆开始移动（${state.speed} km/h）`);
  else if (before > 0 && state.speed === 0) log('车辆停下');
  commit();
}

function triggerCall() {
  if (!requireReady('来电')) return;
  if (state.callState !== 'IDLE') {
    log('忽略新来电：已有来电或通话（原型只模拟一路电话）');
    return commit();
  }
  const id = `call-${++state.seq}`;
  const caller = CALLERS[state.seq % CALLERS.length];
  const t = now();
  state.callState = 'RINGING';
  state.call = { id, caller, startedAt: t, deadline: t + CALL_MS };
  log(`收到来电 ${id}（${caller}）`);
  commit();
}
function cancelCall() {
  if (state.callState !== 'RINGING') { log('没有正在响铃的来电'); return commit(); }
  log(`对方取消来电 ${state.call.id}`);
  state.callState = 'IDLE';
  state.call = null;
  commit();
}
function endCall() {
  if (state.callState !== 'CONNECTED') { log('没有进行中的通话'); return commit(); }
  log(`通话结束 ${state.call.id}`);
  state.callState = 'IDLE';
  state.call = null;
  commit();
}

function addNotice(notice) {
  if (!requireReady('通知')) return;
  const dup = state.pendingNotifications.some(n => n.id === notice.id) ||
    (state.activeOverlay && state.activeOverlay.id === notice.id);
  if (dup) {
    log(`拒绝重复通知编号 ${notice.id}`);
    return commit();
  }
  state.pendingNotifications.push({ ...notice, receivedAt: now() });
  state.lastNotice = notice;
  log(`收到通知 ${notice.id}`);
  trimQueue();
  commit();
}
function triggerSms() {
  const id = `msg-${++state.seq}`;
  addNotice({ id, title: '短信', body: `来自 ${SMS_SENDERS[state.seq % SMS_SENDERS.length]}` });
}
function triggerMsg() {
  const id = `msg-${++state.seq}`;
  addNotice({ id, title: '消息', body: MESSAGES[state.seq % MESSAGES.length] });
}
function resendLast() {
  if (!state.lastNotice) { log('还没有发送过通知'); return commit(); }
  addNotice({ ...state.lastNotice });
}

function triggerWarning(type) {
  if (!requireReady('警告')) return;
  if (state.warningConditions.some(w => w.type === type)) {
    log(`警告“${WARNING_TYPES[type].label}”已存在，不重复提示`);
    return commit();
  }
  const id = `warn-${type}-${++state.seq}`;
  state.warningConditions.push({ id, type, raisedAt: now() });
  log(`出现警告 ${id}`);
  commit();
}
function clearWarning(type) {
  const w = state.warningConditions.find(c => c.type === type);
  if (!w) { log(`当前没有“${WARNING_TYPES[type].label}”警告`); return commit(); }
  state.warningConditions = state.warningConditions.filter(c => c.id !== w.id);
  state.acknowledgedWarningIds = state.acknowledgedWarningIds.filter(id => id !== w.id);
  log(`警告解除 ${w.id}`);
  commit();
}

function setDataMissing(on) {
  state.dataMissing = on;
  state.vehicle.ambient = on ? null : BASE_VEHICLE.ambient;
  state.vehicle.tireRear = on ? null : BASE_VEHICLE.tireRear;
  log(on ? '模拟数据缺失：环境温度、后轮胎压' : '数据恢复');
  commit();
}

function resetDemo() {
  state = initialState();
  logLines.length = 0;
  log('重置演示：恢复初始状态，清除全部计时');
  document.getElementById('speedInput').value = 0;
  document.getElementById('speedMsg').textContent = '';
  document.getElementById('demoMissing').checked = false;
  commit();
}

/* ---------- 显示 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmt(v, unit = '', digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${Number(v).toFixed(digits)}${unit}`;
}
function tripValue(key) {
  const v = state.vehicle;
  switch (key) {
    case 'odometer': return fmt(v.odometer, ' km', 1);
    case 'ambient': return fmt(v.ambient, ' °C');
    case 'range': return fmt(v.range, ' km');
    case 'tripA': return fmt(v.tripA, ' km', 1);
    case 'tripB': return fmt(v.tripB, ' km', 1);
  }
  return '—';
}

function renderPersistent() {
  const gear = gearFor(state.speed);
  const callTag = state.callState === 'CONNECTED' ? '<span class="tag call-tag">📞 通话中</span>' : '';
  if (state.currentPage === 'home') {
    return `<div class="speed-big"><span class="num">${state.speed}</span><span class="unit">km/h</span></div>
      <div class="gear-big" aria-label="挡位">${gear}</div>${callTag}`;
  }
  return `<div class="speed-small"><span class="num">${state.speed}</span> km/h <span class="gear-small">${gear}</span></div>${callTag}`;
}

function renderPage() {
  const v = state.vehicle;
  const dots = PAGES.map(p => `<i class="${p === state.currentPage ? 'on' : ''}"></i>`).join('');
  const header = `<div class="page-head"><span class="page-name">${PAGE_LABEL[state.currentPage]}</span><span class="dots">${dots}</span></div>`;
  switch (state.currentPage) {
    case 'home': {
      const rpm = rpmFor(state.speed);
      const key = TRIP_ITEMS[state.tripIndex];
      return `${header}
        <div class="bar-row"><span>转速</span><div class="bar"><b style="width:${Math.min(100, rpm / 9000 * 100)}%"></b></div><span class="val">${rpm} rpm</span></div>
        <div class="bar-row"><span>燃油</span><div class="bar fuel"><b style="width:${v.fuel * 100}%"></b></div><span class="val">${fmt(v.fuel * 100, '%')}</span></div>
        <div class="trip-box" data-trip="${key}">
          <span class="trip-label">${TRIP_LABEL[key]}</span>
          <span class="trip-val">${tripValue(key)}</span>
          <span class="trip-pos">${state.tripIndex + 1} / ${TRIP_ITEMS.length}</span>
        </div>`;
    }
    case 'map':
      return `${header}<div class="placeholder">🗺<p>导航功能不在本次范围内</p></div>`;
    case 'media':
      return `${header}<div class="placeholder">♫<p>媒体功能不在本次范围内</p></div>`;
    case 'vehicle':
      return `${header}<dl class="vehicle-list">
          <dt>前轮胎压</dt><dd>${fmt(v.tireFront, ' bar', 1)}</dd>
          <dt>后轮胎压</dt><dd>${fmt(v.tireRear, ' bar', 1)}</dd>
          <dt>冷却液温度</dt><dd>${fmt(v.coolant, ' °C')}</dd>
          <dt>电压</dt><dd>${fmt(v.voltage, ' V', 1)}</dd>
        </dl>`;
    case 'settings':
      return `${header}<div class="placeholder settings-ph">⚙<p>设置（顶层占位）</p><small>亮度 · 单位 · 蓝牙 · 时钟<br>子页面不在本次范围内</small></div>`;
  }
  return '';
}

function renderOverlay() {
  const ov = state.activeOverlay;
  if (!ov) return '';
  if (ov.kind === 'call') {
    const left = state.call ? Math.max(0, Math.ceil((state.call.deadline - now()) / 1000)) : 0;
    return `<div class="ov ov-call" data-kind="call" data-id="${esc(ov.id)}">
      <div class="ov-title">📞 来电</div>
      <div class="ov-body">${esc(ov.caller)}</div>
      <div class="ov-actions"><span><kbd>OK</kbd> 接听</span><span><kbd>▼</kbd> 拒接</span></div>
      <div class="ov-meta">${left} 秒后自动结束</div></div>`;
  }
  if (ov.kind === 'notice') {
    const left = state.overlayDeadline ? Math.max(0, Math.ceil((state.overlayDeadline - now()) / 1000)) : 0;
    return `<div class="ov ov-notice" data-kind="notice" data-id="${esc(ov.id)}">
      <div class="ov-title">✉ ${esc(ov.title)}</div>
      <div class="ov-body">${esc(ov.body)}</div>
      <div class="ov-actions"><span><kbd>OK</kbd> 关闭</span></div>
      <div class="ov-meta">${left} 秒后自动关闭${state.pendingNotifications.length ? ` · 还有 ${state.pendingNotifications.length} 条` : ''}</div></div>`;
  }
  return `<div class="ov ov-warning" data-kind="warning" data-id="${esc(ov.id)}">
      <div class="ov-title">⚠ ${esc(ov.label)}</div>
      <div class="ov-body">${esc(ov.detail)}</div>
      <div class="ov-actions"><span><kbd>OK</kbd> 我已看到</span></div></div>`;
}

function renderProtected() {
  const neutral = state.speed === 0;
  const fuelLow = state.vehicle.fuel !== null && state.vehicle.fuel < 0.15;
  const acked = state.warningConditions.filter(w => state.acknowledgedWarningIds.includes(w.id));
  const warnMarks = acked.map(w => `<span class="tell warn" title="${esc(WARNING_TYPES[w.type].label)}">⚠ ${WARNING_TYPES[w.type].short}</span>`).join('');
  const clock = new Date().toTimeString().slice(0, 5);
  return `<span class="tell ${neutral ? 'on-green' : 'off'}">N</span>
    <span class="tell off">ABS</span>
    <span class="tell ${fuelLow ? 'on-amber' : 'off'}">FUEL</span>
    ${warnMarks}
    <span class="clock">${clock}</span>`;
}

function availableHelp() {
  if (state.powerState === 'OFF') return { text: '仪表已关机。可用：Power 开机', keys: ['power'] };
  if (state.powerState === 'BOOTING') return { text: '正在开机。可用：Power 关机；其他按键会被忽略', keys: ['power'] };
  const ov = state.activeOverlay;
  if (ov && ov.kind === 'call') return { text: '来电接管输入。可用：确认 接听 · 下 拒接 · Power 关机', keys: ['ok', 'down', 'power'] };
  if (ov && ov.kind === 'notice') return { text: '通知接管输入。可用：确认 关闭 · Power 关机', keys: ['ok', 'power'] };
  if (ov && ov.kind === 'warning') return { text: '警告接管输入。可用：确认 我已看到 · Power 关机', keys: ['ok', 'power'] };
  const keys = ['page', 'home', 'power'];
  let text = 'Page 下一页 · Home 首页';
  if (state.currentPage === 'home') { keys.push('trip'); text += ' · Trip 切换小窗口'; }
  if (isRestricted()) text += ' · 设置受限：请停车后操作';
  return { text: `可用：${text} · 方向/确认在本页无功能`, keys };
}

function render() {
  const dial = $('dial');
  dial.dataset.power = state.powerState;
  const ready = state.powerState === 'READY';
  $('dialScreen').hidden = !ready;
  $('bootScreen').hidden = state.powerState !== 'BOOTING';
  if (state.powerState === 'BOOTING' && state.bootDeadline) {
    const p = 1 - Math.max(0, state.bootDeadline - now()) / BOOT_MS;
    $('bootBar').style.width = `${Math.round(p * 100)}%`;
  }

  if (ready) {
    $('persistent').innerHTML = renderPersistent();
    $('persistent').dataset.page = state.currentPage;
    $('page').innerHTML = renderPage();
    $('page').dataset.page = state.currentPage;
    const restricted = isRestricted();
    $('restrictLayer').hidden = !restricted;
    $('restrictLayer').innerHTML = restricted ? '<div class="restrict-box">⛔ 请停车后操作<small>行驶中设置不可用</small></div>' : '';
    const ovHtml = renderOverlay();
    $('overlay').hidden = !ovHtml;
    $('overlay').innerHTML = ovHtml;
    $('protected').innerHTML = renderProtected();
  }

  const help = availableHelp();
  $('availableHelp').textContent = help.text;
  document.querySelectorAll('.hw').forEach(b => {
    b.classList.toggle('is-available', help.keys.includes(b.dataset.btn));
  });

  $('lastInput').textContent = state.lastInput
    ? `上次输入：${BUTTON_LABEL[state.lastInput.btn]} → ${state.lastInput.result}`
    : '尚无输入';

  $('log').innerHTML = logLines.map(l => `<li>${esc(l)}</li>`).join('');

  if (!$('debug').hidden) $('debug').textContent = JSON.stringify(snapshot(), null, 2);
}

function snapshot() {
  return {
    powerState: state.powerState,
    currentPage: state.currentPage,
    speed: state.speed,
    isMoving: isMoving(),
    settingsRestricted: isRestricted(),
    tripIndex: state.tripIndex,
    tripItem: TRIP_ITEMS[state.tripIndex],
    activeOverlay: state.activeOverlay,
    overlayDeadlineIn: state.overlayDeadline ? `${Math.max(0, state.overlayDeadline - now())} ms` : null,
    pendingNotifications: state.pendingNotifications.map(n => n.id),
    callState: state.callState,
    call: state.call ? { id: state.call.id, caller: state.call.caller, endsIn: `${Math.max(0, state.call.deadline - now())} ms` } : null,
    warningConditions: state.warningConditions.map(w => w.id),
    activeWarning: state.activeWarning ? state.activeWarning.id : null,
    acknowledgedWarningIds: state.acknowledgedWarningIds,
    dataMissing: state.dataMissing
  };
}
// 只读的调试接口，供自动化检查使用，不能修改状态
window.dashDebug = { snapshot };

/* ---------- 输入绑定 ---------- */
const KEY_MAP = {
  x: 'power', X: 'power', h: 'home', H: 'home', p: 'page', P: 'page', t: 'trip', T: 'trip',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok'
};
const heldKeys = new Set();

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

document.addEventListener('keydown', e => {
  const btn = KEY_MAP[e.key];
  if (!btn || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  // 焦点在按钮上时，Enter 交给浏览器去点击该按钮，避免一次按键触发两个动作
  if (e.key === 'Enter' && e.target && e.target.tagName === 'BUTTON') return;
  e.preventDefault();          // 防止方向键滚动页面
  if (e.repeat) return;        // 长按不重复触发
  heldKeys.add(e.key.toLowerCase());
  document.querySelector(`.hw[data-btn="${btn}"]`)?.classList.add('pressed');
});

document.addEventListener('keyup', e => {
  const btn = KEY_MAP[e.key];
  if (!btn) return;
  document.querySelector(`.hw[data-btn="${btn}"]`)?.classList.remove('pressed');
  const k = e.key.toLowerCase();
  if (!heldKeys.has(k)) return; // 只有“按下并松开”才算一次
  heldKeys.delete(k);
  if (isTypingTarget(e.target)) return;
  press(btn);
});

window.addEventListener('blur', () => {
  heldKeys.clear();
  document.querySelectorAll('.hw.pressed').forEach(b => b.classList.remove('pressed'));
});

// 鼠标点击按钮或勾选框时不抢焦点：之后按 Enter 会交给仪表的“确认”，
// 而不是再次点击刚才那个按钮。用 Tab 键聚焦的按钮仍可用 Enter 激活。
document.querySelectorAll('button, input[type="checkbox"]').forEach(b => {
  b.addEventListener('mousedown', e => e.preventDefault());
});
document.querySelectorAll('.hw').forEach(b => {
  b.addEventListener('click', () => press(b.dataset.btn));
});

$('speedForm').addEventListener('submit', e => { e.preventDefault(); setSpeed($('speedInput').value); });
document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => setSpeed(b.dataset.speed)));
$('demoCall').addEventListener('click', triggerCall);
$('demoCallCancel').addEventListener('click', cancelCall);
$('demoCallEnd').addEventListener('click', endCall);
$('demoSms').addEventListener('click', triggerSms);
$('demoMsg').addEventListener('click', triggerMsg);
$('demoDup').addEventListener('click', resendLast);
$('demoWarn').addEventListener('click', () => triggerWarning($('warnType').value));
$('demoWarnClear').addEventListener('click', () => clearWarning($('warnType').value));
$('demoMissing').addEventListener('change', e => setDataMissing(e.target.checked));
$('demoReset').addEventListener('click', resetDemo);
$('debugToggle').addEventListener('change', e => { $('debug').hidden = !e.target.checked; render(); });

// 统一计时：检查开机、通知、来电的截止时间
setInterval(commit, TICK_MS);
commit();
