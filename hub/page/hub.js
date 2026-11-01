// The services page: find a service, open it, and see how long it has left before it
// stops unused. Rows are kept and updated in place, so a status refresh never takes
// away focus, scroll position or an open menu. Opening /go/<name> in a tab starts that
// service and then moves the tab to it, so a slow start never hits a pop-up blocker,
// and the address works as a bookmark.

const main = document.querySelector('.kit-page');
const POLL_MS = 5000;
const LIMITS = [5, 15, 30, 60, 120, 240, 480, 720, 1440];
const TAB_REPORT_STALE_MIN = 10;
const REAP_EVERY_MIN = 5;
const TOAST_MS = 8000;
const LOW_METER = 0.2;

let data = null;
let query = '';
let pastOpen = false;
let stuckOpen = false;
let readFailed = false;
const busy = new Map();
const rows = new Map();

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  }
  return el;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function duration(min) {
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  const head = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `${head} ${rest} min` : head;
}

function shortDuration(min) {
  if (min < 1) return 'moments';
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`.replace(/ 0m$/, '');
  return `${Math.floor(min / 1440)}d`;
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await res.json().catch(() => ({ ok: false, error: 'The hub did not answer' }));
  if (!res.ok || answer.ok === false) throw new Error(answer.error || 'That did not work');
  return answer;
}

// ---- messages ----

const toast = h('div', { class: 'hub-toast', role: 'status', hidden: true });
let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
}

// A success fades on its own. A failure stays until dismissed, so looking away
// cannot lose it.
function say(text, { bad = false, action = null } = {}) {
  clearTimeout(toastTimer);
  toast.className = `hub-toast${bad ? ' bad' : ''}`;
  toast.setAttribute('role', bad ? 'alert' : 'status');
  toast.replaceChildren(...[h('span', {}, text),
    action && h('button', { type: 'button', onclick: () => { hideToast(); action.run(); } }, action.label),
    bad && h('button', { type: 'button', onclick: hideToast }, 'Dismiss')].filter(Boolean));
  toast.hidden = false;
  if (!bad) toastTimer = setTimeout(hideToast, TOAST_MS);
}

async function act(name, busyLabel, fn, success) {
  busy.set(name, busyLabel);
  update();
  try {
    await fn();
    if (success) say(success.text, success);
  } catch (err) {
    say(err.message, { bad: true });
  }
  busy.delete(name);
  await refresh();
}

// ---- what a row says ----

function statusText(s) {
  if (busy.has(s.name)) return busy.get(s.name);
  if (s.kind === 'past') {
    if (s.outsidePm2) return 'Port in use outside pm2, may be this service';
    return s.cannotStart || (s.guessed ? 'Command guessed from package.json, may not work' : 'Last command on record');
  }
  if (s.name === data.self) return 'This page, always on';
  if (s.failed) return 'Crashed';
  if (s.changing) return 'Changing state…';
  // Its section heading already says so, unless a search has mixed the sections.
  if (!s.running) return '';
  if (s.booting) return 'Starting up…';
  if (s.noPort) return 'Running with no port, so it never auto-stops';
  if (s.heldUntil) return `Held for ${shortDuration(Math.round((s.heldUntil * 1000 - Date.now()) / 60000))} more`;
  if (s.limit.mode === 'keep') return `Used ${shortDuration(s.idleMin)} ago`;
  const left = s.limit.minutes - s.idleMin;
  return left > 0 ? `Stops within ${shortDuration(left + REAP_EVERY_MIN)} if unused` : `Stops within ${REAP_EVERY_MIN}m`;
}

/** The share of the idle limit still left, or null when this service has no countdown. */
function timeLeft(s) {
  if (s.kind !== 'pm2' || !s.running || s.noPort || s.heldUntil || s.limit.mode === 'keep') return null;
  return Math.max(0, Math.min(1, 1 - s.idleMin / s.limit.minutes));
}

function limitText(s) {
  if (s.limit.mode === 'keep') return 'Never stops';
  if (s.limit.mode === 'idle') return `${duration(s.limit.minutes)} idle`;
  return `Default, ${duration(s.limit.minutes)}`;
}

function openLabel(s) {
  if (s.name === data.self || s.changing) return null;
  if (s.kind === 'past') {
    if (s.outsidePm2) return 'Open';
    if (!s.cmd) return null;
    return s.guessed ? 'Try to start' : 'Start and open';
  }
  if (s.running) return s.listening ? 'Open' : null;
  return 'Start and open';
}

// ---- rows ----

function createRow(name) {
  const parts = {
    dot: h('span', { class: 'hub-dot', 'aria-hidden': 'true' }),
    name: h('a', { class: 'hub-name', target: '_blank', rel: 'noopener' }, name),
    note: h('div', { class: 'hub-note', hidden: true }),
    cmd: h('code', { class: 'hub-cmd', hidden: true }),
    port: h('span', { class: 'hub-port' }),
    status: h('div', { class: 'hub-status' }),
    meterFill: h('i', {}),
    limit: h('button', { class: 'hub-limit', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', hidden: true }),
    go: h('a', { class: 'hub-go', target: '_blank', rel: 'noopener', hidden: true }),
    stop: h('button', { class: 'hub-stop', type: 'button', hidden: true }, 'Stop'),
  };
  parts.meter = h('div', { class: 'hub-meter', 'aria-hidden': 'true', hidden: true }, parts.meterFill);
  parts.el = h('li', { class: 'hub-row', 'data-service': name },
    parts.dot,
    h('div', { class: 'hub-who' }, parts.name, parts.note, parts.cmd),
    parts.port,
    h('div', { class: 'hub-state' }, parts.status, parts.meter),
    h('div', { class: 'hub-limit-cell' }, parts.limit),
    h('div', { class: 'hub-actions' }, parts.go, parts.stop));
  const href = `/go/${encodeURIComponent(name)}`;
  parts.href = href;
  parts.limit.addEventListener('click', () => openMenu(name, parts.limit));
  parts.stop.addEventListener('click', () => act(name, 'Stopping…', () => post('/api/stop', { name }), {
    text: `Stopped ${name}`,
    action: { label: 'Start again', run: () => act(name, 'Starting…', () => post('/api/up', { name })) },
  }));
  return parts;
}

function updateRow(p, s) {
  const isBusy = busy.has(s.name);
  const label = openLabel(s);
  p.el.setAttribute('aria-busy', String(isBusy));
  p.dot.className = `hub-dot${s.failed ? ' bad' : s.running ? ' on' : s.changing ? ' changing' : ''}`;
  if (label && !isBusy) p.name.setAttribute('href', p.href);
  else p.name.removeAttribute('href');

  setText(p.note, s.note || '');
  p.note.hidden = !s.note;
  setText(p.cmd, s.kind === 'past' && s.cmd ? s.cmd : '');
  p.cmd.hidden = !(s.kind === 'past' && s.cmd);
  if (s.cwd) p.cmd.title = `In ${s.cwd}`;
  setText(p.port, s.port ? `:${s.port}` : '');
  setText(p.status, statusText(s));

  const left = timeLeft(s);
  p.meter.hidden = left === null;
  if (left !== null) {
    p.meterFill.style.transform = `scaleX(${left})`;
    p.meter.classList.toggle('low', left < LOW_METER);
  }

  const canTune = s.kind === 'pm2' && s.name !== data.self && !s.noPort;
  p.limit.hidden = !canTune;
  if (canTune) {
    setText(p.limit, limitText(s));
    p.limit.classList.toggle('own', s.limit.mode !== 'default');
    p.limit.setAttribute('aria-label', `Idle limit for ${s.name}: ${limitText(s)}. Change`);
  }

  p.go.hidden = !label || isBusy;
  if (label) {
    p.go.setAttribute('href', p.href);
    setText(p.go, label);
  }
  p.stop.hidden = !(s.kind === 'pm2' && s.running && s.name !== data.self && !s.changing);
  p.stop.disabled = isBusy;
}

// Puts exactly these services in this list, in this order, moving a row only when it
// has to, because moving the row that holds focus would drop that focus.
function fillList(list, services) {
  let cursor = list.firstElementChild;
  for (const s of services) {
    let p = rows.get(s.name);
    if (!p) {
      p = createRow(s.name);
      rows.set(s.name, p);
    }
    updateRow(p, s);
    if (p.el === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      const refocus = p.el.contains(document.activeElement) ? document.activeElement : null;
      list.insertBefore(p.el, cursor);
      refocus?.focus();
    }
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

// ---- the idle limit menu ----

const menu = h('div', { class: 'hub-menu', popover: 'auto', role: 'menu', 'aria-label': 'Idle limit' });
let menuAnchor = null;

function setLimit(name, body, text) {
  const back = menuAnchor;
  menu.hidePopover();
  back?.focus();
  act(name, 'Saving…', () => post('/api/limit', { name, ...body }), { text });
}

function openMenu(name, anchor) {
  const s = data.services.find((x) => x.name === name);
  const minutes = new Set(LIMITS);
  if (s.limit.mode === 'idle') minutes.add(s.limit.minutes);
  const item = (label, checked, run) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), onclick: run }, label);
  const defaultMin = s.limit.mode === 'default' ? s.limit.minutes : data.defaultLimitMin;

  const custom = h('input', {
    class: 'hub-minutes', type: 'number', min: 1, max: 10080, placeholder: 'Other, in minutes', 'aria-label': `Idle limit for ${name}, in minutes`,
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const value = Number(e.target.value);
      setLimit(name, { mode: 'idle', minutes: value }, `${name} now stops after ${duration(value)} unused`);
    },
  });

  menu.replaceChildren(
    item(`Default, ${duration(defaultMin)}`, s.limit.mode === 'default', () => setLimit(name, { mode: 'default' }, `${name} is back on the default limit`)),
    ...[...minutes].sort((a, b) => a - b).map((m) => item(duration(m), s.limit.mode === 'idle' && s.limit.minutes === m,
      () => setLimit(name, { mode: 'idle', minutes: m }, `${name} now stops after ${duration(m)} unused`))),
    item('Never stop', s.limit.mode === 'keep', () => setLimit(name, { mode: 'keep' }, `${name} will not auto-stop`)),
    custom);

  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menu.showPopover();
  const box = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const below = box.bottom + 4 + size.height <= innerHeight;
  menu.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - 4 - size.height)}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - size.width - 8))}px`;
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus();
}

