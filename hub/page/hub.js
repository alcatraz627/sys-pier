// The hub page: draws the service list from /api/services, and sends a person's
// clicks back as start, stop and limit requests. Opening /go/<name> in a tab starts
// that service and then moves the tab to it, so a slow start never hits a pop-up
// blocker, and the address works as a bookmark.

const main = document.querySelector('.kit-page');
const POLL_MS = 5000;
const LIMITS = [5, 15, 30, 60, 120, 240, 480, 720, 1440];
const TAB_REPORT_STALE_MIN = 10;
const REAP_EVERY_MIN = 5;
const SUCCESS_SHOWN_MS = 15000;
const MENU_HOLD_MS = 20000;

let data = null;
let query = '';
let pastOpen = false;
let stuckOpen = false;
let customFor = null;
let message = null;
let menuFocusedAt = 0;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  }
  return el;
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

// A success fades on its own. A failure stays until the next action, so it cannot be
// missed by looking away.
function currentMessage() {
  if (message && message.until && Date.now() > message.until) message = null;
  return message;
}

async function act(fn, done) {
  message = null;
  try {
    await fn();
    if (done) message = { text: done, bad: false, until: Date.now() + SUCCESS_SHOWN_MS };
  } catch (err) {
    message = { text: err.message, bad: true };
  }
  await refresh(true);
}

function usage(s) {
  if (s.kind === 'past') {
    if (s.outsidePm2) return 'Port in use outside pm2, may be this service';
    return s.cannotStart || (s.guessed ? 'Command guessed from package.json, may not work' : 'Last command on record');
  }
  if (s.name === data.self) return 'This page';
  if (s.failed) return 'Crashed';
  if (s.changing) return 'Changing state…';
  if (!s.running) return 'Stopped';
  if (s.noPort) return 'Running with no port, so it never auto-stops';
  if (s.heldUntil) return `Held for ${shortDuration(Math.round((s.heldUntil * 1000 - Date.now()) / 60000))} more`;
  if (s.limit.mode === 'keep') return `Used ${shortDuration(s.idleMin)} ago`;
  const left = s.limit.minutes - s.idleMin;
  return left > 0
    ? `Used ${shortDuration(s.idleMin)} ago, stops within ${shortDuration(left + REAP_EVERY_MIN)}`
    : `Unused for ${shortDuration(s.idleMin)}, stops within ${REAP_EVERY_MIN}m`;
}

function limitControl(s) {
  if (s.kind !== 'pm2') return null;
  if (s.name === data.self) return h('span', { class: 'hub-dim' }, 'Never stops');
  if (s.noPort) return h('span', { class: 'hub-dim' }, 'No limit without a port');
  if (customFor === s.name) {
    return h('input', {
      class: 'hub-minutes', type: 'number', min: 1, max: 10080, placeholder: 'minutes', 'aria-label': `Idle limit for ${s.name}, in minutes`,
      onkeydown: (e) => {
        if (e.key === 'Escape') { customFor = null; draw(true); }
        if (e.key === 'Enter') {
          customFor = null;
          const minutes = Number(e.target.value);
          act(() => post('/api/limit', { name: s.name, mode: 'idle', minutes }), `${s.name} now stops after ${duration(minutes)} unused`);
        }
      },
      onblur: () => { if (customFor === s.name) { customFor = null; draw(true); } },
    });
  }
  const current = s.limit.mode === 'idle' ? String(s.limit.minutes) : s.limit.mode;
  const minutes = new Set(LIMITS);
  if (s.limit.mode === 'idle') minutes.add(s.limit.minutes);
  const options = [
    h('option', { value: 'default' }, `Default (${duration(s.limit.mode === 'default' ? s.limit.minutes : data.defaultLimitMin)})`),
    ...[...minutes].sort((a, b) => a - b).map((m) => h('option', { value: String(m) }, duration(m))),
    h('option', { value: 'keep' }, 'Never stop'),
    h('option', { value: 'custom' }, 'Custom…'),
  ];
  const select = h('select', {
    class: 'hub-limit', 'aria-label': `Idle limit for ${s.name}`,
    onfocus: () => { menuFocusedAt = Date.now(); },
    onchange: (e) => {
      const v = e.target.value;
      if (v === 'custom') { customFor = s.name; draw(true); document.querySelector('.hub-minutes')?.focus(); return; }
      if (v === 'default') act(() => post('/api/limit', { name: s.name, mode: 'default' }), `${s.name} is back on the default limit`);
      else if (v === 'keep') act(() => post('/api/limit', { name: s.name, mode: 'keep' }), `${s.name} will not auto-stop`);
      else act(() => post('/api/limit', { name: s.name, mode: 'idle', minutes: Number(v) }), `${s.name} now stops after ${duration(Number(v))} unused`);
    },
  }, options);
  select.value = current;
  return select;
}