menu.addEventListener('toggle', (e) => {
  if (e.newState === 'closed' && menuAnchor) {
    menuAnchor.setAttribute('aria-expanded', 'false');
    menuAnchor.focus();
    menuAnchor = null;
  }
});

menu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...menu.querySelectorAll('button, input')];
  const at = items.indexOf(document.activeElement);
  items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});

// ---- the page ----

const search = h('input', {
  class: 'hub-search', type: 'search', placeholder: 'Find a service', 'aria-label': 'Find a service', autocomplete: 'off', spellcheck: 'false',
  oninput: (e) => { query = e.target.value; update(); },
  onkeydown: (e) => {
    if (e.key === 'Escape') { search.value = ''; query = ''; update(); }
    if (e.key === 'Enter') main.querySelector('.hub-go:not([hidden])')?.click();
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
  },
});
const notice = h('p', { class: 'hub-notice', hidden: true });

function group(title) {
  const count = h('span', { class: 'hub-count' });
  const list = h('ul', { class: 'hub-list' });
  const empty = h('p', { class: 'hub-empty', hidden: true });
  const el = h('section', { class: 'hub-group', 'aria-label': title }, h('h2', { class: 'hub-head' }, title, count), list, empty);
  return { el, count, list, empty };
}

const runningGroup = group('Running');
const stoppedGroup = group('Stopped');