function actions(s) {
  if (s.name === data.self || s.changing) return null;
  const go = (label, primary) => h('a', { class: `hub-btn${primary ? ' hub-primary' : ''}`, href: `/go/${encodeURIComponent(s.name)}`, target: '_blank', rel: 'noopener' }, label);
  if (s.kind === 'past') {
    if (s.outsidePm2) return go('Open', false);
    if (!s.cmd) return null;
    return s.guessed ? go('Try to start', false) : go('Start and open', true);
  }
  if (!s.running) return go('Start and open', true);
  return [
    s.listening ? go('Open', true) : null,
    h('button', { class: 'hub-btn', type: 'button', onclick: () => act(() => post('/api/stop', { name: s.name }), `${s.name} stopped`) }, 'Stop'),
  ];
}

function row(s) {
  return h('tr', { 'data-service': s.name },
    h('td', {},
      h('div', { class: 'hub-name' }, h('span', { class: `hub-dot ${s.failed ? 'bad' : s.running ? 'on' : ''}`, 'aria-hidden': 'true' }), s.name),
      s.note ? h('div', { class: 'hub-note' }, s.note) : null,
      s.kind === 'past' && s.cmd ? h('code', { class: 'hub-cmd', title: s.cwd ? `In ${s.cwd}` : null }, s.cmd) : null),
    h('td', { class: 'hub-port' }, s.port ? `:${s.port}` : ''),
    h('td', { class: 'hub-use' }, usage(s)),
    h('td', {}, limitControl(s)),
    h('td', {}, h('div', { class: 'hub-actions' }, actions(s))));
}