const startableList = h('ul', { class: 'hub-list' });
const stuckList = h('ul', { class: 'hub-list' });
const stuckCount = h('span', { class: 'hub-count' });
const pastCount = h('span', { class: 'hub-count' });
const stuckFold = h('details', { class: 'hub-fold' }, h('summary', {}, 'No way to start', stuckCount), stuckList);
const pastFold = h('details', { class: 'hub-fold' },
  h('summary', {}, 'Older services', pastCount),
  h('p', { class: 'hub-why' }, 'Servers the port ledger remembers. Starting one runs the command shown, under pm2, and it stays listed above. It auto-stops once it opens a port.'),
  startableList, stuckFold);
const noMatch = h('p', { class: 'hub-empty', hidden: true });

pastFold.addEventListener('toggle', () => { if (!query.trim()) { pastOpen = pastFold.open; update(); } });
stuckFold.addEventListener('toggle', () => { if (!query.trim()) { stuckOpen = stuckFold.open; update(); } });

function update() {
  if (!data) return;
  const q = query.trim().toLowerCase();
  const all = data.services.filter((s) => !q || `${s.name} ${s.note} ${s.port ?? ''} ${s.cwd ?? ''}`.toLowerCase().includes(q));
  const managed = all.filter((s) => s.kind === 'pm2');
  const past = all.filter((s) => s.kind === 'past');
  const running = managed.filter((s) => s.running || s.changing).concat(past.filter((s) => s.outsidePm2));
  const stopped = managed.filter((s) => !s.running && !s.changing);
  const startable = past.filter((s) => !s.outsidePm2 && s.cmd);
  const stuck = past.filter((s) => !s.outsidePm2 && !s.cmd);

  const fill = (g, services, emptyText) => {
    fillList(g.list, services);
    setText(g.count, String(services.length));
    g.el.hidden = Boolean(q) && !services.length;
    g.empty.hidden = services.length > 0;
    setText(g.empty, emptyText);
  };
  fill(runningGroup, running, 'Nothing is running.');
  fill(stoppedGroup, stopped, running.length ? 'Everything pm2 knows is running.' : 'pm2 knows no services yet. Anything you add to pm2 appears here by itself.');

  // Older rows run to the hundreds, so they only exist while their section is open.
  const showPast = pastOpen || Boolean(q);
  const showStuck = stuckOpen || Boolean(q);
  pastFold.open = showPast;
  stuckFold.open = showStuck;
  setText(pastCount, String(startable.length + stuck.length));
  setText(stuckCount, String(stuck.length));
  fillList(startableList, showPast ? startable : []);
  fillList(stuckList, showPast && showStuck ? stuck : []);
  stuckFold.hidden = !stuck.length;
  pastFold.parentElement.hidden = Boolean(q) && !startable.length && !stuck.length;

  noMatch.hidden = !q || all.length > 0;
  setText(noMatch, `No service matches “${query.trim()}”. Search covers names, notes, ports and folders.`);

  // A machine-wide fact, said once, and only while it can cost something.
  const stale = data.tabReportAgeMin === null || data.tabReportAgeMin > TAB_REPORT_STALE_MIN;
  const atRisk = data.services.some((s) => timeLeft(s) !== null);
  let line = '';
  if (readFailed) line = 'The hub could not read your services just now. Showing the last known state, and trying again.';
  else if (stale && atRisk) line = 'Reload the bfb extension. Until then, open tabs do not count as use, so a service can stop while you read it.';
  setText(notice, line);
  notice.hidden = !line;
}

async function refresh() {
  try {
    const res = await fetch('/api/services');
    const answer = await res.json();
    if (!res.ok) throw new Error(answer.error);
    data = answer;
    readFailed = false;
    showPage();
    update();
  } catch (err) {
    readFailed = true;
    if (data) update();
    else main.replaceChildren(h('p', { role: 'alert' }, `The hub could not read your services: ${err.message || 'no answer'}. Trying again.`));
  }
}

let pageShown = false;

function showPage() {
  if (pageShown) return;
  pageShown = true;
  main.replaceChildren(
    h('label', { class: 'hub-find' }, search, h('kbd', { 'aria-hidden': 'true' }, '/')),
    notice, noMatch, runningGroup.el, stoppedGroup.el,
    h('section', { class: 'hub-group', 'aria-label': 'Older services' }, pastFold),
    h('p', { class: 'hub-keys' }, 'Keys: ', h('kbd', {}, '/'), ' find, ', h('kbd', {}, 'j'), ' and ', h('kbd', {}, 'k'), ' move, ', h('kbd', {}, 'Enter'), ' opens'));
}

function moveFocus(step) {
  const links = [...main.querySelectorAll('a.hub-name[href]')].filter((a) => a.offsetParent !== null);
  if (!links.length) return;
  const at = links.indexOf(document.activeElement);
  if (at === -1) { links[step > 0 ? 0 : links.length - 1].focus(); return; }
  const next = at + step;
  if (next < 0) search.focus();
  else links[Math.min(next, links.length - 1)].focus();
}

// Keys for people who keep their hands on the keyboard: / finds, j and k move.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || !pageShown) return;
  if (e.target.matches('input, select, textarea') || e.target.closest('.hub-menu')) return;
  if (e.key === '/') { e.preventDefault(); search.focus(); search.select(); }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
});

// ---- text size, one setting for the whole page ----

function readSize() {
  try { return localStorage.getItem('hub-size') || 'sm'; } catch { return 'sm'; }
}

function setSize(size) {
  document.documentElement.dataset.size = size;
  try { localStorage.setItem('hub-size', size); } catch { /* private window: the choice lasts this visit */ }
  sizes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === size)));
}

const sizes = h('div', { class: 'hub-sizes', role: 'group', 'aria-label': 'Text size' },
  [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']].map(([size, label]) =>
    h('button', { type: 'button', 'data-size': size, 'aria-label': label, 'aria-pressed': 'false', onclick: () => setSize(size) }, size.toUpperCase().slice(0, 1))));
document.querySelector('.kit-theme').before(sizes);
setSize(readSize());
document.body.append(toast, menu);

// ---- starting up ----

async function goTo(name) {
  document.title = `Starting ${name}`;
  main.replaceChildren(h('p', { class: 'hub-go-page', role: 'status' }, `Starting ${name}…`));
  try {
    const answer = await post('/api/up', { name });
    if (answer.url && answer.note) {
      main.replaceChildren(h('p', { role: 'status' }, answer.note), h('p', {}, h('a', { href: answer.url }, `Open port ${new URL(answer.url).port} anyway`)));
      return;
    }
    if (answer.url) { location.replace(answer.url); return; }
    throw new Error(answer.error || `${name} started, but it has no page to open`);
  } catch (err) {
    document.title = `${name} did not open`;
    main.replaceChildren(h('p', { role: 'alert' }, err.message), h('p', {}, h('a', { href: '/' }, 'Back to all services')));
  }
}

const going = /^\/go\/(.+)$/.exec(location.pathname);
if (going) {
  goTo(decodeURIComponent(going[1]));
} else {
  main.replaceChildren(h('div', { role: 'status', 'aria-label': 'Reading your services' },
    ...[1, 2, 3, 4].map(() => h('div', { class: 'hub-skeleton', style: 'margin: 18px 0' }))));
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