function table(services) {
  return h('div', { class: 'kit-table-wrap' }, h('table', { class: 'hub-table' },
    h('thead', {}, h('tr', {}, ['Service', 'Port', 'Status', 'Idle limit', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, services.map(row))));
}

// Older services have no idle limit until pm2 runs them, so their rows drop that column.
function olderTable(services) {
  return h('div', { class: 'kit-table-wrap' }, h('table', { class: 'hub-table hub-older' },
    h('thead', {}, h('tr', {}, ['Service', 'Port', 'Status', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, services.map((s) => {
      const tr = row(s);
      tr.children[3].remove();
      return tr;
    }))));
}

function section(title, services, emptyText) {
  return [
    h('h2', {}, title, ' ', h('span', { class: 'hub-count' }, String(services.length))),
    services.length ? table(services) : h('p', { class: 'kit-dim' }, emptyText),
  ];
}

// Redrawing would pull a half-typed number or an open menu out from under the
// person. A menu only holds the list still for a moment, because a focused one with
// no change would otherwise freeze every status until the next click elsewhere.
function shouldWait(active) {
  if (!active || !main.contains(active)) return false;
  if (active.matches('.hub-minutes')) return true;
  return active.matches('select') && Date.now() - menuFocusedAt < MENU_HOLD_MS;
}

function draw(force = false) {
  const active = document.activeElement;
  if (!force && shouldWait(active)) return;

  const q = query.trim().toLowerCase();
  const all = (data?.services || []).filter((s) => !q || `${s.name} ${s.note} ${s.port ?? ''} ${s.cwd ?? ''}`.toLowerCase().includes(q));
  const managed = all.filter((s) => s.kind === 'pm2');
  const past = all.filter((s) => s.kind === 'past');
  const running = managed.filter((s) => s.running || s.changing).concat(past.filter((s) => s.outsidePm2));
  const ready = managed.filter((s) => !s.running && !s.changing);
  const startable = past.filter((s) => !s.outsidePm2 && s.cmd);
  const stuck = past.filter((s) => !s.outsidePm2 && !s.cmd);

  const search = document.querySelector('.hub-search') || h('input', {
    class: 'hub-search', type: 'search', placeholder: 'Find a service', 'aria-label': 'Find a service',
    oninput: (e) => { query = e.target.value; draw(true); },
  });

  const parts = [h('div', { class: 'hub-top' }, search,
    h('p', { class: 'hub-lead' }, `A service with a port stops after ${duration(data.defaultLimitMin)} unused, unless you set its limit here.`))];

  if (data.tabReportAgeMin === null || data.tabReportAgeMin > TAB_REPORT_STALE_MIN) {
    parts.push(h('p', { class: 'kit-note hub-warn' }, 'Your open tabs are not being counted as use, because the bfb extension has not reported lately. Reload it, or a short limit can stop a page you are reading.'));
  }
  const shown = currentMessage();
  if (shown) parts.push(h('p', { class: `kit-note ${shown.bad ? 'hub-bad' : 'hub-good'}`, role: 'status' }, shown.text));

  parts.push(...section('Running', running, q ? 'Nothing running matches.' : 'Nothing is running.'));
  parts.push(...section('Ready to start', ready, q ? 'Nothing here matches.' : 'Everything pm2 knows is running.'));

  // Older rows run to the hundreds, so they are only built while their section is open.
  const showPast = pastOpen || Boolean(q);
  const showStuck = stuckOpen || Boolean(q);
  parts.push(h('details', {
    class: 'hub-past', open: showPast,
    ontoggle: (e) => { if (e.target.open !== showPast) { pastOpen = e.target.open; draw(true); } },
  },
    h('summary', {}, 'Older services ', h('span', { class: 'hub-count' }, String(startable.length + stuck.length))),
    showPast ? [
      h('p', { class: 'kit-dim' }, 'Servers the port ledger remembers. Starting one runs the command shown, under pm2, and stays listed there. It auto-stops once it opens a port.'),
      startable.length ? olderTable(startable) : h('p', { class: 'kit-dim' }, 'None of these can be started.'),
      stuck.length ? h('details', {
        class: 'hub-stuck', open: showStuck,
        ontoggle: (e) => { if (e.target.open !== showStuck) { stuckOpen = e.target.open; draw(true); } },
      }, h('summary', {}, 'No way to start ', h('span', { class: 'hub-count' }, String(stuck.length))), showStuck ? olderTable(stuck) : null) : null,
    ] : null));

  main.replaceChildren(...parts);
  if (search === active) search.focus();
  // New tables need the kit to place their headers, and it only does that on a scroll.
  window.dispatchEvent(new Event('scroll'));
}

async function refresh(force = false) {
  try {
    const res = await fetch('/api/services');
    const answer = await res.json();
    if (!res.ok) throw new Error(answer.error);
    data = answer;
    draw(force);
  } catch (err) {
    const text = `The hub could not read your services: ${err.message || 'no answer'}. Trying again.`;
    // Keep what is on screen if there is anything; one failed read should not cost
    // the person their place or a half-typed number.
    if (data) {
      message = { text, bad: true, until: Date.now() + POLL_MS * 2 };
      draw();
    } else {
      main.replaceChildren(h('p', { class: 'kit-note hub-bad', role: 'status' }, text));
    }
  }
}

async function goTo(name) {
  document.title = `Starting ${name}`;
  main.replaceChildren(h('p', { class: 'hub-go', role: 'status' }, `Starting ${name}…`));
  try {
    const answer = await post('/api/up', { name });
    if (answer.url && answer.note) {
      main.replaceChildren(h('p', { class: 'kit-note hub-warn', role: 'status' }, answer.note), h('p', {}, h('a', { href: answer.url }, `Open port ${new URL(answer.url).port} anyway`)));
      return;
    }
    if (answer.url) { location.replace(answer.url); return; }
    throw new Error(answer.error || `${name} started, but it has no page to open`);
  } catch (err) {
    document.title = `${name} did not open`;
    main.replaceChildren(h('p', { class: 'kit-note hub-bad', role: 'alert' }, err.message), h('p', {}, h('a', { href: '/' }, 'Back to all services')));
  }
}

const going = /^\/go\/(.+)$/.exec(location.pathname);
if (going) {
  goTo(decodeURIComponent(going[1]));
} else {
  main.replaceChildren(h('p', { class: 'kit-dim', role: 'status' }, 'Reading your services…'));
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
