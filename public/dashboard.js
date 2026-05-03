    // ── Client-side console logging ──────────────────────────────────────
    (function() {
      var _logQueue = [];
      var _origError = console.error;
      var _origWarn = console.warn;
      function _pushLog(level, args) {
        _logQueue.push({ level: level, message: Array.from(args).map(String).join(' '), ts: new Date().toISOString() });
        if (_logQueue.length >= 5) _flushLogs();
      }
      function _flushLogs() {
        if (!_logQueue.length) return;
        var batch = _logQueue.splice(0);
        navigator.sendBeacon('/api/client-logs', JSON.stringify(batch));
      }
      console.error = function() { _origError.apply(console, arguments); _pushLog('error', arguments); };
      console.warn = function() { _origWarn.apply(console, arguments); _pushLog('warn', arguments); };
      window.addEventListener('error', function(e) {
        _pushLog('error', [e.message + ' at ' + (e.filename || '?') + ':' + (e.lineno || '?')]);
      });
      window.addEventListener('unhandledrejection', function(e) {
        _pushLog('error', ['Unhandled rejection: ' + (e.reason && e.reason.message || e.reason || 'unknown')]);
      });
      setInterval(_flushLogs, 10000);
      window.addEventListener('beforeunload', _flushLogs);
    })();

    // ── Client-side HTML escape ──────────────────────────────────────────
    function _esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // ── Dashboard config (synced from server via window.__SYS_PIER__) ────
    let DASH_CONFIG = window.__SYS_PIER__.config;
    const COLOR_PALETTE = window.__SYS_PIER__.colorPalette;

    // ── Theme system ───────────────────────────────────────────────────────
    const THEMES = window.__SYS_PIER__.themes;
    const THEME_ORDER = window.__SYS_PIER__.themeOrder;
    const html = document.documentElement;
    let currentTheme = 'dark';
    let themeNavIndex = -1; // -1 = no keyboard focus active
    let navbar; // declared early — assigned after NavbarShortcuts class definition

    // Quick-select key for each theme index (1-9 for first 9, 0 for 10th, none beyond)
    const THEME_QUICK_KEYS = ['1','2','3','4','5','6','7','8','9','0'];

    function applyTheme(id) {
      currentTheme = id;
      html.dataset.theme = id;
      localStorage.setItem('pm2-theme', id);
      document.querySelectorAll('.theme-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.tid === id);
      });
    }

    function buildThemeGrid() {
      const grid = document.getElementById('theme-grid');
      grid.innerHTML = THEME_ORDER.map((id, i) => {
        const t = THEMES[id];
        const key = THEME_QUICK_KEYS[i];
        const keyBadge = key
          ? `<span class="theme-key" title="Press t then ${key}">${key}</span>`
          : `<span class="theme-key-ph"></span>`;
        return `<div class="theme-item" data-tid="${id}" data-idx="${i}"
          onclick="applyTheme('${id}');closeThemePanel()"
          onmouseenter="setThemeNavFocus(${i})">
          ${keyBadge}
          <div class="theme-swatch" style="background:${t.bg}">
            <div class="theme-swatch-accent" style="background:${t.accent}"></div>
          </div>
          <span class="theme-label">${t.label}</span>
        </div>`;
      }).join('');
    }

    function setThemeNavFocus(idx) {
      themeNavIndex = idx;
      document.querySelectorAll('.theme-item').forEach((el, i) => {
        el.classList.toggle('nav-focus', i === idx);
      });
      if (idx >= 0) {
        const el = document.querySelector(`.theme-item[data-idx="${idx}"]`);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function toggleThemePanel() {
      const panel = document.getElementById('theme-panel');
      panel.classList.toggle('open');
      if (!panel.classList.contains('open')) resetThemeNav();
    }
    function closeThemePanel() {
      document.getElementById('theme-panel').classList.remove('open');
      resetThemeNav();
    }
    function resetThemeNav() {
      themeNavIndex = -1;
      document.querySelectorAll('.theme-item.nav-focus').forEach((el) => el.classList.remove('nav-focus'));
    }

    buildThemeGrid();
    const savedTheme = localStorage.getItem('pm2-theme');
    if (savedTheme && THEMES[savedTheme]) applyTheme(savedTheme);

    // Close theme panel on outside click
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('theme-panel');
      const btn = document.getElementById('theme-btn');
      if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
        closeThemePanel();
      }
    });

    // ── Skeleton loader ────────────────────────────────────────────────────
    function showSkeletons(n = 3) {
      const skel = Array.from({ length: n }, () => `
        <div class="card-skeleton">
          <div class="skel-line skeleton w60"></div>
          <div class="skel-line skeleton w80"></div>
          <div class="skel-line skeleton w40"></div>
        </div>`).join('');
      document.getElementById('grid').innerHTML = skel;
    }

    // ── Refresh ────────────────────────────────────────────────────────────
    let firstLoad = true;
    let lastProcesses = []; // pm2-only summary list (table render, sparklines patch)
    let allItems      = []; // unified Item[] from aggregateItems() — all types
    let lastMetrics = null; // used to redraw sparklines on view toggle
    let lastHealthMetrics = null; // used to redraw health sparklines on view toggle
    let _lastGroupView = null; // track view mode to detect full-rebuild needs

    async function refresh() {
      try {
        const grouped = localStorage.getItem('pm2-group-view') === 'grouped';
        const res = await fetch('/api/processes' + (grouped ? '?grouped=1' : ''));
        if (!res.ok) return;
        const data = await res.json();

        if (data.config) DASH_CONFIG = data.config;

        const grid = document.getElementById('grid');
        const currentNames = new Set(
          [...grid.querySelectorAll('[data-name]')].map(el => el.dataset.name)
        );
        const newNames = new Set();
        // Parse new HTML in a detached fragment to diff against
        const tmp = document.createElement('div');
        tmp.innerHTML = data.html;
        tmp.querySelectorAll('[data-name]').forEach(el => newNames.add(el.dataset.name));

        // Determine if we need a full rebuild (first load, view mode changed, cards added/removed)
        const viewChanged = _lastGroupView !== null && _lastGroupView !== grouped;
        const sameSet = currentNames.size === newNames.size && [...currentNames].every(n => newNames.has(n));
        const needFullRebuild = firstLoad || viewChanged || !sameSet;
        _lastGroupView = grouped;

        if (needFullRebuild) {
          grid.innerHTML = data.html;
          // Suppress entrance animation for previously existing cards
          grid.querySelectorAll('.card[data-name]').forEach(card => {
            if (currentNames.has(card.dataset.name)) {
              card.classList.remove('card-enter');
            }
          });
          setupDragDrop();
        } else {
          // Smart patch: update only changed content within existing cards.
          // Pass tmp so patchCardsInPlace can swap whole cards on status change
          // (action buttons + advanced controls depend on isOnline server-side).
          patchCardsInPlace(data.processes, grid, tmp);
          // Also update group headers (emoji, name, count, notes) if in grouped view
          if (grouped) {
            tmp.querySelectorAll('.group-section').forEach(newSection => {
              const gid = newSection.dataset.group;
              const oldSection = grid.querySelector('.group-section[data-group="' + gid + '"]');
              if (!oldSection) return;
              var el;
              el = newSection.querySelector('.group-emoji');
              var oldEl = oldSection.querySelector('.group-emoji');
              if (el && oldEl && el.textContent !== oldEl.textContent) oldEl.textContent = el.textContent;
              el = newSection.querySelector('.group-name');
              oldEl = oldSection.querySelector('.group-name');
              if (el && oldEl && el.textContent !== oldEl.textContent) oldEl.textContent = el.textContent;
              el = newSection.querySelector('.group-count');
              oldEl = oldSection.querySelector('.group-count');
              if (el && oldEl && el.textContent !== oldEl.textContent) oldEl.textContent = el.textContent;
              el = newSection.querySelector('.group-notes');
              oldEl = oldSection.querySelector('.group-notes');
              if (el && oldEl) oldEl.textContent = el.textContent;
              else if (el && !oldEl) {
                var header = oldSection.querySelector('.group-header');
                if (header) { var s = document.createElement('span'); s.className = 'group-notes'; s.textContent = el.textContent; header.insertBefore(s, header.querySelector('.group-collapse-btn')); }
              } else if (!el && oldEl) oldEl.remove();
              // Sync collapsed state from server
              var wasCollapsed = oldSection.classList.contains('collapsed');
              var isCollapsed = newSection.classList.contains('collapsed');
              if (wasCollapsed !== isCollapsed) {
                oldSection.classList.toggle('collapsed', isCollapsed);
                var colBtn = oldSection.querySelector('.group-collapse-btn');
                if (colBtn) colBtn.textContent = isCollapsed ? '▸' : '▾';
              }
            });
          }
        }

        document.getElementById('proc-count').textContent =
          data.count + ' process' + (data.count !== 1 ? 'es' : '');
        document.getElementById('last-update').textContent =
          new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (data.stats)    updateStatsBar(data.stats);
        if (data.metrics) { lastMetrics = data.metrics; drawSparklines(data.metrics); }
        if (data.healthMetrics) { lastHealthMetrics = data.healthMetrics; drawHealthSparklines(data.healthMetrics); }
        if (data.items)     allItems = data.items;        // all-type pipeline
        if (data.processes) lastProcesses = data.processes;
        if (currentView === 'table') {
          if (allItems.length) renderTableFromItems(allItems);
          else if (lastProcesses.length) renderTable(lastProcesses);
          // Re-draw sparklines after table rebuild creates new canvas elements
          if (data.metrics) drawSparklines(data.metrics);
          if (lastHealthMetrics) drawHealthSparklines(lastHealthMetrics);
        }

        // Re-apply all active filters (type, status, search, sort)
        applyFilters();

        // Tier 1 polish — surface any errored card via the sticky banner.
        updateSeverityBanner();

        firstLoad = false;
      } catch {}
    }

    // Severity banner — shows when ANY card has data-status="errored".
    // Pure DOM read; idempotent on every refresh tick.
    function updateSeverityBanner() {
      const banner = document.getElementById('severity-banner');
      if (!banner) return;
      const errored = [...document.querySelectorAll('.card[data-status="errored"]')];
      if (!errored.length) {
        if (!banner.hidden) {
          banner.hidden = true;
          // Strip the slide-in animation so next appearance retriggers it cleanly.
          banner.style.animation = 'none';
          requestAnimationFrame(() => { banner.style.animation = ''; });
        }
        return;
      }
      const names = errored.map(c => c.dataset.name).slice(0, 3);
      const more = errored.length > 3 ? ` and ${errored.length - 3} more` : '';
      const wasHidden = banner.hidden;
      banner.querySelector('.severity-banner-text').textContent =
        `${errored.length} errored: ${names.join(', ')}${more}`;
      banner.querySelector('.severity-banner-jump').onclick = () =>
        errored[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      banner.hidden = false;
      // If we're transitioning from hidden→visible, the CSS animation runs
      // automatically. If it was already visible (just text update), don't
      // re-trigger the slide.
      if (!wasHidden) banner.style.animation = 'none';
      else            banner.style.animation = '';
    }

    // Patch existing card DOM elements in-place using process data,
    // avoiding innerHTML replacement to preserve focus, inputs, and scroll state.
    function patchCardsInPlace(processes, grid, tmp) {
      const byName = {};
      for (const p of processes) byName[p.name] = p;

      // Lookup of fresh-rendered cards from the parsed response, used to
      // swap whole cards when status changes. Without this, badge + dot
      // update via patchSingleCard but action buttons (Start/Stop/Restart)
      // stay on the old set — making a started process still show "Start"
      // until full reload.
      const newCardByName = {};
      if (tmp) {
        tmp.querySelectorAll('.card[data-name]').forEach(c => { newCardByName[c.dataset.name] = c; });
      }

      grid.querySelectorAll('.card[data-name]').forEach(card => {
        const name = card.dataset.name;
        if (name.startsWith('static:')) return; // static URL cards don't change on refresh

        // Handle merged cards — they contain sub-entries
        if (card.querySelector('.merged-grid')) {
          card.querySelectorAll('[data-name]').forEach(sub => {
            const subName = sub.dataset.name;
            const p = byName[subName];
            if (p) patchSingleCard(sub, p);
          });
          return;
        }

        const p = byName[name];
        if (!p) return;

        // Status flipped → action buttons + advanced controls need re-render.
        // Surgical swap from the already-fetched fresh HTML; no extra request.
        if (card.dataset.status !== p.status && newCardByName[name]) {
          const fresh = newCardByName[name];
          fresh.classList.remove('card-enter'); // existing card, no entrance animation
          card.replaceWith(fresh);
          return;
        }

        patchSingleCard(card, p);
      });
    }

    function patchSingleCard(card, p) {
      const status = p.status;
      const isOnline = status === 'online';

      // Update status badge
      const badge = card.querySelector('.badge');
      if (badge && badge.textContent !== status) {
        badge.textContent = status;
        badge.className = 'badge ' + status;
      }

      // Update status dot
      const dot = card.querySelector('.status-dot');
      if (dot) {
        const newClass = 'status-dot ' + status + (status === 'errored' ? ' status-pulse' : '');
        if (dot.className !== newClass) dot.className = newClass;
      }

      // Update stat values (uptime, cpu, mem, restarts)
      const statVals = card.querySelectorAll('.stat-val');
      const uptime = isOnline ? (p.uptime_human || '—') : '—';
      const cpu = p.cpu_percent != null ? p.cpu_percent + '%' : '—';
      const mem = p.memory_human || '—';
      const restarts = String(p.restarts || 0);
      if (statVals[0] && statVals[0].textContent !== uptime) statVals[0].textContent = uptime;
      if (statVals[1] && statVals[1].textContent !== cpu)    statVals[1].textContent = cpu;
      if (statVals[2] && statVals[2].textContent !== mem)    statVals[2].textContent = mem;
      if (statVals[3] && statVals[3].textContent !== restarts) statVals[3].textContent = restarts;

      // Update restart warning style
      const restartStat = card.querySelectorAll('.stat')[3];
      if (restartStat) {
        const shouldWarn = (p.restarts || 0) >= 3;
        restartStat.classList.toggle('warn', shouldWarn);
      }
    }

    function updateStatsBar(stats) {
      document.getElementById('gstat-cpu').textContent     = stats.total_cpu + '%';
      document.getElementById('gstat-mem').textContent     = stats.total_mem_human;
      document.getElementById('gstat-procs').textContent   = stats.online + ' / ' + stats.total;
      document.getElementById('gstat-restarts').textContent = stats.total_restarts ?? '—';
      document.getElementById('gstat-load').textContent    = stats.load_1m != null ? stats.load_1m.toFixed(2) + ' / ' + stats.load_5m.toFixed(2) : '—';
      document.getElementById('gstat-freemem').textContent = stats.free_mem_human || '—';
      document.getElementById('gstat-uptime').textContent  = stats.server_uptime_human || '—';
    }

    // ── Sparklines ─────────────────────────────────────────────────────────
    // Draws CPU (green) + memory (accent) history lines onto each card canvas.
    // Colors are read from CSS custom properties so they follow the active theme.

    function drawSparklines(metrics) {
      const style = getComputedStyle(document.documentElement);
      const green  = style.getPropertyValue('--green').trim();
      const accent = style.getPropertyValue('--accent').trim();
      document.querySelectorAll('canvas.sparkline, canvas.tbl-sparkline').forEach((canvas) => {
        const name = canvas.dataset.name;
        const h = metrics[name];
        if (!h || h.cpu.length < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || canvas.offsetWidth || 280;
        const ht = canvas.clientHeight || canvas.offsetHeight || 32;
        canvas.width  = w * dpr;
        canvas.height = ht * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, ht);
        drawSparkLine(ctx, h.cpu, w, ht, green,  100);
        const maxMem = Math.max(...h.mem, 1);
        drawSparkLine(ctx, h.mem, w, ht, accent, maxMem);
      });
      // Draw aggregate sparklines in the stats bar
      const agg = metrics._aggregate;
      if (agg && agg.cpu.length >= 2) {
        drawStatSpark('spark-cpu', agg.cpu, green);
        drawStatSpark('spark-mem', agg.mem, accent);
      }
    }

    function drawStatSpark(canvasId, values, color) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || values.length < 2) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 60;
      const ht = canvas.clientHeight || 20;
      canvas.width = w * dpr;
      canvas.height = ht * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, ht);
      const maxVal = Math.max(...values, 1);
      // Fill area under the line
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.moveTo(0, ht);
      values.forEach((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = ht - 2 - (Math.min(v, maxVal) / maxVal) * (ht - 4);
        ctx.lineTo(x, y);
      });
      ctx.lineTo(w, ht);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // Draw the line
      drawSparkLine(ctx, values, w, ht, color, maxVal);
    }

    function drawSparkLine(ctx, values, w, h, color, maxVal) {
      if (values.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.75;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = h - 2 - (Math.min(v, maxVal) / maxVal) * (h - 6);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── Health sparklines (static URLs) ──────────────────────────────────
    function drawHealthSparklines(healthMetrics) {
      const style = getComputedStyle(document.documentElement);
      const green = style.getPropertyValue('--green').trim();
      const red   = style.getPropertyValue('--red').trim() || '#e55';
      const accent = style.getPropertyValue('--accent').trim();
      document.querySelectorAll('canvas.health-sparkline').forEach(function(canvas) {
        const slug = canvas.dataset.healthSlug;
        if (!slug) return;
        const h = healthMetrics[slug];
        if (!h || !h.latency || h.latency.length < 2) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || canvas.offsetWidth || 280;
        const ht = canvas.clientHeight || canvas.offsetHeight || 32;
        canvas.width  = w * dpr;
        canvas.height = ht * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, ht);
        var maxLatency = Math.max.apply(null, h.latency.concat([100]));
        // Draw colored background segments for ok/error status
        var segW = w / h.ok.length;
        h.ok.forEach(function(ok, i) {
          if (!ok) {
            ctx.fillStyle = red;
            ctx.globalAlpha = 0.15;
            ctx.fillRect(i * segW, 0, segW, ht);
            ctx.globalAlpha = 1;
          }
        });
        // Draw latency line — green if all ok, accent otherwise
        var allOk = h.ok.every(function(v) { return v; });
        drawSparkLine(ctx, h.latency, w, ht, allOk ? green : accent, maxLatency);
        // Update the health dot on the card if present
        var dot = document.getElementById('health-' + slug) || document.getElementById('tbl-health-' + slug);
        if (dot) {
          var lastOk = h.ok[h.ok.length - 1];
          dot.className = dot.className.replace(/ ?(healthy|error|redirect|unknown)/g, '') + (lastOk ? ' healthy' : ' error');
          dot.title = h.latency[h.latency.length - 1] + 'ms';
        }
      });
    }

    // ── Filters (type, status, search, sort) ──────────────────────────────

    // State is a Set to support shift-click multi-select.
    // localStorage stores JSON arrays; plain strings (legacy) are tolerated.
    function _loadFilterSet(key, def) {
      try {
        const v = localStorage.getItem(key);
        if (!v) return new Set(def);
        const p = JSON.parse(v);
        return new Set(Array.isArray(p) ? p : [p]);
      } catch { return new Set(def); }
    }
    let activeTypeFilter   = _loadFilterSet('pm2-type-filter',   ['all']);
    let activeStatusFilter = _loadFilterSet('pm2-status-filter', ['all']);
    let activeSortOrder    = localStorage.getItem('pm2-sort-order') || '';

    function _saveFilterSet(key, set) {
      localStorage.setItem(key, JSON.stringify([...set]));
    }

    function _syncTabActive(selector, activeSet) {
      document.querySelectorAll(selector).forEach(t => {
        const v = t.dataset.filterType || t.dataset.filterStatus;
        t.classList.toggle('active', activeSet.has(v));
      });
    }

    function setTypeFilter(type, event) {
      if (event && event.shiftKey && type !== 'all') {
        activeTypeFilter.delete('all');
        if (activeTypeFilter.has(type)) activeTypeFilter.delete(type);
        else activeTypeFilter.add(type);
        if (activeTypeFilter.size === 0) activeTypeFilter.add('all');
      } else {
        activeTypeFilter = new Set([type]);
      }
      _saveFilterSet('pm2-type-filter', activeTypeFilter);
      _syncTabActive('.type-tab', activeTypeFilter);
      applyFilters();
    }

    function setStatusFilter(status, event) {
      if (event && event.shiftKey && status !== 'all') {
        activeStatusFilter.delete('all');
        if (activeStatusFilter.has(status)) activeStatusFilter.delete(status);
        else activeStatusFilter.add(status);
        if (activeStatusFilter.size === 0) activeStatusFilter.add('all');
      } else {
        activeStatusFilter = new Set([status]);
      }
      _saveFilterSet('pm2-status-filter', activeStatusFilter);
      _syncTabActive('.status-tab', activeStatusFilter);
      applyFilters();
    }

    function setSortOrder(order) {
      activeSortOrder = order;
      localStorage.setItem('pm2-sort-order', order);
      applyFilters();
    }

    // Normalize diverse status values to a comparable bucket
    function _normStatus(status) {
      if (status === 'scheduled') return 'online'; // cron "active"
      if (status === 'loaded')    return 'online'; // launchd loaded
      return status || '';
    }

    function applyFilters() {
      const term = document.getElementById('search-input').value.trim().toLowerCase();

      document.querySelectorAll('.card[data-name]').forEach((card) => {
        const name   = card.dataset.name.toLowerCase();
        const type   = card.dataset.type || 'server';
        const status = _normStatus(card.dataset.status);

        const typeMatch =
          activeTypeFilter.has('all') ||
          activeTypeFilter.has(type) ||
          (activeTypeFilter.has('server') && (type === 'server' || type === 'static'));

        const statusMatch =
          activeStatusFilter.has('all') ||
          activeStatusFilter.has(status);

        const searchMatch = !term || name.includes(term);

        card.style.display = (typeMatch && statusMatch && searchMatch) ? '' : 'none';
      });

      // Hide group sections where all visible children are hidden
      document.querySelectorAll('.group-section').forEach((section) => {
        const visibleCards = section.querySelectorAll('.card[data-name]:not([style*="display: none"])');
        section.style.display = visibleCards.length > 0 ? '' : 'none';
      });

      _updateFilterCounts();
      if (activeSortOrder) _applySortOrder();

      if (currentView === 'table') {
        document.querySelectorAll('.table-section').forEach((section) => {
          const sType = section.dataset.type;
          const filterKey = _itemTypeToFilterKey(sType);
          const typeMatch = activeTypeFilter.has('all') || activeTypeFilter.has(filterKey);
          if (!typeMatch) { section.style.display = 'none'; return; }

          let anyVisible = false;
          section.querySelectorAll('tr[data-status]').forEach((row) => {
            const rowStatus = row.dataset.status; // statusBucket
            const rowId = (row.dataset.id || '').toLowerCase();
            const statusMatch =
              activeStatusFilter.has('all') ||
              (activeStatusFilter.has('online')  && rowStatus === 'active') ||
              (activeStatusFilter.has('stopped') && rowStatus === 'stopped') ||
              (activeStatusFilter.has('errored') && rowStatus === 'errored') ||
              activeStatusFilter.has(rowStatus);
            const searchMatch = !term || rowId.includes(term) ||
              [...row.querySelectorAll('td')].some(td => td.textContent.toLowerCase().includes(term));
            row.style.display = (statusMatch && searchMatch) ? '' : 'none';
            if (statusMatch && searchMatch) anyVisible = true;
          });

          section.style.display = anyVisible ? '' : 'none';
        });
      }

      _updateClearChip();
    }

    function _updateFilterCounts() {
      // Use allItems for accurate cross-type counts
      const source = allItems.length ? allItems : [...document.querySelectorAll('.card[data-name]')].map(card => ({
        type: card.dataset.type || 'server',
        statusBucket: _normStatus(card.dataset.status),
      }));

      const total = source.length;
      const tc = { server: 0, daemon: 0, cron: 0, launchd: 0 };
      const sc = { online: 0, stopped: 0, errored: 0 };

      for (const item of source) {
        const t = item.type || 'server';
        if (t === 'pm2' || t === 'merge' || t === 'static' || t === 'server') tc.server++;
        else if (tc[t] !== undefined) tc[t]++;

        const b = item.statusBucket || _normStatus(item.status);
        if (b === 'active' || b === 'online') sc.online++;
        else if (b === 'stopped') sc.stopped++;
        else if (b === 'errored') sc.errored++;
      }

      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
      set('tc-all',     total);
      set('tc-server',  tc.server);
      set('tc-daemon',  tc.daemon);
      set('tc-cron',    tc.cron);
      set('tc-launchd', tc.launchd);
      set('sc-all',     total);
      set('sc-online',  sc.online);
      set('sc-stopped', sc.stopped);
      set('sc-errored', sc.errored);
    }

    function _applySortOrder() {
      const grid = document.getElementById('grid');
      // Only sort in flat (ungrouped) view — groups have their own internal order
      if (grid.querySelector('.group-section')) return;

      const TYPE_ORDER = { server: 0, static: 1, daemon: 2, cron: 3, launchd: 4 };
      const STATUS_ORDER = { online: 0, launching: 1, stopped: 2, errored: 3 };

      const cards = [...grid.querySelectorAll('.card[data-name]')];
      cards.sort((a, b) => {
        switch (activeSortOrder) {
          case 'name-asc':  return a.dataset.name.localeCompare(b.dataset.name);
          case 'name-desc': return b.dataset.name.localeCompare(a.dataset.name);
          case 'status': {
            const sa = STATUS_ORDER[_normStatus(a.dataset.status)] ?? 9;
            const sb = STATUS_ORDER[_normStatus(b.dataset.status)] ?? 9;
            return sa !== sb ? sa - sb : a.dataset.name.localeCompare(b.dataset.name);
          }
          case 'type': {
            const ta = TYPE_ORDER[a.dataset.type] ?? 9;
            const tb = TYPE_ORDER[b.dataset.type] ?? 9;
            return ta !== tb ? ta - tb : a.dataset.name.localeCompare(b.dataset.name);
          }
          case 'restarts-desc': {
            const getRestarts = (card) => {
              const labels = card.querySelectorAll('.stat-label');
              for (const lbl of labels) {
                if (lbl.textContent.trim() === 'restarts') {
                  return parseInt(lbl.nextElementSibling?.textContent || '0') || 0;
                }
              }
              return 0;
            };
            const diff = getRestarts(b) - getRestarts(a);
            return diff !== 0 ? diff : a.dataset.name.localeCompare(b.dataset.name);
          }
          default: return 0;
        }
      });
      cards.forEach(card => grid.appendChild(card));
    }

    // applySearch kept as the oninput target — delegates to applyFilters
    function applySearch(q) {
      applyFilters();
    }

    function _isFilterDefault() {
      const term = document.getElementById('search-input').value.trim();
      const typeDefault  = activeTypeFilter.size === 1   && activeTypeFilter.has('all');
      const statusDefault = activeStatusFilter.size === 1 && activeStatusFilter.has('all');
      return typeDefault && statusDefault && !term;
    }

    function _updateClearChip() {
      const chip = document.getElementById('clear-filters-chip');
      if (chip) chip.style.display = _isFilterDefault() ? 'none' : '';
    }

    function clearFilters() {
      activeTypeFilter   = new Set(['all']);
      activeStatusFilter = new Set(['all']);
      _saveFilterSet('pm2-type-filter',   activeTypeFilter);
      _saveFilterSet('pm2-status-filter', activeStatusFilter);
      _syncTabActive('.type-tab',   activeTypeFilter);
      _syncTabActive('.status-tab', activeStatusFilter);
      const si = document.getElementById('search-input');
      if (si) si.value = '';
      applyFilters();
    }

    // ── View toggle (cards ↔ table) ────────────────────────────────────────
    let currentView = localStorage.getItem('pm2-view') || 'cards';

    function toggleView() {
      currentView = currentView === 'cards' ? 'table' : 'cards';
      localStorage.setItem('pm2-view', currentView);
      applyView();
    }

    function applyView(skipAnim) {
      const isTable = currentView === 'table';
      var gridEl = document.getElementById('grid');
      var tableEl = document.getElementById('table-wrap');
      var sortSel = document.getElementById('sort-select');
      if (sortSel) sortSel.style.display = isTable ? 'none' : '';
      if (navbar) navbar.updateSegToggle('view-seg', isTable ? 'table' : 'cards');
      if (isTable) {
        if (allItems.length) renderTableFromItems(allItems);
        else if (lastProcesses.length) renderTable(lastProcesses);
        if (lastMetrics) drawSparklines(lastMetrics);
        if (lastHealthMetrics) drawHealthSparklines(lastHealthMetrics);
        applyFilters();
      }
      if (skipAnim) {
        gridEl.style.display = isTable ? 'none' : '';
        tableEl.style.display = isTable ? '' : 'none';
        return;
      }
      // Crossfade: fade out old, swap, fade in new
      var outEl = isTable ? gridEl : tableEl;
      var inEl = isTable ? tableEl : gridEl;
      outEl.classList.add('view-fade-out');
      setTimeout(function() {
        outEl.style.display = 'none';
        outEl.classList.remove('view-fade-out');
        inEl.style.display = '';
        inEl.classList.add('view-fade-in');
        inEl.addEventListener('animationend', function handler() {
          inEl.classList.remove('view-fade-in');
          inEl.removeEventListener('animationend', handler);
        });
      }, 180);
    }

    // ── Unified Item table renderer (Phases 3+4) ──────────────────────────
    const TABLE_ADAPTER_META = {
      pm2:     { icon: '▶',  label: 'pm2'     },
      merge:   { icon: '⚡', label: 'merge'   },
      static:  { icon: '🔗', label: 'static'  },
      daemon:  { icon: '⚙', label: 'Daemon'  },
      cron:    { icon: '⏱', label: 'Cron'    },
      launchd: { icon: '⌘', label: 'LaunchD' },
    };

    function _itemTypeToFilterKey(type) {
      if (type === 'pm2' || type === 'merge' || type === 'static') return 'server';
      return type;
    }

    function _renderItemActions(item) {
      const n = _esc(item.name);
      const type = item.type;
      if (type === 'pm2' || type === 'merge') {
        const isOnline = item.statusBucket === 'active';
        return isOnline
          ? `<button class="btn btn-sm action-btn" onclick="doAction('restart','${n}',this)" title="Restart">↺</button>`
            + `<button class="btn btn-sm action-btn" onclick="doAction('reload','${n}',this)" title="Reload">⟳</button>`
            + `<button class="btn btn-sm btn-danger action-btn" onclick="doAction('stop','${n}',this)" title="Stop">■</button>`
            + `<button class="btn btn-sm" onclick="openLogs('${n}')" title="Logs">⋮</button>`
            + (type === 'pm2' ? `<button class="btn btn-sm" onclick="openInfo('${n}')" title="Info">ℹ</button>` : '')
          : `<button class="btn btn-sm btn-ok action-btn" onclick="doAction('start','${n}',this)" title="Start">▶</button>`
            + `<button class="btn btn-sm btn-danger action-btn" onclick="confirmDelete('${n}')" title="Delete">✕</button>`
            + `<button class="btn btn-sm" onclick="openLogs('${n}')" title="Logs">⋮</button>`;
      }
      if (type === 'static') {
        return `<button class="btn btn-sm" onclick="checkHealth('${n}')" title="Health check">♡</button>`
          + `<button class="btn btn-sm btn-danger" onclick="deleteStaticUrl('${n}')" title="Remove">✕</button>`;
      }
      if (type === 'daemon') {
        const isOnline = item.statusBucket === 'active';
        return isOnline
          ? `<button class="btn btn-sm btn-danger action-btn" onclick="doDaemonAction('stop','${n}',this)" title="Stop">■</button>`
            + `<button class="btn btn-sm action-btn" onclick="doDaemonAction('restart','${n}',this)" title="Restart">↺</button>`
            + `<button class="btn btn-sm" onclick="openDaemonLogs('${n}')" title="Logs">⋮</button>`
          : `<button class="btn btn-sm btn-ok action-btn" onclick="doDaemonAction('start','${n}',this)" title="Start">▶</button>`
            + `<button class="btn btn-sm btn-danger" onclick="confirmDeleteDaemon('${n}')" title="Delete">✕</button>`
            + `<button class="btn btn-sm" onclick="openDaemonLogs('${n}')" title="Logs">⋮</button>`;
      }
      if (type === 'cron') {
        const isActive = item.statusBucket === 'active';
        return (isActive
            ? `<button class="btn btn-sm btn-danger" onclick="doCronAction('disable','${n}',this)" title="Disable">○</button>`
            : `<button class="btn btn-sm btn-ok" onclick="doCronAction('enable','${n}',this)" title="Enable">●</button>`)
          + `<button class="btn btn-sm" onclick="doCronAction('run-now','${n}',this)" title="Run now">▶</button>`
          + `<button class="btn btn-sm" onclick="openCronDetail('${n}')" title="Detail">ℹ</button>`;
      }
      if (type === 'launchd') {
        const isLoaded = item.statusBucket === 'active' || (item.meta && item.meta.loaded);
        return isLoaded
          ? `<button class="btn btn-sm btn-danger action-btn" onclick="doLaunchdAction('stop','${n}',this)" title="Stop">■</button>`
            + `<button class="btn btn-sm action-btn" onclick="doLaunchdAction('kickstart','${n}',this)" title="Restart">↺</button>`
            + `<button class="btn btn-sm" onclick="openLaunchdLogs('${n}')" title="Logs">⋮</button>`
            + `<button class="btn btn-sm" onclick="openLaunchdDetail('${n}')" title="Detail">ℹ</button>`
          : `<button class="btn btn-sm btn-ok" onclick="doLaunchdAction('load','${n}',this)" title="Load">▶</button>`
            + `<button class="btn btn-sm" onclick="openLaunchdDetail('${n}')" title="Detail">ℹ</button>`;
      }
      return '';
    }

    const TABLE_COLS = {
      pm2: [
        { id: 'status',   label: '',          w: '2rem',   a: 'center', r: i => `<span class="tbl-status-dot ${i.status}" title="${i.status}"></span>` },
        { id: 'name',     label: 'name',      s: true,                  r: i => _esc(i.name) + (i.title ? ` <span class="proc-title">${_esc(i.title)}</span>` : '') },
        { id: 'port',     label: 'port',      w: '4.5rem',              r: i => i.meta.port ? `<a href="http://localhost:${i.meta.port}" target="_blank">:${i.meta.port}</a>` : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'uptime',   label: 'uptime',    w: '5rem',   s: true,     r: i => i.metrics.uptimeHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'cpu',      label: 'cpu',       w: '4rem',   a: 'right',  r: i => i.metrics.cpu != null ? i.metrics.cpu + '%' : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'mem',      label: 'mem',       w: '5rem',   a: 'right',  r: i => i.metrics.memoryHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'restarts', label: 'restarts',  w: '4.5rem', a: 'right',  r: i => `<span class="${(i.metrics.restarts||0)>=3?'tbl-warn':''}">${i.metrics.restarts||0}</span>` },
        { id: 'trend',    label: 'trend',     w: '5rem',                r: i => `<canvas class="tbl-sparkline" data-name="${_esc(i.name)}" width="80" height="20"></canvas>` },
        { id: 'actions',  label: '',          w: '8rem',                r: i => _renderItemActions(i) },
      ],
      merge: [
        { id: 'status',  label: '',       w: '2rem',  a: 'center', r: i => `<span class="tbl-status-dot ${i.status}" title="${i.status}"></span>` },
        { id: 'name',    label: 'name',   s: true,                 r: i => _esc(i.name) + (i.title ? ` <span class="proc-title">${_esc(i.title)}</span>` : '') },
        { id: 'members', label: 'parts',  w: '8rem',               r: i => _esc((i.meta.members||[]).join(', ')) },
        { id: 'actions', label: '',       w: '6rem',               r: i => _renderItemActions(i) },
      ],
      static: [
        { id: 'status',  label: '',       w: '2rem',  a: 'center', r: i => `<span class="tbl-status-dot" id="tbl-health-${_esc(i.name)}" style="background:var(--text-faint)" title="Static URL"></span>` },
        { id: 'name',    label: 'name',   s: true,                 r: i => `<span style="color:var(--accent);font-size:0.7rem">🔗</span> ${_esc(i.title||i.name)}` },
        { id: 'url',     label: 'url',                             r: i => i.meta.url ? `<a href="${_esc(i.meta.url)}" target="_blank" style="font-size:0.72rem">${_esc(i.meta.url.replace(/^https?:\/\//, ''))}</a>` : '—' },
        { id: 'health',  label: 'health', w: '5rem',               r: i => `<canvas class="tbl-sparkline health-sparkline" data-health-slug="${_esc(i.name)}" width="80" height="20"></canvas>` },
        { id: 'actions', label: '',       w: '5rem',               r: i => _renderItemActions(i) },
      ],
      daemon: [
        { id: 'status',   label: '',          w: '2rem',   a: 'center', r: i => `<span class="tbl-status-dot ${i.status}" title="${i.status}"></span>` },
        { id: 'name',     label: 'name',      s: true,                  r: i => _esc(i.name) + (i.title ? ` <span class="proc-title">${_esc(i.title)}</span>` : '') },
        { id: 'pid',      label: 'pid',       w: '4rem',   a: 'right',  r: i => i.meta.pid ? String(i.meta.pid) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'uptime',   label: 'uptime',    w: '5rem',   s: true,     r: i => i.metrics.uptimeHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'cpu',      label: 'cpu',       w: '4rem',   a: 'right',  r: i => i.metrics.cpu != null ? i.metrics.cpu + '%' : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'mem',      label: 'mem',       w: '5rem',   a: 'right',  r: i => i.metrics.memoryHuman || '<span style="color:var(--text-faint)">—</span>' },
        { id: 'restarts', label: 'restarts',  w: '4.5rem', a: 'right',  r: i => i.metrics.restarts||0 },
        { id: 'actions',  label: '',          w: '7rem',               r: i => _renderItemActions(i) },
      ],
      cron: [
        { id: 'status',   label: '',           w: '2rem',  a: 'center', r: i => `<span class="tbl-status-dot ${i.statusBucket==='active'?'online':'stopped'}" title="${i.status}"></span>` },
        { id: 'name',     label: 'name / id',  s: true,                 r: i => _esc(i.name) },
        { id: 'schedule', label: 'schedule',   w: '10rem',              r: i => i.meta.schedule || i.meta.scheduleRaw ? _esc(i.meta.schedule || i.meta.scheduleRaw) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'next',     label: 'next run',   w: '7rem',               r: i => i.meta.nextRunMs ? _esc(new Date(i.meta.nextRunMs).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})) : '—' },
        { id: 'command',  label: 'command',                             r: i => `<span style="font-size:0.65rem;color:var(--text-faint);font-family:monospace">${_esc((i.meta.command||'').slice(0,80))}${(i.meta.command||'').length>80?'…':''}</span>` },
        { id: 'actions',  label: '',           w: '6rem',               r: i => _renderItemActions(i) },
      ],
      launchd: [
        { id: 'status',   label: '',           w: '2rem',  a: 'center', r: i => `<span class="tbl-status-dot ${i.status}" title="${i.status}"></span>` },
        { id: 'name',     label: 'label',      s: true,                 r: i => _esc(i.name) },
        { id: 'schedule', label: 'schedule',   w: '10rem',              r: i => i.meta.schedule ? _esc(i.meta.schedule) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'pid',      label: 'pid',        w: '4rem',  a: 'right',  r: i => i.meta.pid ? String(i.meta.pid) : '<span style="color:var(--text-faint)">—</span>' },
        { id: 'exit',     label: 'last exit',  w: '5rem',  a: 'right',  r: i => i.meta.lastExitStatus == null ? '<span style="color:var(--text-faint)">—</span>' : i.meta.lastExitStatus === 0 ? '<span style="color:var(--green)">0</span>' : `<span style="color:var(--danger)">${i.meta.lastExitStatus}</span>` },
        { id: 'plist',    label: 'plist',      w: '14rem',              r: i => i.meta.plistPath ? `<span title="${_esc(i.meta.plistPath)}" style="font-size:0.6rem;color:var(--text-faint)">${_esc(i.meta.plistPath.replace(/^.*\/(.+\.plist)$/,'$1'))}</span>` : '—' },
        { id: 'actions',  label: '',           w: '7rem',               r: i => _renderItemActions(i) },
      ],
    };

    let _tblSortState = {}; // { [type]: { col, dir } }

    function renderTableFromItems(items) {
      const q = document.getElementById('search-input').value.trim().toLowerCase();
      const sectionsEl = document.getElementById('table-sections');
      if (!sectionsEl) return;

      // Group by type, preserving order
      const byType = {};
      const typeOrder = [];
      for (const item of items) {
        if (!byType[item.type]) { byType[item.type] = []; typeOrder.push(item.type); }
        byType[item.type].push(item);
      }

      let html = '';
      for (const type of typeOrder) {
        let typeItems = byType[type];
        const meta = TABLE_ADAPTER_META[type] || { icon: '?', label: type };
        const cols = TABLE_COLS[type];
        if (!cols) continue;

        // Apply type-level sort
        const sort = _tblSortState[type];
        if (sort) {
          typeItems = [...typeItems].sort((a, b) => {
            const col = cols.find(c => c.id === sort.col);
            if (!col) return 0;
            // Simple string sort on rendered text — good enough for name, schedule, etc.
            const av = sort.col === 'name' ? a.name : sort.col === 'uptime' ? (a.metrics.uptimeMs||0) : sort.col === 'cpu' ? (a.metrics.cpu||0) : sort.col === 'mem' ? (a.metrics.memoryBytes||0) : sort.col === 'restarts' ? (a.metrics.restarts||0) : 0;
            const bv = sort.col === 'name' ? b.name : sort.col === 'uptime' ? (b.metrics.uptimeMs||0) : sort.col === 'cpu' ? (b.metrics.cpu||0) : sort.col === 'mem' ? (b.metrics.memoryBytes||0) : sort.col === 'restarts' ? (b.metrics.restarts||0) : 0;
            const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
            return sort.dir === 'desc' ? -cmp : cmp;
          });
        }

        html += `<div class="table-section" data-type="${type}">`;
        html += `<div class="table-section-header"><span class="type-icon">${meta.icon}</span><span class="type-label">${meta.label}</span><span class="type-count">(${typeItems.length})</span></div>`;
        html += `<table class="process-table"><thead><tr>`;
        for (const col of cols) {
          const styles = [col.w ? `width:${col.w}` : '', col.a ? `text-align:${col.a}` : ''].filter(Boolean).join(';');
          const isSorted = sort && sort.col === col.id;
          const sortClass = isSorted ? (sort.dir === 'asc' ? ' sorted-asc' : ' sorted-desc') : '';
          html += `<th${styles ? ` style="${styles}"` : ''}>${col.s ? `<button class="tbl-sort-btn${sortClass}" data-type="${type}" data-col="${col.id}" onclick="tblToggleSort('${type}','${col.id}')">${col.label}</button>` : col.label}</th>`;
        }
        html += `</tr></thead><tbody>`;
        for (const item of typeItems) {
          const sf = [item.name, item.title, item.meta?.command, item.meta?.url, item.meta?.schedule].filter(Boolean).join(' ').toLowerCase();
          const vis = !q || sf.includes(q);
          html += `<tr data-id="${_esc(item.id)}" data-type="${item.type}" data-status="${item.statusBucket}" style="display:${vis?'':'none'}">`;
          for (const col of cols) {
            const isActionsCol = col.id === 'actions';
            html += `<td${isActionsCol ? ' class="tbl-actions"' : ''}${col.a ? ` style="text-align:${col.a}"` : ''}>${col.r(item)}</td>`;
          }
          html += `</tr>`;
        }
        html += `</tbody></table></div>`;
      }
      sectionsEl.innerHTML = html;
    }

    function tblToggleSort(type, colId) {
      const cur = _tblSortState[type];
      if (cur && cur.col === colId) {
        _tblSortState[type] = { col: colId, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        _tblSortState[type] = { col: colId, dir: 'asc' };
      }
      renderTableFromItems(allItems);
      applyFilters();
    }

    function renderTable(procs) {
      const q = document.getElementById('search-input').value.trim().toLowerCase();
      const tbody = document.getElementById('table-body');
      if (!tbody) return; // superseded by renderTableFromItems — no-op if element absent
      const groups = DASH_CONFIG.groups || {};
      const entries = DASH_CONFIG.entries || {};
      const grouped = localStorage.getItem('pm2-group-view') === 'grouped';

      function renderRow(p) {
        const visible = !q || p.name.toLowerCase().includes(q) || (p._title || '').toLowerCase().includes(q);
        const isOnline = p.status === 'online';
        const port = p.port ? '<a href="http://localhost:' + p.port + '" target="_blank">:' + p.port + '</a>' : '—';
        const cfg = entries[p.name] || {};
        const colorDot = cfg.color ? '<span class="color-dot" style="background:' + cfg.color + ';width:8px;height:8px" onclick="event.stopPropagation();toggleColorPicker(\''+p.name+'\',this)"></span>' : '';
        const titleDisplay = cfg.title ? '<span class="proc-title" style="margin-left:4px">' + cfg.title + '</span>' : '';
        const grp = cfg.group ? groups[cfg.group] : null;
        const groupLabel = grp ? '<span style="font-size:0.6rem;color:var(--text-faint)">' + (grp.emoji || '') + ' ' + (grp.name || cfg.group) + '</span>' : '';
        const actions = isOnline
          ? '<button class="btn btn-sm action-btn" onclick="doAction(\'restart\',\''+p.name+'\',this)" title="Restart">↺</button>'
            + '<button class="btn btn-sm action-btn" onclick="doAction(\'reload\',\''+p.name+'\',this)" title="Reload">⟳</button>'
            + '<button class="btn btn-sm btn-danger action-btn" onclick="doAction(\'stop\',\''+p.name+'\',this)" title="Stop">■</button>'
            + '<button class="btn btn-sm" onclick="openLogs(\''+p.name+'\')" title="Logs">⋮</button>'
            + '<button class="btn btn-sm" onclick="openInfo(\''+p.name+'\')" title="Info">ℹ</button>'
          : '<button class="btn btn-sm btn-ok action-btn" onclick="doAction(\'start\',\''+p.name+'\',this)" title="Start">▶</button>'
            + '<button class="btn btn-sm btn-danger action-btn" onclick="confirmDelete(\''+p.name+'\')" title="Delete">✕</button>'
            + '<button class="btn btn-sm" onclick="openLogs(\''+p.name+'\')" title="Logs">⋮</button>';
        return '<tr data-name="' + p.name + '" style="display:' + (visible ? '' : 'none') + '">'
          + '<td class="tbl-drag"><span class="drag-handle" draggable="true" ondragstart="onDragStart(event,\''+p.name+'\')" style="opacity:0.3;cursor:grab">⠿</span></td>'
          + '<td>' + colorDot + '<span class="tbl-status-dot ' + p.status + '" title="' + p.status + '"></span></td>'
          + '<td class="tbl-name">' + p.name + titleDisplay + '</td>'
          + '<td style="color:var(--text-faint)">#' + p.id + '</td>'
          + '<td class="tbl-port">' + port + '</td>'
          + '<td>' + (p.uptime_human || '—') + '</td>'
          + '<td>' + (p.cpu_percent != null ? p.cpu_percent + '%' : '—') + '</td>'
          + '<td>' + (p.memory_human || '—') + '</td>'
          + '<td class="' + ((p.restarts||0) >= 3 ? 'tbl-warn' : '') + '">' + (p.restarts || 0) + '</td>'
          + '<td><canvas class="tbl-sparkline" data-name="' + p.name + '" width="80" height="20"></canvas></td>'
          + '<td>' + groupLabel + '</td>'
          + '<td class="tbl-actions">' + actions + '</td>'
          + '</tr>';
      }

      function renderStaticRow(slug, u) {
        const key = 'static:' + slug;
        const visible = !q || slug.toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q) || (u.url || '').toLowerCase().includes(q);
        const grp = u.group ? groups[u.group] : null;
        const groupLabel = grp ? '<span style="font-size:0.6rem;color:var(--text-faint)">' + (grp.emoji || '') + ' ' + (grp.name || u.group) + '</span>' : '';
        const healthDot = '<span class="tbl-status-dot" id="tbl-health-' + slug + '" style="background:var(--text-faint)" title="Static URL"></span>';
        return '<tr data-name="' + key + '" style="display:' + (visible ? '' : 'none') + '">'
          + '<td class="tbl-drag"><span class="drag-handle" draggable="true" ondragstart="onDragStart(event,\'' + key + '\')" style="opacity:0.3;cursor:grab">⠿</span></td>'
          + '<td>' + healthDot + '</td>'
          + '<td class="tbl-name"><span style="color:var(--accent);font-size:0.7rem">🔗</span> ' + (u.title || slug) + '</td>'
          + '<td style="color:var(--text-faint)">—</td>'
          + '<td class="tbl-port"><a href="' + (u.url || '') + '" target="_blank" style="font-size:0.72rem">' + (u.url || '').replace(/^https?:\/\//, '') + '</a></td>'
          + '<td>—</td><td>—</td><td>—</td><td>—</td>'
          + '<td><canvas class="tbl-sparkline health-sparkline" data-health-slug="' + slug + '" width="80" height="20"></canvas></td>'
          + '<td>' + groupLabel + '</td>'
          + '<td class="tbl-actions">'
          + '<button class="btn btn-sm" onclick="checkHealth(\'' + slug + '\')" title="Health check">♡</button>'
          + '<button class="btn btn-sm btn-danger" onclick="deleteStaticUrl(\'' + slug + '\')" title="Remove">✕</button>'
          + '</td></tr>';
      }

      // Collect static URL entries
      var staticUrls = DASH_CONFIG.staticUrls || {};
      var staticEntries = Object.entries(staticUrls);

      if (grouped && Object.keys(groups).length > 0) {
        // Partition procs + static URLs into groups
        const groupMap = {};
        const ungrouped = [];
        for (const p of procs) {
          const g = (entries[p.name] || {}).group;
          if (g && groups[g]) {
            if (!groupMap[g]) groupMap[g] = [];
            groupMap[g].push({ type: 'proc', data: p });
          } else {
            ungrouped.push({ type: 'proc', data: p });
          }
        }
        for (const [slug, u] of staticEntries) {
          const g = u.group;
          if (g && groups[g]) {
            if (!groupMap[g]) groupMap[g] = [];
            groupMap[g].push({ type: 'static', slug: slug, data: u });
          } else {
            ungrouped.push({ type: 'static', slug: slug, data: u });
          }
        }
        const groupOrder = Object.entries(groups).sort(function(a, b) { return (a[1].order ?? 999) - (b[1].order ?? 999); });
        let html = '';
        for (const [gid, ginfo] of groupOrder) {
          const items = groupMap[gid];
          if (!items || !items.length) continue;
          html += '<tr class="tbl-group-header"><td colspan="12"><span class="group-emoji">' + (ginfo.emoji || '📦') + '</span> <strong>' + (ginfo.name || gid) + '</strong> <span style="color:var(--text-faint);font-size:0.7rem">(' + items.length + ')</span>' + (ginfo.notes ? ' <span style="color:var(--text-faint);font-size:0.65rem">— ' + ginfo.notes + '</span>' : '') + '</td></tr>';
          html += items.map(function(item) {
            return item.type === 'static' ? renderStaticRow(item.slug, item.data) : renderRow(item.data);
          }).join('');
        }
        if (ungrouped.length) {
          html += '<tr class="tbl-group-header"><td colspan="12"><span class="group-emoji">📋</span> <strong>Ungrouped</strong> <span style="color:var(--text-faint);font-size:0.7rem">(' + ungrouped.length + ')</span></td></tr>';
          html += ungrouped.map(function(item) {
            return item.type === 'static' ? renderStaticRow(item.slug, item.data) : renderRow(item.data);
          }).join('');
        }
        tbody.innerHTML = html;
      } else {
        var html = procs.map(renderRow).join('');
        html += staticEntries.map(function(e) { return renderStaticRow(e[0], e[1]); }).join('');
        tbody.innerHTML = html;
      }
    }

    // ── Open cwd in Finder/Files ───────────────────────────────────────────
    async function openCwd(path) {
      if (!path) return;
      try {
        const res = await fetch('/api/open-cwd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (!data.ok) toast('Could not open: ' + (data.error || '?'), 'err');
      } catch { toast('Request failed', 'err'); }
    }

    // Initialise view (skip animation on page load)
    applyView(true);

    // Restore persisted filter state (tabs + sort select)
    (function() {
      _syncTabActive('.type-tab',   activeTypeFilter);
      _syncTabActive('.status-tab', activeStatusFilter);
      if (activeSortOrder) {
        var sel = document.getElementById('sort-select');
        if (sel) sel.value = activeSortOrder;
      }
    })();

    showSkeletons(Math.max(window.__SYS_PIER__.processCount, 3));
    refresh();
    setInterval(refresh, 5000);

    // ── Actions ────────────────────────────────────────────────────────────
    async function doAction(cmd, name, btn) {
      const label = btn?.textContent?.trim();
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="btn-spinner"></span> ${cmd}`;
      }
      try {
        const res = await fetch('/api/items/pm2/' + encodeURIComponent(name) + '/' + encodeURIComponent(cmd), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        toast(data.ok ? cmd + ' ' + name + ' ✓' : 'Error: ' + (data.error || '?'), data.ok ? 'ok' : 'err');
        if (data.ok) setTimeout(refresh, 800);
      } catch { toast('Request failed', 'err'); }
      finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
      }
    }

    // Restart sys-pier-backend itself. Hits a dedicated endpoint that
    // bypasses the NO_SELF_MANAGE guard by design — the server flushes
    // {ok:true} first, then process.exit(0)s on a short delay so the
    // response actually reaches the browser. pm2's autorestart picks it
    // back up (restart_delay: 2000 in ecosystem.config.cjs).
    async function doSelfRestart() {
      if (!confirm('Restart the sys-pier dashboard backend?\n\nThis will briefly disconnect (~3-5s). The page will auto-reload when it is back.')) return;
      toast('Restarting dashboard… page will auto-reload', 'ok');
      try {
        await fetch('/api/self/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch { /* server already shutting down — expected */ }
      // Poll /api/info until the new instance answers, then hard-reload.
      const start = Date.now();
      const probe = async () => {
        if (Date.now() - start > 30000) { toast('Restart timed out — check pm2 logs', 'err'); return; }
        try {
          const r = await fetch('/api/info', { cache: 'no-store' });
          if (r.ok) { location.reload(); return; }
        } catch {}
        setTimeout(probe, 500);
      };
      setTimeout(probe, 1500); // give the old process time to actually exit
    }

    function confirmDelete(name) {
      if (confirm('Delete "' + name + '"?\n\nThis removes it from pm2 entirely. You will need to re-run its ecosystem file to add it back.')) {
        doAction('delete', name, null);
      }
    }

    async function doSignal(btn) {
      const row = btn.closest('[data-name]');
      const name = row.dataset.name;
      const sig  = row.querySelector('.signal-select').value;
      if (!sig) { toast('Select a signal first', 'err'); return; }
      btn.disabled = true;
      try {
        const res = await fetch('/api/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, signal: sig }),
        });
        const data = await res.json();
        toast(data.ok ? `↯ ${sig} → ${name} ✓` : 'Error: ' + (data.error || '?'), data.ok ? 'ok' : 'err');
      } catch { toast('Request failed', 'err'); }
      finally { btn.disabled = false; row.querySelector('.signal-select').value = ''; }
    }

    async function doScale(btn) {
      const row = btn.closest('[data-name]');
      const name = row.dataset.name;
      const n    = parseInt(row.querySelector('.scale-input').value, 10);
      if (!n || n < 1) { toast('Enter a valid instance count', 'err'); return; }
      btn.disabled = true;
      try {
        const res = await fetch('/api/scale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, instances: n }),
        });
        const data = await res.json();
        toast(data.ok ? `⇱ Scaled ${name} to ${n} ✓` : 'Error: ' + (data.error || '?'), data.ok ? 'ok' : 'err');
        if (data.ok) setTimeout(refresh, 800);
      } catch { toast('Request failed', 'err'); }
      finally { btn.disabled = false; }
    }

    async function saveList() {
      try {
        const res = await fetch('/api/save', { method: 'POST' });
        const data = await res.json();
        toast(data.ok ? '💾 Process list saved ✓' : 'Save failed: ' + data.error, data.ok ? 'ok' : 'err');
      } catch { toast('Request failed', 'err'); }
    }

    async function doResurrect() {
      if (!confirm('Run pm2 resurrect?\n\nThis restores all processes from the last pm2 save dump.')) return;
      try {
        const res = await fetch('/api/resurrect', { method: 'POST' });
        const data = await res.json();
        toast(data.ok ? '⟳ Resurrected ✓' : 'Resurrect failed: ' + data.error, data.ok ? 'ok' : 'err');
        if (data.ok) setTimeout(refresh, 1200);
      } catch { toast('Request failed', 'err'); }
    }

    // ── Logs ───────────────────────────────────────────────────────────────
    let logPollTimer;
    let currentLogName = '';

    async function openLogs(name) {
      currentLogName = name;
      document.getElementById('log-name').textContent = name;
      document.getElementById('log-modal').classList.add('open');
      document.getElementById('log-output').textContent = 'Loading…';
      await fetchLogs(name);
      logPollTimer = setInterval(() => fetchLogs(name), 3000);
    }

    async function fetchLogs(name) {
      const lines = document.getElementById('log-lines').value || 80;
      try {
        const res = await fetch('/api/logs/' + encodeURIComponent(name) + '?lines=' + lines);
        const text = await res.text();
        const el = document.getElementById('log-output');
        el.textContent = text;
        el.scrollTop = el.scrollHeight;
      } catch {}
    }

    // ── Info ────────────────────────────────────────────────────────────────
    async function openInfo(name) {
      document.getElementById('info-name').textContent = name;
      document.getElementById('info-modal').classList.add('open');
      document.getElementById('info-body').innerHTML =
        '<div style="padding:2rem;text-align:center;color:var(--text-faint)"><span class="btn-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block"></span></div>';

      try {
        const [procRes, envRes] = await Promise.all([
          fetch('/api/describe/' + encodeURIComponent(name)),
          fetch('/api/env/' + encodeURIComponent(name)),
        ]);
        const p = await procRes.json();
        const envData = await envRes.json();
        if (p.error) { document.getElementById('info-body').textContent = p.error; return; }

        const row = (label, val, cls = '') =>
          '<div class="info-row">' +
          '<span class="info-key">' + label + '</span>' +
          '<span class="info-val ' + cls + '">' + (val ?? '—') + '</span>' +
          '</div>';

        const envRows = Object.entries(envData.env || {}).length
          ? Object.entries(envData.env).map(([k, v]) => row(k, v)).join('')
          : '<div class="info-row"><span class="info-val" style="color:var(--text-faint);font-style:italic">no user-set env vars</span></div>';

        const fmtSize = (b) => b == null ? '—' : b < 1024*1024 ? Math.round(b/1024) + ' KB' : (b/1024/1024).toFixed(1) + ' MB';
        const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : '—';

        document.getElementById('info-body').innerHTML =
          '<div class="info-section">' +
            '<div class="info-section-title">Process</div>' +
            row('name', p.name) + row('status', p.status, p.status) +
            row('pid', p.pid) + row('pm2 id', p.id) +
            row('exec mode', p.exec_mode) + row('instances', p.instances) +
            row('restarts', p.restarts) +
            row('node version', p.node_version) +
            row('created at', fmtDate(p.created_at)) +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Metrics</div>' +
            row('uptime', p.uptime_human) +
            row('cpu', p.cpu_percent != null ? p.cpu_percent + '%' : '—') +
            row('memory', p.memory_human) +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Configuration</div>' +
            row('watcher', p.watcher ? '✓ enabled' : 'disabled') +
            row('max memory restart', p.max_memory_restart || '—') +
            row('cron restart', p.cron_restart || '—') +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Paths &amp; Log Sizes</div>' +
            row('cwd', p.cwd) + row('script', p.script) +
            row('stdout log', (p.log_out || '—') + (p.log_out_size != null ? '  (' + fmtSize(p.log_out_size) + ')' : '')) +
            row('stderr log', (p.log_err || '—') + (p.log_err_size != null ? '  (' + fmtSize(p.log_err_size) + ')' : '')) +
          '</div>' +
          '<div class="info-section">' +
            '<div class="info-section-title">Environment (user-set — secrets redacted)</div>' +
            envRows +
          '</div>';
      } catch (e) {
        document.getElementById('info-body').textContent = 'Failed to load: ' + e.message;
      }
    }

    // ── Daemon actions ──────────────────────────────────────────────────────
    async function doDaemonAction(cmd, key, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const res = await fetch('/api/items/daemon/' + encodeURIComponent(key) + '/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Unknown error');
        await refresh();
      } catch (e) {
        alert('Daemon action failed: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; }
      }
    }

    async function confirmDeleteDaemon(key) {
      if (!confirm('Remove daemon "' + key + '" from registry? This will stop it if running.')) return;
      try {
        const res = await fetch('/api/daemons/' + encodeURIComponent(key), { method: 'DELETE' });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Delete failed');
        await refresh();
      } catch (e) {
        alert('Remove failed: ' + e.message);
      }
    }

    // ── Daemon logs ─────────────────────────────────────────────────────────
    var currentDaemonLogKey = null;
    var currentDaemonLogTab = 'out';

    function setDaemonLogTab(tab) {
      currentDaemonLogTab = tab;
      document.getElementById('daemon-log-tab-out').style.opacity = tab === 'out' ? '1' : '0.5';
      document.getElementById('daemon-log-tab-err').style.opacity = tab === 'err' ? '1' : '0.5';
      fetchDaemonLogs(currentDaemonLogKey, tab);
    }

    async function openDaemonLogs(key) {
      currentDaemonLogKey = key;
      currentDaemonLogTab = 'out';
      document.getElementById('daemon-log-tab-out').style.opacity = '1';
      document.getElementById('daemon-log-tab-err').style.opacity = '0.5';
      document.getElementById('daemon-log-name').textContent = key;
      document.getElementById('daemon-log-output').textContent = 'Loading…';
      document.getElementById('daemon-log-modal').classList.add('open');
      await fetchDaemonLogs(key, 'out');
    }

    async function fetchDaemonLogs(key, tab) {
      if (!key) return;
      const lines = document.getElementById('daemon-log-lines').value || 80;
      const endpoint = tab === 'err'
        ? '/api/daemons/' + encodeURIComponent(key) + '/errlog?lines=' + lines
        : '/api/daemons/' + encodeURIComponent(key) + '/logs?lines=' + lines;
      try {
        const res = await fetch(endpoint);
        const text = await res.text();
        const el = document.getElementById('daemon-log-output');
        el.textContent = text;
        el.scrollTop = el.scrollHeight;
      } catch (e) {
        document.getElementById('daemon-log-output').textContent = 'Error: ' + e.message;
      }
    }

    // ── Daemon info modal ───────────────────────────────────────────────────
    async function openDaemonInfo(key) {
      document.getElementById('daemon-info-name').textContent = key;
      document.getElementById('daemon-info-body').innerHTML = 'Loading…';
      document.getElementById('daemon-info-modal').classList.add('open');
      try {
        const res = await fetch('/api/daemons/' + encodeURIComponent(key));
        const d = await res.json();
        function row(label, val) {
          var th = '<th style="text-align:left;color:var(--text-muted);padding:3px 8px 3px 0;width:35%">' + label + '</th>';
          return '<tr>' + th + '<td>' + val + '</td></tr>';
        }
        function code(s) { return '<code style="word-break:break-all">' + _esc(s) + '</code>'; }
        var envKeys = Object.keys(d.env || {});
        var html = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">'
          + row('Key', code(d.key))
          + row('Status', _esc(d.status) + (d.pid ? ' (PID ' + d.pid + ')' : ''))
          + row('Command', code(d.command))
          + row('Working dir', code(d.workdir || '—'))
          + row('Uptime', _esc(d.uptime_human || '—'))
          + row('Restarts', d.restarts + (d.autoRestart ? ' (auto, max ' + d.maxRestarts + ')' : ''))
          + row('stdout', code(d.logFile))
          + row('stderr', code(d.errFile))
          + (envKeys.length ? row('Env', '<pre style="margin:0;font-size:0.7rem">' + _esc(JSON.stringify(d.env, null, 2)) + '</pre>') : '')
          + '</table>';
        html += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem" id="daemon-info-actions"></div>';
        document.getElementById('daemon-info-body').innerHTML = html;
        var actEl = document.getElementById('daemon-info-actions');
        var logsBtn = document.createElement('button');
        logsBtn.className = 'btn'; logsBtn.textContent = '⋮ Logs';
        logsBtn.onclick = function() { openDaemonLogs(d.key); };
        actEl.appendChild(logsBtn);
        if (d.status === 'online') {
          var rstBtn = document.createElement('button');
          rstBtn.className = 'btn btn-warn action-btn'; rstBtn.textContent = '↺ Restart';
          rstBtn.onclick = function() { doDaemonAction('restart', d.key, rstBtn); };
          actEl.appendChild(rstBtn);
        }
      } catch (e) {
        document.getElementById('daemon-info-body').textContent = 'Error: ' + e.message;
      }
    }

    // ── Daemon create modal ─────────────────────────────────────────────────
    function openCreateDaemonModal() {
      document.getElementById('dc-key').value = '';
      document.getElementById('dc-command').value = '';
      document.getElementById('dc-workdir').value = '';
      document.getElementById('dc-autorestart').value = 'false';
      document.getElementById('dc-maxrestarts').value = '5';
      document.getElementById('dc-error').style.display = 'none';
      document.getElementById('daemon-create-modal').classList.add('open');
      setTimeout(() => document.getElementById('dc-key').focus(), 50);
    }

    async function submitCreateDaemon(andStart) {
      const key = document.getElementById('dc-key').value.trim();
      const command = document.getElementById('dc-command').value.trim();
      const workdir = document.getElementById('dc-workdir').value.trim();
      const autoRestart = document.getElementById('dc-autorestart').value === 'true';
      const maxRestarts = parseInt(document.getElementById('dc-maxrestarts').value, 10) || 5;
      const errEl = document.getElementById('dc-error');
      errEl.style.display = 'none';
      if (!key || !command) { errEl.textContent = 'Key and command are required.'; errEl.style.display = 'block'; return; }
      try {
        const res = await fetch('/api/daemons', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, command, workdir: workdir || undefined, autoRestart, maxRestarts }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Create failed');
        if (andStart) await doDaemonAction('start', key, null);
        closeModal('daemon-create-modal');
        await refresh();
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
    }

    // ── LaunchD actions ──────────────────────────────────────────────────────
    async function doLaunchdAction(cmd, label, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const res = await fetch('/api/items/launchd/' + encodeURIComponent(label) + '/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Unknown error');
        const msgs = { load: 'Loaded', unload: 'Unloaded', kickstart: 'Restarted', stop: 'Stopped' };
        toast((msgs[cmd] || cmd) + ': ' + label, 'ok');
        refresh();
      } catch (e) { toast('launchctl failed: ' + e.message, 'err'); }
      finally { if (btn) { btn.disabled = false; } }
    }

    async function openLaunchdDetail(label) {
      // Show modal immediately with loading state (~1.5s fetch)
      document.getElementById('launchd-detail-name').textContent = label;
      const body = document.getElementById('launchd-detail-body');
      body.innerHTML = '<div style="color:var(--text-faint);padding:0.5rem 0;display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:12px;border:2px solid var(--text-faint);border-top-color:var(--accent);border-radius:50%;animation:spin 0.6s linear infinite"></span>Loading…</div>';
      document.getElementById('launchd-detail-modal').classList.add('open');

      let agent;
      try {
        const res = await fetch('/api/launchd/' + encodeURIComponent(label));
        if (!res.ok) throw new Error('Not found');
        agent = await res.json();
      } catch (e) {
        body.innerHTML = '<div style="color:var(--danger)">Failed to load details: ' + e.message + '</div>';
        return;
      }

      document.getElementById('launchd-detail-name').textContent = agent._title || label;
      body.innerHTML = '';

      const rows = [
        ['Label', agent.label],
        ['Status', agent.status + (agent.pid ? ' (PID ' + agent.pid + ')' : '')],
        ['Loaded', agent.loaded ? 'Yes' : 'No'],
        ['Trigger', agent.schedule || (agent.runAtLoad ? 'On load' : '—')],
        ['KeepAlive', agent.keepAlive ? 'Yes — auto-restarted by launchd' : 'No'],
        ['Command', agent.command],
        ['Plist', agent.plistPath],
        ['Stdout', agent.stdoutPath || '—'],
        ['Stderr', agent.stderrPath || '—'],
        ['Last exit', agent.lastExitStatus != null ? String(agent.lastExitStatus) : '—'],
      ];

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse';
      for (const [lbl, val] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.style.cssText = 'color:var(--text-faint);width:80px;padding:3px 8px 3px 0;vertical-align:top;white-space:nowrap';
        td1.textContent = lbl;
        const td2 = document.createElement('td');
        td2.style.cssText = 'padding:3px 0;font-family:var(--font-mono);word-break:break-all;font-size:0.75rem';
        td2.textContent = val;
        tr.appendChild(td1); tr.appendChild(td2); table.appendChild(tr);
      }
      body.appendChild(table);

      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'margin-top:12px;display:flex;gap:6px;flex-wrap:wrap';
      const close = () => closeModal('launchd-detail-modal');

      if (agent.loaded) {
        if (agent.status === 'online') {
          const ksBtn = document.createElement('button');
          ksBtn.className = 'btn btn-warn'; ksBtn.textContent = '↺ Restart';
          ksBtn.onclick = () => { close(); doLaunchdAction('kickstart', label, null); };
          actionsDiv.appendChild(ksBtn);
          const stBtn = document.createElement('button');
          stBtn.className = 'btn btn-danger'; stBtn.textContent = '■ Stop';
          stBtn.onclick = () => { close(); doLaunchdAction('stop', label, null); };
          actionsDiv.appendChild(stBtn);
        } else {
          const ksBtn = document.createElement('button');
          ksBtn.className = 'btn btn-ok'; ksBtn.textContent = '▶ Start';
          ksBtn.onclick = () => { close(); doLaunchdAction('kickstart', label, null); };
          actionsDiv.appendChild(ksBtn);
        }
        const ulBtn = document.createElement('button');
        ulBtn.className = 'btn'; ulBtn.textContent = '⏏ Unload';
        ulBtn.onclick = () => { close(); doLaunchdAction('unload', label, null); };
        actionsDiv.appendChild(ulBtn);
      } else {
        const lBtn = document.createElement('button');
        lBtn.className = 'btn btn-ok'; lBtn.textContent = '⬆ Load';
        lBtn.onclick = () => { close(); doLaunchdAction('load', label, null); };
        actionsDiv.appendChild(lBtn);
      }

      if (agent.stdoutPath) {
        const logBtn = document.createElement('button');
        logBtn.className = 'btn'; logBtn.textContent = '⋮ Logs';
        logBtn.onclick = () => { close(); openLaunchdLogs(label, agent.stdoutPath); };
        actionsDiv.appendChild(logBtn);
      }
      body.appendChild(actionsDiv);
      document.getElementById('launchd-detail-modal').classList.add('open');
    }

    async function openLaunchdLogs(label, logPath) {
      // Open modal immediately with loading state, then populate
      const nameEl = document.getElementById('daemon-log-name');
      const outEl  = document.getElementById('daemon-log-output');
      if (nameEl) nameEl.textContent = label;
      if (outEl)  outEl.textContent  = 'Loading…';
      document.getElementById('daemon-log-modal').classList.add('open');
      try {
        const res  = await fetch('/api/launchd/' + encodeURIComponent(label) + '/logs');
        const text = await res.text();
        if (outEl) outEl.textContent = text || '(no log output)';
      } catch (e) {
        if (outEl) outEl.textContent = 'Failed to load logs: ' + e.message;
      }
    }

    // ── Cron actions ─────────────────────────────────────────────────────────
    async function doCronAction(cmd, id, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const res = await fetch('/api/items/cron/' + encodeURIComponent(id) + '/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Unknown error');
        toast(cmd === 'run-now' ? 'Running now…' : (cmd === 'enable' ? 'Cron enabled' : 'Cron disabled'), 'ok');
        refresh();
      } catch (e) { toast('Cron action failed: ' + e.message, 'err'); }
      finally { if (btn) { btn.disabled = false; } }
    }

    async function openCronDetail(id) {
      // Fetch the cron entry data
      let entry;
      try {
        const res = await fetch('/api/crons/' + encodeURIComponent(id));
        if (!res.ok) throw new Error('Not found');
        entry = await res.json();
      } catch (e) { toast('Failed to load cron details', 'err'); return; }

      document.getElementById('cron-detail-name').textContent = entry._title || id;
      const body = document.getElementById('cron-detail-body');
      body.innerHTML = '';

      const rows = [
        ['ID', entry.id],
        ['Schedule', entry.schedule],
        ['Human', entry.humanSchedule],
        ['Next run', entry.nextRunMs ? new Date(entry.nextRunMs).toLocaleString() : '—'],
        ['Status', entry.enabled ? 'Enabled' : 'Disabled (commented out)'],
        ['Command', entry.command],
      ];

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse';
      for (const [label, val] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.style.cssText = 'color:var(--text-faint);width:90px;padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap';
        td1.textContent = label;
        const td2 = document.createElement('td');
        td2.style.cssText = 'padding:4px 0;font-family:var(--font-mono);word-break:break-all';
        td2.textContent = val;
        tr.appendChild(td1); tr.appendChild(td2); table.appendChild(tr);
      }
      body.appendChild(table);

      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'margin-top:12px;display:flex;gap:6px;flex-wrap:wrap';

      if (entry.enabled) {
        const runBtn = document.createElement('button');
        runBtn.className = 'btn btn-ok';
        runBtn.textContent = '▶ Run Now';
        runBtn.onclick = () => { closeModal('cron-detail-modal'); doCronAction('run-now', id, null); };
        actionsDiv.appendChild(runBtn);

        const disBtn = document.createElement('button');
        disBtn.className = 'btn';
        disBtn.textContent = '⏸ Disable';
        disBtn.onclick = () => { closeModal('cron-detail-modal'); doCronAction('disable', id, null); };
        actionsDiv.appendChild(disBtn);
      } else {
        const enBtn = document.createElement('button');
        enBtn.className = 'btn btn-ok';
        enBtn.textContent = '▶ Enable';
        enBtn.onclick = () => { closeModal('cron-detail-modal'); doCronAction('enable', id, null); };
        actionsDiv.appendChild(enBtn);
      }
      body.appendChild(actionsDiv);
      document.getElementById('cron-detail-modal').classList.add('open');
    }

    // ── Help ────────────────────────────────────────────────────────────────
    function openHelp() {
      document.getElementById('help-modal').classList.add('open');
    }

    // ── Modals ─────────────────────────────────────────────────────────────
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
      if (id === 'log-modal') clearInterval(logPollTimer);
    }

    document.querySelectorAll('.backdrop').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target === el) closeModal(el.id); });
    });

    // ── NavbarShortcuts — data-driven header buttons + keyboard shortcuts ──
    // Each action defines a button AND its keyboard shortcut in one place.
    // The class renders buttons, hint bar, and wires up the keydown listener.
    class NavbarShortcuts {
      constructor({ containerId, hintBarId, actions, escHandler }) {
        this.container = document.getElementById(containerId);
        this.hintBar = document.getElementById(hintBarId);
        this.actions = actions;
        this.escHandler = escHandler;
        this._btnMap = {};
        this._render();
        this._renderHintBar();
        this._attachKeyboard();
      }

      _render() {
        this.container.innerHTML = '';
        var currentGroup = null;
        for (const a of this.actions) {
          if (a.type === 'hidden') continue;
          if (a.type === 'nav-sep') {
            currentGroup = null;
            var sep = document.createElement('span');
            sep.className = 'nav-sep';
            this.container.appendChild(sep);
            continue;
          }
          if (a.type === 'separator') {
            currentGroup = null;
            const sep = document.createElement('span');
            sep.className = a.className || 'live-indicator';
            sep.innerHTML = a.html || '';
            this.container.appendChild(sep);
            continue;
          }
          if (a.type === 'seg-toggle') {
            currentGroup = null;
            var toggle = document.createElement('span');
            toggle.className = 'seg-toggle';
            if (a.id) toggle.id = a.id;
            toggle.title = a.title || '';
            for (var oi = 0; oi < a.options.length; oi++) {
              var opt = a.options[oi];
              var ob = document.createElement('button');
              ob.className = 'seg-opt' + (opt.active ? ' active' : '');
              ob.textContent = opt.label;
              ob.title = opt.title || '';
              ob.dataset.value = opt.value;
              ob.addEventListener('click', (function(action) { return function() { action(); }; })(opt.action));
              toggle.appendChild(ob);
            }
            this.container.appendChild(toggle);
            this._btnMap[a.id] = toggle;
            continue;
          }
          if (a.type === 'link') {
            currentGroup = null;
            const link = document.createElement('a');
            link.className = 'hdr-btn' + (a.className ? ' ' + a.className : '');
            link.href = a.href;
            link.target = '_blank';
            link.title = a.title || '';
            link.innerHTML = a.icon + (a.label ? ' ' + a.label : '');
            this.container.appendChild(link);
            continue;
          }
          // Group buttons inside nav-group containers
          if (a.group && a.group !== (currentGroup || '')) {
            currentGroup = a.group;
            var grp = document.createElement('span');
            grp.className = 'nav-group';
            grp.dataset.group = a.group;
            this.container.appendChild(grp);
          }
          var parent = a.group ? this.container.querySelector('.nav-group[data-group="' + a.group + '"]') : this.container;
          const btn = document.createElement('button');
          btn.className = 'hdr-btn' + (a.className ? ' ' + a.className : '');
          if (a.id) btn.id = a.id;
          btn.title = a.title || '';
          btn.innerHTML = this._btnContent(a);
          btn.addEventListener('click', a.action);
          parent.appendChild(btn);
          this._btnMap[a.id || a.key] = btn;
        }
      }

      _btnContent(a) {
        var parts = [];
        if (a.icon) parts.push(a.icon);
        if (a.label) parts.push(a.label);
        return parts.join(' ');
      }

      _displayKey(key) {
        if (key === '/') return '/';
        if (key === '?') return '?';
        if (key === 'Escape') return 'Esc';
        return key;
      }

      _renderHintBar() {
        if (!this.hintBar) return;
        var sep = '<span class="hint-sep"></span>';
        var items = this.actions.filter(a => a.key && a.type !== 'separator' && a.type !== 'link');
        var html = '';
        var lastGroup = null;
        for (var i = 0; i < items.length; i++) {
          var a = items[i];
          // Insert separator between hint groups: actions (s,d), nav (v,g,r), settings (c,?,t), search (/)
          var hGroup = 'sdDR'.indexOf(a.key) >= 0 ? 'act' : 'vgr'.indexOf(a.key) >= 0 ? 'nav' : 'ct?'.indexOf(a.key) >= 0 ? 'set' : 'oth';
          if (lastGroup && hGroup !== lastGroup) html += sep;
          lastGroup = hGroup;
          html += '<span><kbd>' + this._displayKey(a.key) + '</kbd> ' + a.hint + '</span>';
        }
        html += sep + '<span><kbd>Esc</kbd> close/clear</span>';
        this.hintBar.innerHTML = html;
      }

      _attachKeyboard() {
        this._keydownHandler = (e) => {
          const key = e.key;
          // Let Escape through even in inputs (to clear/close), block other shortcuts
          if (key !== 'Escape' && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

          if (key === 'Escape') {
            if (this.escHandler) this.escHandler();
            return;
          }

          // Theme panel gets priority when open (handled by its own sub-mode)
          const panelOpen = document.getElementById('theme-panel')?.classList.contains('open');
          if (panelOpen) {
            // Quick-select by number
            const quickIdx = THEME_QUICK_KEYS.indexOf(key);
            if (quickIdx !== -1 && quickIdx < THEME_ORDER.length) {
              e.preventDefault(); applyTheme(THEME_ORDER[quickIdx]); closeThemePanel(); return;
            }
            if (key === 'ArrowDown') { e.preventDefault(); setThemeNavFocus((themeNavIndex + 1) % THEME_ORDER.length); return; }
            if (key === 'ArrowUp') { e.preventDefault(); setThemeNavFocus((themeNavIndex - 1 + THEME_ORDER.length) % THEME_ORDER.length); return; }
            if (key === 'Enter' && themeNavIndex >= 0) { e.preventDefault(); applyTheme(THEME_ORDER[themeNavIndex]); closeThemePanel(); return; }
          }

          // Match action by key
          for (const a of this.actions) {
            if (!a.key || a.key !== key) continue;
            if (a.noMod && (e.ctrlKey || e.metaKey)) continue;
            if (a.alwaysActive || !panelOpen) {
              if (a.preventDefault) e.preventDefault();
              a.action();
              return;
            }
          }
        };
        document.addEventListener('keydown', this._keydownHandler);
      }

      /** Update a button's label/icon by id. Preserves the <kbd> badge. */
      updateButton(id, { label, icon }) {
        const a = this.actions.find(a => a.id === id);
        const btn = this._btnMap[id];
        if (!a || !btn) return;
        if (label !== undefined) a.label = label;
        if (icon !== undefined) a.icon = icon;
        btn.innerHTML = this._btnContent(a);
      }

      /** Update segmented toggle active state by value */
      updateSegToggle(id, activeValue) {
        var toggle = this._btnMap[id];
        if (!toggle) return;
        toggle.querySelectorAll('.seg-opt').forEach(function(opt) {
          opt.classList.toggle('active', opt.dataset.value === activeValue);
        });
      }

      destroy() {
        document.removeEventListener('keydown', this._keydownHandler);
      }
    }

    // ── Group view state (must be before navbar config) ───────────────────
    let groupView = localStorage.getItem('pm2-group-view') || 'flat';

    // ── Navbar action config ────────────────────────────────────────────────
    var _isTable = currentView === 'table';
    var _isGrouped = groupView === 'grouped';
    navbar = new NavbarShortcuts({
      containerId: 'navbar-buttons',
      hintBarId: 'hint-bar',
      escHandler: () => {
        document.querySelectorAll('.backdrop.open').forEach((el) => closeModal(el.id));
        closeThemePanel();
        const si = document.getElementById('search-input');
        if (si.value) { si.value = ''; applySearch(''); }
        else { si.blur(); }
      },
      actions: [
        // ── View toggles (segmented controls) ──
        { id: 'view-seg', type: 'seg-toggle', title: 'Switch view (v)', options: [
          { label: '⊞ Cards', value: 'cards', active: !_isTable,  title: 'Card grid view',
            action: function() { if (currentView !== 'cards') toggleView(); } },
          { label: '⊟ Table', value: 'table', active: _isTable,   title: 'Table view',
            action: function() { if (currentView !== 'table') toggleView(); } },
        ]},
        { id: 'group-seg', type: 'seg-toggle', title: 'Layout mode (g)', options: [
          { label: '☰ Flat', value: 'flat', active: !_isGrouped,  title: 'Flat list',
            action: function() { if (groupView !== 'flat') toggleGroupView(); } },
          { label: '▤ Grouped', value: 'grouped', active: _isGrouped, title: 'Group by category',
            action: function() { if (groupView !== 'grouped') toggleGroupView(); } },
        ]},
        { type: 'nav-sep' },
        // ── Primary actions ──
        { id: 'save-btn',  label: 'Save',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M13 1H3a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V4l-2-3zM8 13a2 2 0 110-4 2 2 0 010 4zm3-9H4V3h7v1z" fill="currentColor"/></svg>',
          key: 's', noMod: true, hint: 'save',
          title: 'pm2 save — writes process list to dump (s)',
          className: 'primary save', group: 'actions', action: () => saveList() },
        { label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm.75 8.5h-1.5v-5h1.5v5zm0-6.5h-1.5V2.5h1.5V4z" fill="currentColor"/><path d="M13.5 3.5L15 2l-1 3-3-1 1.5-1.5z" fill="currentColor"/></svg>',
          title: 'pm2 resurrect — restore from last save',
          group: 'actions', action: () => doResurrect() },
        { id: 'scan-btn', label: 'Scan',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="6.5" cy="6.5" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
          key: 'd', noMod: true, hint: 'discover',
          title: 'Scan for new projects (d)',
          group: 'actions', action: () => openScanModal() },
        { id: 'ports-btn', label: 'Ports',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M2 5h12M2 8h12M2 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="5" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="8" r="1" fill="currentColor"/><circle cx="11" cy="11" r="1" fill="currentColor"/></svg>',
          key: 'p', noMod: true, hint: 'ports',
          title: 'Discovered ports — orphan listeners outside pm2 (p)',
          group: 'actions', action: () => openPortsModal() },
        { id: 'daemon-btn', label: 'Daemon',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 1L3 4v4c0 3.3 2.2 6.1 5 7 2.8-.9 5-3.7 5-7V4L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 8l1.5 1.5L10 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          key: 'n', noMod: true, hint: 'new daemon',
          title: 'Register a new custom daemon (n)',
          group: 'actions', action: () => openCreateDaemonModal() },
        { id: 'nginx-btn', label: 'Nginx',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M5 11V5l6 6V5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>',
          key: 'g', noMod: true, hint: 'nginx',
          title: 'Nginx server blocks + .test domains (g)',
          group: 'actions', action: () => openNginxModal() },
        { id: 'claude-btn', label: 'Claude',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 1l1.8 4.4L14 7l-3.5 2.6L11.5 14 8 11.5 4.5 14l1-4.4L2 7l4.2-1.6L8 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
          key: 'i', noMod: true, hint: 'claude',
          title: 'Live Claude CLI instances (i)',
          group: 'actions', action: () => openClaudeModal() },
        { type: 'nav-sep' },
        // Intensity dial — sets pm2 cache TTL + warmer cadence + UI poll rate.
        // Eco saves CPU/battery; Aggressive optimizes for freshness.
        { type: 'separator',
          html: '<select id="intensity-select" onchange="setIntensity(this.value)" title="Polling intensity: eco=low CPU, aggressive=fresh data" style="background:var(--bg-tertiary,#1a1a1a);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:2px 6px;font-size:0.72rem;cursor:pointer"><option value="eco">⚡ eco</option><option value="normal" selected>⚡ normal</option><option value="aggressive">⚡ aggressive</option></select>' },
        { type: 'nav-sep' },
        // ── Settings ──
        { id: 'config-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M8 10a2 2 0 100-4 2 2 0 000 4z" fill="currentColor"/><path d="M13.3 8c0-.3 0-.7-.1-1l1.5-1.2-1.5-2.6-1.8.7a5 5 0 00-1.7-1L9.5 1h-3l-.2 1.9a5 5 0 00-1.7 1l-1.8-.7L1.3 5.8 2.8 7A5 5 0 002.7 8c0 .3 0 .7.1 1L1.3 10.2l1.5 2.6 1.8-.7c.5.4 1.1.7 1.7 1l.2 1.9h3l.2-1.9a5 5 0 001.7-1l1.8.7 1.5-2.6L13.2 9c.1-.3.1-.6.1-1z" stroke="currentColor" stroke-width="1.3"/></svg>',
          key: 'c', noMod: true, hint: 'config',
          title: 'Settings: groups, URLs, merges (c)',
          group: 'settings', action: () => openConfigModal() },
        { id: 'help-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 6.5c0-1 .7-1.5 1.5-1.5s1.5.6 1.5 1.5c0 .8-.5 1.2-1 1.5S8 9 8 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.5" r=".75" fill="currentColor"/></svg>',
          key: '?', hint: 'help',
          title: 'Quick reference (?)',
          className: 'help', group: 'settings', action: () => openHelp() },
        { id: 'self-restart-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M11 2v3h3M5 14v-3H2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
          title: 'Restart sys-pier-backend (~3s downtime)',
          group: 'settings', action: () => doSelfRestart() },
        { id: 'theme-btn', label: '',
          icon: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M3.1 12.9l1.1-1.1M11.8 4.2l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
          key: 't', noMod: true, hint: 'theme',
          title: 'Color theme (t)',
          alwaysActive: true, group: 'settings', action: () => toggleThemePanel() },
        { type: 'nav-sep' },
        // ── Status ──
        { type: 'separator', className: 'live-indicator',
          html: '<span id="last-update">—</span><span class="pulse" title="Auto-refreshing every 5s"></span>' },
        // {} JSON link removed — accessible at /api/state directly
        // ── Hidden keyboard-only shortcuts ──
        { key: 'v', noMod: true, hint: 'card/table', label: '', icon: '',
          action: function() { toggleView(); },
          type: 'hidden' },
        { key: 'g', noMod: true, hint: 'group', label: '', icon: '',
          action: function() { toggleGroupView(); },
          type: 'hidden' },
        { key: 'r', noMod: true, hint: 'refresh', label: '', icon: '', action: () => refresh(),
          type: 'hidden' },
        { key: '/', hint: 'search', label: '', icon: '', preventDefault: true,
          action: () => document.getElementById('search-input').focus(),
          type: 'hidden' },
      ].filter(a => a.type !== 'hidden' || a.key),
    });

    // ── Toast ──────────────────────────────────────────────────────────────
    function toast(msg, type = '') {
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = msg;
      document.getElementById('toasts').appendChild(el);
      var dur = type === 'err' ? 5000 : 3500;
      setTimeout(function() {
        el.classList.add('toast-exit');
        el.addEventListener('animationend', function() { el.remove(); });
      }, dur);
      return el;
    }

    // Async toast: shows loading message, returns object with .done(msg) and .error(msg)
    function toastAsync(loadingMsg) {
      const el = toast(loadingMsg + '…', 'loading');
      function exitAfter(ms) {
        clearTimeout(el._t);
        el._t = setTimeout(function() {
          el.classList.add('toast-exit');
          el.addEventListener('animationend', function() { el.remove(); });
        }, ms);
      }
      return {
        done: function(msg) { el.textContent = msg; el.className = 'toast ok'; exitAfter(3500); },
        error: function(msg) { el.textContent = msg; el.className = 'toast err'; exitAfter(5000); },
      };
    }

    // ── Group view toggle ─────────────────────────────────────────────────
    function toggleGroupView() {
      groupView = groupView === 'flat' ? 'grouped' : 'flat';
      localStorage.setItem('pm2-group-view', groupView);
      if (navbar) navbar.updateSegToggle('group-seg', groupView);
      // Fade transition on layout change
      var gridEl = document.getElementById('grid');
      gridEl.classList.add('view-fade-out');
      setTimeout(function() {
        refresh();
        gridEl.classList.remove('view-fade-out');
        gridEl.classList.add('view-fade-in');
        gridEl.addEventListener('animationend', function handler() {
          gridEl.classList.remove('view-fade-in');
          gridEl.removeEventListener('animationend', handler);
        });
      }, 150);
    }

    function toggleGroupCollapse(gid) {
      const nowCollapsed = !(DASH_CONFIG.groups[gid]?.collapsed);
      // Instant client-side toggle for responsive UX
      if (DASH_CONFIG.groups[gid]) DASH_CONFIG.groups[gid].collapsed = nowCollapsed;
      const section = document.querySelector('.group-section[data-group="' + CSS.escape(gid) + '"]');
      if (section) {
        section.classList.toggle('collapsed', nowCollapsed);
        const btn = section.querySelector('.group-collapse-btn');
        if (btn) btn.textContent = nowCollapsed ? '▸' : '▾';
      }
      // Persist to server
      fetch('/api/groups/' + encodeURIComponent(gid), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collapsed: nowCollapsed }),
      }).then(() => refresh()).catch(() => toast('Failed to save collapse state', 'err'));
    }

    async function doGroupAction(cmd, gid) {
      try {
        const entries = Object.entries(DASH_CONFIG.entries || {}).filter(([,v]) => v.group === gid).map(([k]) => k);
        for (const name of entries) { await fetch('/api/items/pm2/' + encodeURIComponent(name) + '/' + encodeURIComponent(cmd), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
        const gname = (DASH_CONFIG.groups[gid] || {}).name || gid;
        toast(cmd + ' all in ' + gname + ' ✓', 'ok');
        setTimeout(refresh, 800);
      } catch { toast('Group action failed', 'err'); }
    }

    function startGroupNameEdit(gid, el) {
      const current = el.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.style.cssText = 'font-size:inherit;font-weight:inherit;font-family:inherit;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:3px;color:var(--text-primary);padding:1px 6px;width:' + Math.max(80, current.length * 9) + 'px;outline:none';
      el.replaceWith(input);
      input.focus();
      input.select();
      function commit() {
        const val = input.value.trim();
        if (val && val !== current) {
          updateGroup(gid, { name: val });
        }
        const span = document.createElement('span');
        span.className = 'group-name';
        span.setAttribute('ondblclick', "event.stopPropagation();startGroupNameEdit('" + gid + "',this)");
        span.title = 'Double-click to rename';
        span.textContent = val || current;
        input.replaceWith(span);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    }

    // Init group button text from navbar config
    if (navbar) navbar.updateSegToggle('group-seg', groupView);

    // ── Color picker ──────────────────────────────────────────────────────
    let activeColorPicker = null;

    function toggleColorPicker(name, dotEl) {
      closeColorPicker();
      const popup = document.createElement('div');
      popup.className = 'color-picker-popup';
      popup.id = 'color-picker-active';
      const currentColor = name.startsWith('static:')
        ? (DASH_CONFIG.staticUrls || {})[name.slice(7)]?.color
        : (DASH_CONFIG.entries || {})[name]?.color;
      popup.innerHTML = COLOR_PALETTE.map((c) =>
        `<div class="color-swatch ${c === currentColor ? 'active' : ''}" style="background:${c}" onclick="setColor('${name}','${c}')" title="${c}"></div>`
      ).join('') + `<div class="color-swatch color-dot-empty" onclick="setColor('${name}','')" title="Remove color" style="border:1.5px dashed var(--text-faint)"></div>`;
      document.body.appendChild(popup);
      // Position near the clicked dot using viewport coordinates
      const rect = dotEl.getBoundingClientRect();
      let top = rect.bottom + 6;
      let left = rect.left;
      // Clamp to viewport
      if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
      if (top + 180 > window.innerHeight) top = rect.top - 180;
      if (left < 5) left = 5;
      popup.style.top = top + 'px';
      popup.style.left = left + 'px';
      activeColorPicker = popup;
      setTimeout(() => document.addEventListener('click', closeColorPickerOutside, { once: true }), 10);
    }

    function closeColorPicker() {
      const el = document.getElementById('color-picker-active');
      if (el) el.remove();
      activeColorPicker = null;
    }

    function closeColorPickerOutside(e) {
      if (activeColorPicker && !activeColorPicker.contains(e.target)) closeColorPicker();
    }

    async function setColor(name, color) {
      closeColorPicker();
      try {
        if (name.startsWith('static:')) {
          const slug = name.slice(7);
          await fetch('/api/static-urls/' + encodeURIComponent(slug), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: color || null }),
          });
        } else {
          await fetch('/api/config/entry/' + encodeURIComponent(name), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: color || null }),
          });
        }
        toast('Color updated', 'ok');
        refresh();
      } catch(e) { toast('Failed to set color', 'err'); }
    }

    // ── Custom title editing ──────────────────────────────────────────────
    function startTitleEdit(name, el) {
      const cfg = name.startsWith('static:')
        ? (DASH_CONFIG.staticUrls || {})[name.slice(7)] || {}
        : (DASH_CONFIG.entries || {})[name] || {};
      const current = cfg.title || '';
      const input = document.createElement('input');
      input.className = 'proc-name-edit';
      input.value = current;
      input.placeholder = name.startsWith('static:') ? name.slice(7) : name;
      const parent = el.parentElement;
      el.style.display = 'none';
      const titleSpan = parent.querySelector('.proc-title');
      if (titleSpan) titleSpan.style.display = 'none';
      parent.insertBefore(input, el.nextSibling);
      input.focus();
      input.select();

      const save = async () => {
        const val = input.value.trim();
        input.remove();
        el.style.display = '';
        if (titleSpan) titleSpan.style.display = '';
        if (val === current) return; // no change
        var t = toastAsync('Renaming ' + name);
        try {
        if (name.startsWith('static:')) {
          await fetch('/api/static-urls/' + encodeURIComponent(name.slice(7)), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: val || null }),
          });
        } else {
          await fetch('/api/config/entry/' + encodeURIComponent(name), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: val || null }),
          });
        }
        t.done('Renamed: ' + (val || name));
        refresh();
        } catch(e) { t.error('Failed to rename'); }
      };
      input.addEventListener('blur', save, { once: true });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    }

    // ── Drag and drop ─────────────────────────────────────────────────────
    let dragSourceName = null;

    function onDragStart(e, name) {
      dragSourceName = name;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', name);
      const card = e.target.closest('.card') || e.target.closest('tr');
      if (card) {
        card.classList.add('drag-source');
        // Mark source group with amber border
        const srcSection = card.closest('.group-section');
        if (srcSection) srcSection.classList.add('card-drag-source');
        // Create a floating ghost of the card
        if (card.classList.contains('card')) {
          var ghost = card.cloneNode(true);
          ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:' + card.offsetWidth + 'px;opacity:0.85;transform:scale(0.85);pointer-events:none;z-index:9999;border:2px solid var(--accent);border-radius:var(--radius)';
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, card.offsetWidth / 2, 20);
          setTimeout(function() { ghost.remove(); }, 0);
        }
      }
    }

    function clearDragIndicators() {
      document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drag-over-left,.drag-over-right').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-left', 'drag-over-right');
      });
      document.querySelectorAll('.group-section.card-drag-target').forEach((el) => {
        el.classList.remove('card-drag-target');
      });
    }

    function clearCardDragGroupState() {
      document.querySelectorAll('.group-section.card-drag-source,.group-section.card-drag-target').forEach((el) => {
        el.classList.remove('card-drag-source', 'card-drag-target');
      });
    }

    function getDragPosition(e, card) {
      const rect = card.getBoundingClientRect();
      return (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom';
    }

    function setupDragDrop() {
      document.querySelectorAll('.card[data-name]').forEach((card) => {
        card.addEventListener('dragover', (e) => {
          if (!dragSourceName) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          clearDragIndicators();
          const pos = getDragPosition(e, card);
          card.classList.add(pos === 'top' ? 'drag-over-top' : 'drag-over-bottom');
          // Highlight target group section (if different from source group)
          const targetSection = card.closest('.group-section');
          const sourceCard = document.querySelector('.card[data-name="' + CSS.escape(dragSourceName) + '"]');
          const srcSection = sourceCard ? sourceCard.closest('.group-section') : null;
          if (targetSection && targetSection !== srcSection) {
            targetSection.classList.add('card-drag-target');
          }
        });
        card.addEventListener('dragleave', (e) => {
          if (!card.contains(e.relatedTarget)) {
            card.classList.remove('drag-over-top', 'drag-over-bottom');
          }
        });
        card.addEventListener('drop', async (e) => {
          e.preventDefault();
          const pos = getDragPosition(e, card);
          clearDragIndicators();
          clearCardDragGroupState();
          const target = card.dataset.name;
          if (!dragSourceName || dragSourceName === target) return;
          // Instant DOM reorder (optimistic update) with flash animation
          const sourceCard = document.querySelector('.card[data-name="' + CSS.escape(dragSourceName) + '"]');
          if (sourceCard && card.parentElement) {
            sourceCard.classList.remove('drag-source');
            if (pos === 'top') {
              card.parentElement.insertBefore(sourceCard, card);
            } else {
              card.parentElement.insertBefore(sourceCard, card.nextSibling);
            }
            sourceCard.classList.add('reorder-flash');
            sourceCard.addEventListener('animationend', function handler() { sourceCard.classList.remove('reorder-flash'); sourceCard.removeEventListener('animationend', handler); });
          }
          // Build new order from current DOM state and persist
          const allCards = [...document.querySelectorAll('.card[data-name]')].map(function(c) { return c.dataset.name; });
          try {
            await fetch('/api/order', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: allCards }),
            });
            toast('Order updated', 'ok');
          } catch(e) { toast('Failed to save order', 'err'); }
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('drag-source');
          dragSourceName = null;
          clearDragIndicators();
          clearCardDragGroupState();
        });
      });
    }

    // ── Group section reorder ──────────────────────────────────────────
    var _dragGroupId = null;
    var _groupPlaceholder = null;

    // Assign unique view-transition-name to each group section for smooth FLIP
    function _assignGroupTransitionNames() {
      document.querySelectorAll('.group-section[data-group]').forEach(function(s) {
        var safe = 'gs-' + s.dataset.group.replace(/[^a-z0-9-]/gi, '-');
        s.style.viewTransitionName = safe;
      });
    }

    function _clearGroupDragState() {
      _dragGroupId = null;
      if (_groupPlaceholder) { _groupPlaceholder.remove(); _groupPlaceholder = null; }
      document.querySelectorAll('.group-section.drag-over-left,.group-section.drag-over-right,.group-section.drag-source').forEach(function(el) {
        el.classList.remove('drag-over-left', 'drag-over-right', 'drag-source');
      });
    }

    function onGroupSectionDragStart(e, gid) {
      _dragGroupId = gid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'group:' + gid);
      var section = e.target.closest('.group-section');
      if (section) {
        section.classList.add('drag-source');
        // Create a height-matched placeholder so other groups don't jump
        _groupPlaceholder = document.createElement('div');
        _groupPlaceholder.className = 'group-section-placeholder';
        _groupPlaceholder.style.cssText = 'height:' + section.offsetHeight + 'px;border:2px dashed var(--border);border-radius:var(--radius);background:var(--bg-inset);opacity:0.5;flex-shrink:0;';
        _groupPlaceholder.dataset.placeholder = '1';
      }
    }

    // Attach via delegation on #grid
    (function() {
      var grid = document.getElementById('grid');
      if (!grid) return;
      grid.addEventListener('dragover', function(e) {
        if (!_dragGroupId) return;
        var section = e.target.closest('.group-section');
        if (!section || section.dataset.group === _dragGroupId || section.dataset.placeholder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.group-section.drag-over-left,.group-section.drag-over-right').forEach(function(el) {
          el.classList.remove('drag-over-left', 'drag-over-right');
        });
        var rect = section.getBoundingClientRect();
        var pos = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
        section.classList.add(pos === 'left' ? 'drag-over-left' : 'drag-over-right');
        // Move placeholder to show where section will land
        if (_groupPlaceholder) {
          if (pos === 'left') section.parentElement.insertBefore(_groupPlaceholder, section);
          else section.parentElement.insertBefore(_groupPlaceholder, section.nextSibling);
        }
      });
      grid.addEventListener('drop', async function(e) {
        if (!_dragGroupId) return;
        var targetSection = e.target.closest('.group-section');
        if (!targetSection || targetSection.dataset.group === _dragGroupId || targetSection.dataset.placeholder) return;
        e.preventDefault();
        var rect = targetSection.getBoundingClientRect();
        var pos = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
        var sourceSection = grid.querySelector('.group-section[data-group="' + CSS.escape(_dragGroupId) + '"]');
        _clearGroupDragState();
        if (sourceSection) {
          // Animated reorder via View Transitions API if supported
          var doReorder = function() {
            if (pos === 'left') targetSection.parentElement.insertBefore(sourceSection, targetSection);
            else targetSection.parentElement.insertBefore(sourceSection, targetSection.nextSibling);
          };
          if (document.startViewTransition) {
            _assignGroupTransitionNames();
            document.startViewTransition(doReorder);
          } else {
            doReorder();
            sourceSection.classList.add('reorder-flash');
            sourceSection.addEventListener('animationend', function handler() { sourceSection.classList.remove('reorder-flash'); sourceSection.removeEventListener('animationend', handler); });
          }
        }
        // Persist group order
        var sections = grid.querySelectorAll('.group-section[data-group]');
        var order = 0;
        var updates = [];
        sections.forEach(function(s) {
          var gid = s.dataset.group;
          if (gid && gid !== '_ungrouped') {
            updates.push(fetch('/api/groups/' + encodeURIComponent(gid), {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: order++ }),
            }));
          }
        });
        try {
          await Promise.all(updates);
          var res = await fetch('/api/config');
          DASH_CONFIG = await res.json();
          toast('Group order updated', 'ok');
        } catch(e) { toast('Failed to reorder groups', 'err'); }
      });
      grid.addEventListener('dragend', _clearGroupDragState);
    })();

    // ── Table row drag-drop (event delegation on tbody) ───────────────
    (function() {
      var tbody = document.getElementById('table-body');
      if (!tbody) return;
      tbody.addEventListener('dragover', function(e) {
        if (!dragSourceName) return;
        var row = e.target.closest('tr[data-name]');
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDragIndicators();
        var pos = getDragPosition(e, row);
        row.classList.add(pos === 'top' ? 'drag-over-top' : 'drag-over-bottom');
      });
      tbody.addEventListener('dragleave', function(e) {
        var row = e.target.closest('tr[data-name]');
        if (row && !row.contains(e.relatedTarget)) {
          row.classList.remove('drag-over-top', 'drag-over-bottom');
        }
      });
      tbody.addEventListener('drop', async function(e) {
        var row = e.target.closest('tr[data-name]');
        if (!row || !dragSourceName) return;
        e.preventDefault();
        var pos = getDragPosition(e, row);
        clearDragIndicators();
        var target = row.dataset.name;
        if (dragSourceName === target) return;
        // Instant DOM reorder with flash
        var sourceRow = tbody.querySelector('tr[data-name="' + CSS.escape(dragSourceName) + '"]');
        if (sourceRow) {
          sourceRow.classList.remove('drag-source');
          if (pos === 'top') {
            row.parentElement.insertBefore(sourceRow, row);
          } else {
            row.parentElement.insertBefore(sourceRow, row.nextSibling);
          }
          sourceRow.classList.add('reorder-flash');
          sourceRow.addEventListener('animationend', function handler() { sourceRow.classList.remove('reorder-flash'); sourceRow.removeEventListener('animationend', handler); });
        }
        // Persist order from table rows
        var allRows = tbody.querySelectorAll('tr[data-name]');
        var order = [];
        allRows.forEach(function(r) { order.push(r.dataset.name); });
        try {
          await fetch('/api/order', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: order }),
          });
          toast('Order updated', 'ok');
        } catch(e) { toast('Failed to save order', 'err'); }
      });
    })();

    function onGroupDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }

    async function onGroupDrop(e, gid) {
      e.preventDefault();
      if (!dragSourceName || dragSourceName.startsWith('static:')) return;
      const grpName = gid ? ((DASH_CONFIG.groups[gid] || {}).name || gid) : 'ungrouped';
      try {
        await fetch('/api/config/entry/' + encodeURIComponent(dragSourceName), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: gid || null }),
        });
        toast(dragSourceName + ' → ' + grpName, 'ok');
        dragSourceName = null;
        refresh();
      } catch(e) { toast('Failed to move to group', 'err'); }
    }

    // ── Static URL health check ───────────────────────────────────────────
    async function checkHealth(slug) {
      const dot = document.getElementById('health-' + slug);
      if (dot) { dot.className = 'health-dot'; dot.style.animation = 'pulse 0.6s infinite'; }
      try {
        const res = await fetch('/api/static-urls/' + encodeURIComponent(slug) + '/health');
        const data = await res.json();
        if (dot) {
          dot.style.animation = '';
          dot.className = 'health-dot ' + (data.ok ? 'healthy' : data.status >= 300 && data.status < 400 ? 'redirect' : 'error');
          dot.title = `${data.status} — ${data.latency_ms}ms`;
        }
        toast(`${slug}: ${data.status} (${data.latency_ms}ms)`, data.ok ? 'ok' : 'err');
      } catch { if (dot) { dot.style.animation = ''; dot.className = 'health-dot error'; } }
    }

    async function deleteStaticUrl(slug) {
      if (!confirm('Remove static URL "' + slug + '"?')) return;
      try {
        await fetch('/api/static-urls/' + encodeURIComponent(slug), { method: 'DELETE' });
        toast('Removed ' + slug, 'ok');
        refresh();
      } catch { toast('Failed to remove ' + slug, 'err'); }
    }

    // ── Merge/unmerge ─────────────────────────────────────────────────────
    async function doUnmerge(key) {
      try {
        await fetch('/api/merges/' + encodeURIComponent(key), { method: 'DELETE' });
        toast('Unmerged ' + key, 'ok');
        refresh();
      } catch { toast('Failed to unmerge ' + key, 'err'); }
    }

    // ── Config export/import ────────────────────────────────────────────
    function exportConfig() {
      var blob = new Blob([JSON.stringify(DASH_CONFIG, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sys-pier-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Config exported', 'ok');
    }

    function importConfig() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async function() {
        var file = input.files[0];
        if (!file) return;
        var t = toastAsync('Importing config');
        try {
          var text = await file.text();
          var cfg = JSON.parse(text);
          if (!cfg.groups && !cfg.entries && !cfg.staticUrls) {
            t.error('Invalid config: missing groups/entries/staticUrls');
            return;
          }
          var res = await fetch('/api/config', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: text,
          });
          if (!res.ok) { t.error('Server rejected config'); return; }
          var fresh = await fetch('/api/config');
          if (!fresh.ok) { t.error('Failed to reload config'); return; }
          DASH_CONFIG = await fresh.json();
          t.done('Config imported (' + Object.keys(cfg.groups || {}).length + ' groups, ' + Object.keys(cfg.entries || {}).length + ' entries)');
          renderConfigTab(currentConfigTab);
          refresh();
        } catch(e) { t.error('Import failed: ' + (e.message || 'invalid JSON')); }
      };
      input.click();
    }

    // ── Config modal ──────────────────────────────────────────────────────
    let currentConfigTab = 'groups';

    function openConfigModal() {
      document.getElementById('config-modal').classList.add('open');
      renderConfigTab(currentConfigTab);
    }

    function switchConfigTab(tab) {
      currentConfigTab = tab;
      document.querySelectorAll('.config-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
      renderConfigTab(tab);
    }

    function renderConfigTab(tab) {
      const container = document.getElementById('config-tab-content');
      if (tab === 'groups') {
        const groups = DASH_CONFIG.groups || {};
        const groupList = Object.entries(groups).map(([id, g]) =>
          `<li data-group-id="${id}">
            <span class="group-emoji-btn" onclick="openEmojiPicker(this,'${id}')" title="Click to change icon" style="cursor:pointer;font-size:1.1rem">${g.emoji || '📦'}</span>
            <input class="group-name-input" value="${(g.name || id).replace(/"/g,'&quot;')}" placeholder="Group name"
              onchange="updateGroup('${id}',{name:this.value})" style="width:100px;font-size:0.82rem;font-weight:600;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:3px;color:var(--text-primary);padding:3px 6px;font-family:var(--font-mono)">
            <input class="group-notes-input" value="${(g.notes || '').replace(/"/g,'&quot;')}" placeholder="notes…"
              onchange="updateGroup('${id}',{notes:this.value})" style="flex:1;font-size:0.75rem;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:3px;color:var(--text-secondary);padding:3px 6px;font-family:var(--font-mono)">
            <button class="btn btn-sm btn-danger" onclick="deleteGroup('${id}')">✕</button>
          </li>`
        ).join('') || '<li style="color:var(--text-faint)">No groups yet</li>';
        container.innerHTML = `
          <ul class="config-list">${groupList}</ul>
          <div class="config-form config-add-separator" style="flex-direction:row;gap:8px;align-items:flex-end">
            <label>Name<input id="new-group-name" placeholder="My Group" style="width:120px"></label>
            <label>Icon<span id="new-group-emoji-btn" class="group-emoji-btn" onclick="openEmojiPicker(this)" style="cursor:pointer;font-size:1.2rem;padding:4px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-sm);line-height:1.4;display:inline-block">${GROUP_EMOJIS[Math.floor(Math.random()*GROUP_EMOJIS.length)]}</span><input id="new-group-emoji" type="hidden"></label>
            <label style="flex:1">Notes<input id="new-group-notes" placeholder="Optional description" style="width:100%"></label>
            <button class="btn btn-ok" onclick="addGroup()" style="white-space:nowrap">+ Add</button>
          </div>`;
      } else if (tab === 'static') {
        const urls = DASH_CONFIG.staticUrls || {};
        const urlList = Object.entries(urls).map(([slug, u]) =>
          `<li>
            <span>🔗</span>
            <strong>${_esc(slug)}</strong>
            <a href="${_esc(u.url)}" target="_blank" style="flex:1;font-size:0.62rem;color:var(--accent)">${_esc(u.url)}</a>
            <span style="font-size:0.6rem;color:var(--text-faint)">${u.group ? _esc((DASH_CONFIG.groups[u.group] || {}).name || u.group) : 'static'}</span>
            <button class="btn btn-sm btn-danger" onclick="deleteStaticUrl('${_esc(slug)}')">✕</button>
          </li>`
        ).join('') || '<li style="color:var(--text-faint)">No static URLs yet</li>';
        const groupOpts = Object.entries(DASH_CONFIG.groups || {}).map(([gid, g]) => `<option value="${gid}">${g.name || gid}</option>`).join('');
        container.innerHTML = `
          <ul class="config-list">${urlList}</ul>
          <div class="config-form config-add-separator" style="flex-direction:row;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <label>Slug<input id="new-url-slug" placeholder="my-site" style="width:90px"></label>
            <label style="flex:1">URL<input id="new-url-url" placeholder="https://example.com" style="width:100%"></label>
            <label>Title<input id="new-url-title" placeholder="My Site" style="width:110px"></label>
            <label>Group<select id="new-url-group" style="width:110px"><option value="static">static</option>${groupOpts}</select></label>
            <button class="btn btn-ok" onclick="addStaticUrl()" style="white-space:nowrap">+ Add</button>
          </div>`;
      } else if (tab === 'merges') {
        const merges = DASH_CONFIG.merges || {};
        const mergeList = Object.entries(merges).map(([key, entries]) =>
          `<li>
            <span>⚡</span>
            <strong>${_esc(key)}</strong>
            <span style="flex:1;font-size:0.62rem;color:var(--text-faint)">${_esc(entries.join(' + '))}</span>
            <button class="btn btn-sm btn-danger" onclick="doUnmerge('${_esc(key)}')">Unmerge</button>
          </li>`
        ).join('');
        container.innerHTML = `
          <ul class="config-list">${mergeList || '<li style="color:var(--text-faint)">No merges</li>'}</ul>
          <div style="margin-top:12px">
            <button class="btn" onclick="detectMerges()">🔍 Detect merge candidates</button>
            <div id="merge-candidates" style="margin-top:8px"></div>
          </div>
          <div class="config-form config-add-separator" style="flex-direction:row;gap:8px;align-items:flex-end">
            <label>Key<input id="new-merge-key" placeholder="project-name" style="width:130px"></label>
            <label style="flex:1">Entry 1<input id="new-merge-a" placeholder="project-frontend" style="width:100%"></label>
            <label style="flex:1">Entry 2<input id="new-merge-b" placeholder="project-backend" style="width:100%"></label>
            <button class="btn btn-ok" onclick="addMerge()" style="white-space:nowrap">⚡ Merge</button>
          </div>`;
      } else if (tab === 'entries') {
        const entries = DASH_CONFIG.entries || {};
        const groups = DASH_CONFIG.groups || {};
        const procNames = lastProcesses.map((p) => p.name);
        // Also include static URL entries
        const staticNames = Object.keys(DASH_CONFIG.staticUrls || {}).map(s => 'static:' + s);
        const allNames = [...procNames, ...staticNames];

        // Bucket entries by group
        const byGroup = { '': [] };
        for (const gid of Object.keys(groups)) byGroup[gid] = [];
        for (const name of allNames) {
          const cfg = entries[name] || {};
          const gid = cfg.group || '';
          if (!byGroup[gid]) byGroup[gid] = [];
          byGroup[gid].push(name);
        }

        function entryChip(name) {
          const cfg = entries[name] || {};
          const isStatic = name.startsWith('static:');
          const displayName = isStatic ? name.slice(7) : name;
          const icon = isStatic ? '🔗' : (cfg.color ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cfg.color};margin-right:3px"></span>` : '');
          return `<div class="entry-chip" draggable="true" data-entry-name="${name}"
            ondragstart="onEntryDragStart(event,'${name}')">${icon}<span>${displayName}</span></div>`;
        }

        // Ungrouped lane
        let html = '<div class="entry-lanes">';
        html += `<div class="entry-lane" data-lane-group=""
          ondragover="event.preventDefault();this.classList.add('lane-dragover')"
          ondragleave="this.classList.remove('lane-dragover')"
          ondrop="onEntryDrop(event,'')">
          <div class="entry-lane-header"><span>📋 Ungrouped</span><span class="entry-lane-count">${byGroup[''].length}</span></div>
          <div class="entry-lane-body">${byGroup[''].map(entryChip).join('') || '<span class="entry-lane-empty">Drop entries here</span>'}</div>
        </div>`;

        // Group lanes
        for (const [gid, ginfo] of Object.entries(groups)) {
          const items = byGroup[gid] || [];
          html += `<div class="entry-lane" data-lane-group="${gid}"
            ondragover="event.preventDefault();this.classList.add('lane-dragover')"
            ondragleave="this.classList.remove('lane-dragover')"
            ondrop="onEntryDrop(event,'${gid}')">
            <div class="entry-lane-header"><span>${ginfo.emoji || '📦'} ${ginfo.name || gid}</span><span class="entry-lane-count">${items.length}</span></div>
            <div class="entry-lane-body">${items.map(entryChip).join('') || '<span class="entry-lane-empty">Drop entries here</span>'}</div>
          </div>`;
        }

        html += '</div>';
        if (!Object.keys(groups).length) {
          html += '<p style="font-size:0.75rem;color:var(--text-faint);margin-top:8px;text-align:center">Create groups in the Groups tab first, then drag entries between lanes here.</p>';
        }
        container.innerHTML = html;
      }
    }

    // Enter-to-submit: delegated handler on config tab content
    document.getElementById('config-tab-content').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const id = e.target.id || '';
      if (id.startsWith('new-group-'))  { e.preventDefault(); addGroup(); }
      if (id.startsWith('new-url-'))    { e.preventDefault(); addStaticUrl(); }
      if (id.startsWith('new-merge-'))  { e.preventDefault(); addMerge(); }
    });

    // ── Emoji picker ─────────────────────────────────────────────────────
    const GROUP_EMOJIS = ['📦','📂','🎮','🚀','🔧','⚡','🎯','🌐','💻','🛠️','📊','🎨','🔬','📡','🏗️','🧪','📱','🖥️','🗂️','🔒','🌟','💡','🔥','❄️','🎵','📝','🏠','🛒','💰','🎓','🐳','⚙️','🌈','🍀','🔮','🎪','🧩','📸','🦊','🐙'];
    let _emojiPopup = null;

    function openEmojiPicker(triggerEl, groupId) {
      closeEmojiPicker();
      const popup = document.createElement('div');
      popup.id = 'emoji-picker-popup';
      popup.style.cssText = 'position:fixed;z-index:200;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:8px;display:grid;grid-template-columns:repeat(8,1fr);gap:4px;box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:280px';
      popup.innerHTML = GROUP_EMOJIS.map((e) =>
        `<span class="emoji-pick" style="cursor:pointer;font-size:1.2rem;padding:4px;text-align:center;border-radius:3px;transition:background 0.1s" onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background=''" onclick="pickEmoji(this,'${e}')">${e}</span>`
      ).join('');
      document.body.appendChild(popup);
      const rect = triggerEl.getBoundingClientRect();
      let top = rect.bottom + 4, left = rect.left;
      if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
      if (top + 200 > window.innerHeight) top = rect.top - 200;
      popup.style.top = top + 'px';
      popup.style.left = left + 'px';
      popup.dataset.groupId = groupId || '';
      popup.dataset.triggerId = triggerEl.id || '';
      _emojiPopup = popup;
      setTimeout(() => document.addEventListener('click', _emojiOutsideClick), 0);
    }

    function _emojiOutsideClick(e) {
      if (_emojiPopup && !_emojiPopup.contains(e.target)) closeEmojiPicker();
    }

    function closeEmojiPicker() {
      if (_emojiPopup) { _emojiPopup.remove(); _emojiPopup = null; }
      document.removeEventListener('click', _emojiOutsideClick);
    }

    function pickEmoji(el, emoji) {
      const popup = document.getElementById('emoji-picker-popup');
      const groupId = popup?.dataset.groupId;
      if (groupId) {
        // Editing existing group
        updateGroup(groupId, { emoji });
      } else {
        // New group form — update the visible button + hidden input
        const btn = document.getElementById('new-group-emoji-btn');
        if (btn) btn.textContent = emoji;
        const inp = document.getElementById('new-group-emoji');
        if (inp) inp.value = emoji;
      }
      closeEmojiPicker();
    }

    async function updateGroup(id, updates) {
      const gname = (DASH_CONFIG.groups[id] || {}).name || id;
      const what = Object.keys(updates).join(', ');
      var t = toastAsync('Updating ' + gname);
      try {
        await fetch('/api/groups/' + encodeURIComponent(id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        t.done('Updated ' + gname + ' (' + what + ')');
        renderConfigTab('groups');
        refresh();
      } catch(e) { t.error('Failed to update ' + gname); }
    }

    async function addGroup() {
      const name = document.getElementById('new-group-name').value.trim();
      const emojiBtn = document.getElementById('new-group-emoji-btn');
      const emojiHidden = document.getElementById('new-group-emoji');
      const emoji = (emojiHidden && emojiHidden.value) || (emojiBtn ? emojiBtn.textContent.trim() : '') || '📦';
      const notes = document.getElementById('new-group-notes').value.trim();
      if (!name) { toast('Group name required', 'err'); return; }
      try {
        await fetch('/api/groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, emoji, notes }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Group "' + name + '" created', 'ok');
        renderConfigTab('groups');
        refresh();
      } catch { toast('Failed to create group', 'err'); }
    }

    async function deleteGroup(id) {
      const gname = (DASH_CONFIG.groups[id] || {}).name || id;
      if (!confirm('Delete group "' + gname + '"? Entries will become ungrouped.')) return;
      try {
        await fetch('/api/groups/' + encodeURIComponent(id), { method: 'DELETE' });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Group "' + gname + '" deleted', 'ok');
        renderConfigTab('groups');
        refresh();
      } catch { toast('Failed to delete group', 'err'); }
    }

    async function addStaticUrl() {
      const slug = document.getElementById('new-url-slug').value.trim();
      const url = document.getElementById('new-url-url').value.trim();
      const title = document.getElementById('new-url-title').value.trim();
      const group = document.getElementById('new-url-group').value;
      if (!slug || !url) { toast('Slug and URL required', 'err'); return; }
      try {
        await fetch('/api/static-urls', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, url, title: title || slug, group }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Added ' + slug, 'ok');
        renderConfigTab('static');
        refresh();
      } catch { toast('Failed to add static URL', 'err'); }
    }

    async function addMerge() {
      const key = document.getElementById('new-merge-key').value.trim();
      const a = document.getElementById('new-merge-a').value.trim();
      const b = document.getElementById('new-merge-b').value.trim();
      if (!key || !a || !b) { toast('All fields required', 'err'); return; }
      try {
        await fetch('/api/merges', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, entries: [a, b] }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Merged ' + key, 'ok');
        renderConfigTab('merges');
        refresh();
      } catch { toast('Failed to create merge', 'err'); }
    }

    async function detectMerges() {
      try {
        const res = await fetch('/api/merges/suggestions');
        if (!res.ok) { toast('Failed to detect merges', 'err'); return; }
        const data = await res.json();
        const container = document.getElementById('merge-candidates');
        if (!data.length) { container.innerHTML = '<span style="color:var(--text-faint);font-size:0.7rem">No merge candidates found</span>'; return; }
        container.innerHTML = data.map((c) =>
          `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:0.72rem">
            <strong>${c.key}</strong>
            <span style="color:var(--text-faint)">${c.entries.join(' + ')}</span>
            <button class="btn btn-sm btn-ok" onclick="quickMerge('${c.key}',${JSON.stringify(c.entries).replace(/"/g,'&quot;')})">⚡ Merge</button>
          </div>`
        ).join('');
      } catch { toast('Failed to detect merges', 'err'); }
    }

    async function quickMerge(key, entries) {
      try {
        var r = await fetch('/api/merges', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, entries }),
        });
        if (!r.ok) { toast('Merge failed: server error', 'err'); return; }
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        toast('Merged ' + key, 'ok');
        renderConfigTab('merges');
        refresh();
      } catch { toast('Merge failed', 'err'); }
    }

    async function assignGroup(name, group) {
      const grpName = group ? ((DASH_CONFIG.groups[group] || {}).name || group) : 'ungrouped';
      var t = toastAsync('Moving ' + name);
      try {
        await fetch('/api/config/entry/' + encodeURIComponent(name), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: group || null }),
        });
        const res = await fetch('/api/config');
        if (res.ok) DASH_CONFIG = await res.json();
        t.done(name + ' → ' + grpName);
        refresh();
      } catch(e) { t.error('Failed to move ' + name); }
    }

    // ── Entry lane drag-and-drop ────────────────────────────────────────
    let _dragEntryName = null;

    function onEntryDragStart(e, name) {
      _dragEntryName = name;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', name);
      e.target.style.opacity = '0.5';
      setTimeout(() => { if (e.target) e.target.style.opacity = ''; }, 200);
    }

    function onEntryDrop(e, targetGroup) {
      e.preventDefault();
      const lane = e.currentTarget;
      lane.classList.remove('lane-dragover');
      const name = _dragEntryName || e.dataTransfer.getData('text/plain');
      if (!name) return;
      _dragEntryName = null;
      assignGroup(name, targetGroup).then(() => {
        if (currentConfigTab === 'entries') renderConfigTab('entries');
      });
    }

    // ── Project Scanner ────────────────────────────────────────────────────
    let _scanEvtSource = null;

    function openScanModal() {
      document.getElementById('scan-modal').classList.add('open');
      const cached = DASH_CONFIG.scanResults;
      if (cached && cached.candidates) {
        renderScanResults(cached);
      } else {
        renderScanEmpty();
      }
    }

    function renderScanEmpty() {
      document.getElementById('scan-content').innerHTML =
        '<div style="text-align:center;padding:2rem 1.25rem">' +
          '<p style="color:var(--text-muted);margin-bottom:1rem;font-size:0.85rem">' +
            'Scan ~/Code/ directories for projects that can be managed with pm2' +
          '</p>' +
          '<button class="hdr-btn" onclick="startScan()" style="padding:8px 24px;font-size:0.85rem">' +
            '🔍 Start Scan' +
          '</button>' +
        '</div>';
    }

    function startScan() {
      if (_scanEvtSource) { _scanEvtSource.close(); _scanEvtSource = null; }
      document.getElementById('scan-content').innerHTML =
        '<div style="text-align:center;padding:2rem 1.25rem">' +
          '<div class="scan-spinner"></div>' +
          '<p id="scan-progress-text" style="color:var(--text-muted);margin-top:1rem;font-size:0.82rem">Starting scan...</p>' +
        '</div>';

      const evtSource = new EventSource('/api/scan-projects');
      _scanEvtSource = evtSource;

      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'progress') {
          const el = document.getElementById('scan-progress-text');
          if (el) el.textContent = 'Scanning ' + data.root + '/' + data.dir + '...';
        } else if (data.type === 'complete') {
          evtSource.close();
          _scanEvtSource = null;
          DASH_CONFIG.scanResults = data.results;
          renderScanResults(data.results);
          updateScanBadge();
        } else if (data.type === 'error') {
          evtSource.close();
          _scanEvtSource = null;
          document.getElementById('scan-content').innerHTML =
            '<div style="padding:1.25rem;color:var(--red)">Scan failed: ' + _esc(data.message) + '</div>';
        }
      };
      evtSource.onerror = () => {
        evtSource.close();
        _scanEvtSource = null;
      };
    }

    function scanTimeAgo(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    function renderScanResults(results) {
      const { candidates, scannedCount, timestamp } = results;
      const age = timestamp ? scanTimeAgo(timestamp) : '';
      const unmanaged = candidates.filter(c => !c.alreadyManaged);
      const managed = candidates.filter(c => c.alreadyManaged);

      let html = '<div style="padding:0.5rem 1.25rem 1rem">';

      // Header row
      html += '<div class="scan-header-row">';
      html += '<span style="font-size:0.78rem;color:var(--text-faint)">' +
        'Found ' + candidates.length + ' projects (' + scannedCount + ' dirs scanned) · ' + age + '</span>';
      html += '<div style="display:flex;gap:0.5rem">';
      html += '<button class="hdr-btn" onclick="startScan()">↻ Re-scan</button>';
      html += '<button class="hdr-btn" onclick="discardScanResults()" style="border-color:var(--red);color:var(--red)">✕ Discard</button>';
      html += '</div></div>';

      // Unmanaged candidates
      if (unmanaged.length) {
        html += '<div class="scan-section-label">Available to add (' + unmanaged.length + ')</div>';
        for (const c of unmanaged) {
          html += renderScanCandidate(c, false);
        }
        html += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem;justify-content:flex-end;align-items:center">';
        html += '<span id="scan-sel-count" style="font-size:0.75rem;color:var(--text-faint)">0 selected</span>';
        html += '<button class="hdr-btn save" id="scan-add-btn" onclick="startSelectedProjects()" disabled>▶ Start Selected</button>';
        html += '</div>';
      } else {
        html += '<div style="text-align:center;padding:1rem;color:var(--text-faint);font-size:0.82rem">All detected projects are already managed</div>';
      }

      // Already managed
      if (managed.length) {
        html += '<div class="scan-section-label" style="margin-top:1rem;color:var(--text-faint)">Already managed (' + managed.length + ')</div>';
        for (const c of managed) {
          html += renderScanCandidate(c, true);
        }
      }

      html += '</div>';
      document.getElementById('scan-content').innerHTML = html;
    }

    function renderScanCandidate(c, isManaged) {
      const signals = c.signals.map(s => {
        if (s.type === 'ecosystem') return '<span class="scan-signal eco">⚙ ' + _esc(s.file) + (s.apps ? ' (' + s.apps + ' app' + (s.apps > 1 ? 's' : '') + ')' : '') + '</span>';
        if (s.type === 'package') return '<span class="scan-signal pkg">📦 ' + (s.scripts.length ? _esc(s.scripts.join(', ')) : 'package.json') + '</span>';
        if (s.type === 'entry') return '<span class="scan-signal entry">▸ ' + _esc(s.file) + '</span>';
        return '';
      }).join(' ');

      const startOpts = buildClientStartOptions(c);
      const selectHtml = startOpts.length > 1
        ? '<select class="scan-start-method" data-scan-path="' + c.path + '" onchange="updateScanSelection()">' +
            startOpts.map(o => '<option value="' + o.value + '">' + o.label + '</option>').join('') +
          '</select>'
        : (startOpts.length === 1
          ? '<span class="scan-start-method">' + startOpts[0].label + '</span>'
          : '');

      return '<div class="scan-candidate' + (isManaged ? ' managed' : '') + '">' +
        (isManaged
          ? '<span style="font-size:0.7rem;color:var(--green);flex-shrink:0">✓</span>'
          : '<input type="checkbox" data-scan-path="' + c.path + '" data-scan-name="' + c.name + '" onchange="updateScanSelection()" aria-label="Select ' + _esc(c.name) + '">') +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
            '<strong style="color:var(--text-primary)">' + c.name + '</strong>' +
            '<span style="font-size:0.7rem;color:var(--text-faint)">' + (c.rootLabel || '') + '</span>' +
            signals +
          '</div>' +
          '<div style="font-size:0.7rem;color:var(--text-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            c.path +
          '</div>' +
        '</div>' +
        (isManaged ? '' : selectHtml) +
      '</div>';
    }

    function buildClientStartOptions(c) {
      const opts = [];
      const eco = c.signals.find(s => s.type === 'ecosystem');
      if (eco) opts.push({ value: 'eco:' + eco.file, label: 'pm2 start ' + eco.file });

      const pkg = c.signals.find(s => s.type === 'package');
      if (pkg && pkg.scripts) {
        for (const s of pkg.scripts) {
          opts.push({ value: 'script:' + s, label: 'npm run ' + s });
        }
      }

      const entry = c.signals.find(s => s.type === 'entry');
      if (entry) opts.push({ value: 'entry:' + entry.file, label: 'node ' + entry.file });

      return opts;
    }

    function updateScanSelection() {
      const checks = document.querySelectorAll('#scan-content input[type="checkbox"]');
      const count = [...checks].filter(c => c.checked).length;
      const countEl = document.getElementById('scan-sel-count');
      const btn = document.getElementById('scan-add-btn');
      if (countEl) countEl.textContent = count + ' selected';
      if (btn) btn.disabled = count === 0;
    }

    async function startSelectedProjects() {
      const checks = [...document.querySelectorAll('#scan-content input[type="checkbox"]:checked')];
      if (!checks.length) return;

      const selections = checks.map(cb => {
        const p = cb.dataset.scanPath;
        const name = cb.dataset.scanName;
        const select = document.querySelector('select[data-scan-path="' + p + '"]');
        const methodStr = select ? select.value : '';
        const methodSpan = cb.closest('.scan-candidate')?.querySelector('.scan-start-method');
        const fallback = methodSpan ? methodSpan.textContent : '';

        let method, file, script;
        const val = methodStr || fallback;
        if (val.startsWith('eco:')) { method = 'ecosystem'; file = val.slice(4); }
        else if (val.startsWith('script:')) { method = 'script'; script = val.slice(7); }
        else if (val.startsWith('entry:')) { method = 'entry'; file = val.slice(6); }
        else if (val.startsWith('pm2 start ')) { method = 'ecosystem'; file = val.slice(10); }
        else if (val.startsWith('npm run ')) { method = 'script'; script = val.slice(8); }
        else if (val.startsWith('node ')) { method = 'entry'; file = val.slice(5); }
        else { method = 'script'; script = 'dev'; }

        return { path: p, name, method, file, script };
      });

      const btn = document.getElementById('scan-add-btn');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting...'; }

      try {
        const res = await fetch('/api/scan-projects/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selections }),
        });
        const data = await res.json();
        const ok = data.results?.filter(r => r.ok).length || 0;
        const fail = data.results?.filter(r => !r.ok).length || 0;
        if (ok) toast(ok + ' project' + (ok > 1 ? 's' : '') + ' started', 'ok');
        if (fail) toast(fail + ' failed to start', 'err');
        // Re-scan to update managed status
        setTimeout(() => { startScan(); refresh(); }, 1500);
      } catch (err) {
        toast('Failed: ' + err.message, 'err');
        if (btn) { btn.disabled = false; btn.textContent = '▶ Start Selected'; }
      }
    }

    async function discardScanResults() {
      try {
        await fetch('/api/scan-results', { method: 'DELETE' });
        DASH_CONFIG.scanResults = null;
        renderScanEmpty();
        updateScanBadge();
        toast('Scan results discarded', 'ok');
      } catch { toast('Failed to discard scan results', 'err'); }
    }

    function updateScanBadge() {
      const results = DASH_CONFIG.scanResults;
      const btn = document.getElementById('scan-btn');
      if (!btn) return;
      const badge = btn.querySelector('.scan-badge');
      if (results && results.candidates) {
        const count = results.candidates.filter(c => !c.alreadyManaged).length;
        if (count > 0) {
          if (badge) { badge.textContent = count; }
          else { btn.insertAdjacentHTML('beforeend', '<span class="scan-badge">' + count + '</span>'); }
          return;
        }
      }
      if (badge) badge.remove();
    }

    // Init scan badge on load
    updateScanBadge();

    // ── Discovered Ports (orphan listener tray) ────────────────────────
    let _portsRefreshTimer = null;
    let _portsLastSummary = null;

    async function fetchPorts(enrich) {
      const url = '/api/ports/discover' + (enrich ? '' : '?enrich=0');
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function updatePortsBadge() {
      try {
        const data = await fetchPorts(false);
        _portsLastSummary = data.summary;
        const btn = document.getElementById('ports-btn');
        if (!btn) return;
        let badge = btn.querySelector('.scan-badge');
        const orphan = data.summary.orphan || 0;
        if (orphan > 0) {
          if (badge) badge.textContent = orphan;
          else btn.insertAdjacentHTML('beforeend', '<span class="scan-badge" style="background:var(--yellow,#d97706);color:#000">' + orphan + '</span>');
        } else if (badge) {
          badge.remove();
        }
      } catch {}
    }

    function _esc2(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function _truncate(s, n) {
      s = String(s == null ? '' : s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }

    async function openPortsModal() {
      document.getElementById('ports-modal').classList.add('open');
      document.getElementById('ports-content').innerHTML = '<p style="color:var(--text-muted)">Scanning…</p>';
      await refreshPortsModal();
      // auto-refresh every 5s while modal is open
      if (_portsRefreshTimer) clearInterval(_portsRefreshTimer);
      _portsRefreshTimer = setInterval(refreshPortsModal, 5000);
    }

    // Stop the auto-refresh when the modal closes (closeModal is the existing helper)
    const _origCloseModal = window.closeModal;
    window.closeModal = function(id) {
      if (id === 'ports-modal' && _portsRefreshTimer) {
        clearInterval(_portsRefreshTimer);
        _portsRefreshTimer = null;
      }
      return _origCloseModal.apply(this, arguments);
    };

    async function refreshPortsModal() {
      let data;
      try { data = await fetchPorts(true); }
      catch (err) {
        document.getElementById('ports-content').innerHTML = '<p style="color:var(--red)">Scan failed: ' + _esc2(err.message) + '</p>';
        return;
      }
      _portsLastSummary = data.summary;
      const orphans = data.listeners.filter(l => l.classification.kind === 'orphan');
      const pm2 = data.listeners.filter(l => l.classification.kind === 'pm2');
      const sys = data.listeners.filter(l => l.classification.kind === 'system');
      const ignored = data.listeners.filter(l => l.classification.kind === 'ignored');

      let html = '';
      // Summary strip + adopt-queue action
      html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.78rem;color:var(--text-muted);align-items:center">';
      html += '<span><strong style="color:var(--green)">' + pm2.length + '</strong> pm2</span>';
      html += '<span><strong style="color:var(--yellow,#d97706)">' + orphans.length + '</strong> orphan</span>';
      html += '<span><strong>' + sys.length + '</strong> system</span>';
      html += '<span><strong>' + ignored.length + '</strong> ignored</span>';
      html += '<span style="margin-left:auto">scanned ' + new Date(data.scannedAt).toLocaleTimeString() + '</span>';
      html += '</div>';

      // Pending adopt queue surfacer
      const queue = (data.adoptQueue || []);
      if (queue.length) {
        html += '<div style="background:color-mix(in srgb, var(--yellow,#d97706) 15%, transparent);border:1px solid color-mix(in srgb, var(--yellow,#d97706) 35%, transparent);padding:0.6rem 0.8rem;border-radius:4px;margin-bottom:1rem;display:flex;align-items:center;gap:0.6rem;font-size:0.78rem">';
        html += '<strong>' + queue.length + ' adoption' + (queue.length === 1 ? '' : 's') + ' queued</strong>';
        html += '<span style="color:var(--text-muted);flex:1">' + queue.map(q => q.suggestedName || (q.command + ':' + q.port)).join(', ') + '</span>';
        html += '<button class="btn action-btn" onclick="previewAdoptQueue()" title="Show what will be adopted, no changes">Preview</button>';
        html += '<button class="btn btn-warn action-btn" onclick="processAdoptQueue()" title="Stop bare procs, pm2 start ecosystem entries, pm2 save">Process</button>';
        html += '</div>';
      }

      // Orphan section — the focus
      if (orphans.length === 0) {
        html += '<div style="padding:2rem;text-align:center;color:var(--green);background:var(--bg-tertiary,#1a1a1a);border-radius:6px;margin-bottom:1rem">';
        html += '✓ no unmanaged listeners — your dev environment is clean</div>';
      } else {
        html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem">Orphan listeners (' + orphans.length + ')</h3>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">';
        html += '<th style="padding:0.4rem 0.3rem">port</th><th>command</th><th>pid</th><th>cwd</th><th style="text-align:right">actions</th>';
        html += '</tr></thead><tbody>';
        for (const o of orphans) {
          const cmdLine = o.commandLine ? _truncate(o.commandLine, 80) : '';
          html += '<tr style="border-bottom:1px solid var(--border)" title="' + _esc2(o.commandLine || '') + '">';
          html += '<td style="padding:0.4rem 0.3rem;font-family:monospace"><strong>' + o.port + '</strong></td>';
          html += '<td style="font-family:monospace">' + _esc2(o.command) + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + o.pid + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + _esc2(_truncate(o.cwd || '', 40)) + '</td>';
          html += '<td style="text-align:right;white-space:nowrap">';
          html += '<button class="btn-tiny" onclick="adoptOrphan(' + o.port + ',' + o.pid + ',' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ',' + JSON.stringify(o.cwd || '').replace(/"/g, '&quot;') + ')" title="Queue for pm2 adoption">adopt</button> ';
          html += '<button class="btn-tiny" onclick="allowlistCommand(' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ')" title="Allowlist this command name (silences all its current and future ports)">allow</button> ';
          html += '<button class="btn-tiny" onclick="ignorePort(' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ',' + o.port + ')" title="Ignore just this command:port pair">ignore</button> ';
          html += '<button class="btn-tiny btn-danger" onclick="killOrphan(' + o.pid + ',' + JSON.stringify(o.command).replace(/"/g, '&quot;') + ',' + o.port + ')" title="Send SIGTERM">kill</button>';
          html += '</td></tr>';
        }
        html += '</tbody></table>';
      }

      // Collapsible details for system + pm2
      html += '<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--text-muted);font-size:0.78rem">show ' + (pm2.length + sys.length + ignored.length) + ' managed listeners</summary>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:0.75rem;margin-top:0.5rem">';
      html += '<tbody>';
      for (const l of [...pm2, ...sys, ...ignored]) {
        html += '<tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">';
        html += '<td style="padding:0.25rem 0.3rem;font-family:monospace">' + l.port + '</td>';
        html += '<td style="font-family:monospace">' + _esc2(l.command) + '</td>';
        html += '<td><span class="type-badge type-badge--' + l.classification.kind + '" style="opacity:0.7">' + l.classification.kind + '</span> ' + _esc2(l.classification.label || '') + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></details>';

      document.getElementById('ports-content').innerHTML = html;
    }

    async function adoptOrphan(port, pid, command, cwd) {
      try {
        const res = await fetch('/api/ports/adopt', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port, pid, command, cwd }),
        });
        const data = await res.json();
        if (data.ok) toast('Queued for adoption (M2 endpoint not yet wired — ' + data.queueSize + ' in queue)', 'ok');
        else toast('Adopt failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Adopt failed: ' + err.message, 'err'); }
      refreshPortsModal();
      updatePortsBadge();
    }

    async function allowlistCommand(command) {
      try {
        const res = await fetch('/api/ports/allowlist', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        });
        const data = await res.json();
        if (data.ok) toast('Allowlisted: ' + command, 'ok');
        else toast('Allowlist failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Allowlist failed: ' + err.message, 'err'); }
      refreshPortsModal();
      updatePortsBadge();
    }

    async function ignorePort(command, port) {
      try {
        const res = await fetch('/api/ports/ignore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, port }),
        });
        const data = await res.json();
        if (data.ok) toast('Ignored ' + command + ':' + port, 'ok');
        else toast('Ignore failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Ignore failed: ' + err.message, 'err'); }
      refreshPortsModal();
      updatePortsBadge();
    }

    async function killOrphan(pid, command, port) {
      if (!confirm('Send SIGTERM to ' + command + ' (pid ' + pid + ', port ' + port + ')?')) return;
      try {
        const res = await fetch('/api/ports/kill', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, signal: 'TERM' }),
        });
        const data = await res.json();
        if (data.ok) toast('Sent SIGTERM to pid ' + pid, 'ok');
        else toast('Kill failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Kill failed: ' + err.message, 'err'); }
      setTimeout(() => { refreshPortsModal(); updatePortsBadge(); }, 800);
    }

    async function previewAdoptQueue() {
      try {
        const res = await fetch('/api/ports/adopt-queue/process', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview: true }),
        });
        const data = await res.json();
        const lines = data.results.map(r =>
          (r.ok ? '✓' : '✗') + ' ' + (r.suggestedName || ('port ' + r.port)) +
          ' → ' + (r.ecosystem || r.error || 'no ecosystem found')
        );
        alert('Adoption preview (' + data.processed + ' entries):\n\n' + lines.join('\n') +
          '\n\nClick Process to actually run.');
      } catch (err) { toast('Preview failed: ' + err.message, 'err'); }
    }

    async function processAdoptQueue() {
      if (!confirm('Process adoption queue?\n\nThis will:\n  1. SIGTERM each bare process (SIGKILL after 2s if still alive)\n  2. pm2 start <ecosystem> --only <name>\n  3. pm2 save\n\nProceed?')) return;
      const btn = event && event.target;
      if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
      try {
        const res = await fetch('/api/ports/adopt-queue/process', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        const ok = data.results.filter(r => r.ok).length;
        const fail = data.results.length - ok;
        if (ok) toast(ok + ' adopted, ' + fail + ' failed (queue: ' + data.remainingQueue + ')', fail ? 'warn' : 'ok');
        if (fail) {
          const failures = data.results.filter(r => !r.ok)
            .map(r => (r.suggestedName || ('port ' + r.port)) + ': ' + (r.error || r.steps.filter(s => !s.ok).map(s => s.step + '/' + s.detail).join('; ')))
            .join('\n');
          alert('Failures:\n\n' + failures);
        }
      } catch (err) { toast('Process failed: ' + err.message, 'err'); }
      setTimeout(() => { refreshPortsModal(); updatePortsBadge(); refresh && refresh(); }, 1500);
    }

    // Auto-update orphan badge in background. Cadence comes from the server
    // intensity profile (5s aggressive, 30s normal, 60s eco) so flipping the
    // dial changes UI poll load too. Re-fetched on intensity change.
    let _portsBadgeTimer = null;
    let _portBadgeIntervalMs = 30000;
    async function rescheduleBadge() {
      try {
        const data = await fetch('/api/intensity').then(r => r.json());
        _portBadgeIntervalMs = data.profile.port_badge_poll || 30000;
      } catch {}
      if (_portsBadgeTimer) clearInterval(_portsBadgeTimer);
      _portsBadgeTimer = setInterval(updatePortsBadge, _portBadgeIntervalMs);
    }
    updatePortsBadge();
    rescheduleBadge();

    // ── Intensity dropdown (eco/normal/aggressive) ───────────────────────
    async function setIntensity(v) {
      try {
        const res = await fetch('/api/intensity', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intensity: v }),
        });
        const data = await res.json();
        if (data.ok) {
          toast('Intensity → ' + v + ' (pm2 ttl ' + (data.profile.pm2_ttl/1000) + 's)', 'ok');
          rescheduleBadge();
        } else toast('Failed: ' + (data.error || 'unknown'), 'err');
      } catch (err) { toast('Failed: ' + err.message, 'err'); }
    }
    async function initIntensityDropdown() {
      try {
        const data = await fetch('/api/intensity').then(r => r.json());
        const sel = document.getElementById('intensity-select');
        if (sel) sel.value = data.intensity;
      } catch {}
    }
    initIntensityDropdown();

    // ── Nginx modal ──────────────────────────────────────────────────────
    async function openNginxModal() {
      document.getElementById('nginx-modal').classList.add('open');
      document.getElementById('nginx-content').innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
      try {
        const data = await fetch('/api/nginx').then(r => r.json());
        renderNginxModal(data);
      } catch (err) {
        document.getElementById('nginx-content').innerHTML = '<p style="color:var(--red)">Failed: ' + _esc2(err.message) + '</p>';
      }
    }

    function renderNginxModal(d) {
      let html = '';
      // Service state strip
      html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.78rem;color:var(--text-muted);align-items:center;flex-wrap:wrap">';
      for (const s of d.brewServices || []) {
        const dot = s.status === 'started' ? '🟢' : s.status === 'error' ? '🔴' : '⚪';
        html += '<span>' + dot + ' <strong>' + _esc2(s.name) + '</strong> ' + _esc2(s.status) + '</span>';
      }
      if (!d.brewServices?.length) html += '<span>brew services unavailable</span>';
      html += '<span style="margin-left:auto;font-family:monospace">' + _esc2(d.serversDir) + '</span>';
      html += '</div>';

      // nginx -t result
      const testOk = (d.nginxTest || '').includes('test is successful');
      html += '<div style="background:' + (testOk ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'color-mix(in srgb, var(--red) 10%, transparent)') + ';border:1px solid var(--border);padding:0.5rem 0.75rem;border-radius:4px;margin-bottom:1rem;font-size:0.75rem;font-family:monospace;white-space:pre-wrap;max-height:80px;overflow:auto">';
      html += (testOk ? '✓ ' : '✗ ') + _esc2(d.nginxTest || '(no test output)');
      html += '</div>';

      // Action row
      html += '<div style="display:flex;gap:0.5rem;margin-bottom:1rem">';
      html += '<button class="btn action-btn" onclick="regenNginx(true)" title="Run gen-nginx-conf.sh in dry-run mode (preview only)">Preview regen</button>';
      html += '<button class="btn btn-warn action-btn" onclick="regenNginx(false)" title="Run gen-nginx-conf.sh and write to disk; you must reload nginx manually">Regenerate</button>';
      if (!d.genScriptExists) html += '<span style="color:var(--text-muted);align-self:center;font-size:0.75rem">⚠ gen script not found</span>';
      html += '</div>';

      // Server blocks table
      if (d.blocks.length === 0) {
        html += '<p style="color:var(--text-muted)">No server blocks parsed.</p>';
      } else {
        html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem">Server blocks (' + d.blocks.length + ')</h3>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)"><th style="padding:0.4rem 0.3rem">server_name</th><th>listen</th><th>proxy_pass</th><th>upstream</th><th>file</th></tr></thead><tbody>';
        for (const b of d.blocks) {
          const names = b.serverNames.join(' ') || '(none)';
          const listens = b.listens.join(', ') || '(none)';
          if (b.locations.length === 0) {
            html += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:0.3rem;font-family:monospace">' + _esc2(names) + '</td><td>' + _esc2(listens) + '</td><td colspan="2" style="color:var(--text-muted)">(no proxy_pass)</td><td style="font-family:monospace;color:var(--text-muted)">' + _esc2(b.file) + '</td></tr>';
          } else {
            for (const loc of b.locations) {
              const aliveBadge = loc.upstreamPort
                ? (loc.upstreamAlive ? '<span style="color:var(--green)">● alive</span>' : '<span style="color:var(--red)">● dead</span>')
                : '<span style="color:var(--text-muted)">—</span>';
              html += '<tr style="border-bottom:1px solid var(--border)">';
              html += '<td style="padding:0.3rem;font-family:monospace">' + _esc2(names) + '</td>';
              html += '<td style="font-family:monospace">' + _esc2(listens) + '</td>';
              html += '<td style="font-family:monospace">' + _esc2(loc.proxyPass) + '</td>';
              html += '<td>' + aliveBadge + '</td>';
              html += '<td style="font-family:monospace;color:var(--text-muted)">' + _esc2(b.file) + '</td>';
              html += '</tr>';
            }
          }
        }
        html += '</tbody></table>';
      }

      document.getElementById('nginx-content').innerHTML = html;
    }

    // ── Claude instances modal ────────────────────────────────────────────
    let _claudeBadgeTimer = null;
    async function updateClaudeBadge() {
      try {
        const data = await fetch('/api/claude-instances').then(r => r.json());
        const interactive = data.instances.filter(i => !i.oneShot).length;
        const btn = document.getElementById('claude-btn');
        if (!btn) return;
        let badge = btn.querySelector('.scan-badge');
        if (interactive > 0) {
          if (badge) badge.textContent = interactive;
          else btn.insertAdjacentHTML('beforeend', '<span class="scan-badge">' + interactive + '</span>');
        } else if (badge) badge.remove();
      } catch {}
    }

    async function openClaudeModal() {
      document.getElementById('claude-modal').classList.add('open');
      document.getElementById('claude-content').innerHTML = '<p style="color:var(--text-muted)">Scanning…</p>';
      try {
        const data = await fetch('/api/claude-instances').then(r => r.json());
        renderClaudeModal(data);
      } catch (err) {
        document.getElementById('claude-content').innerHTML = '<p style="color:var(--red)">Failed: ' + _esc2(err.message) + '</p>';
      }
    }

    function renderClaudeModal(data) {
      const interactive = data.instances.filter(i => !i.oneShot);
      const oneShots = data.instances.filter(i => i.oneShot);
      let html = '';
      html += '<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.78rem;color:var(--text-muted)">';
      html += '<span><strong style="color:var(--green)">' + interactive.length + '</strong> interactive</span>';
      html += '<span><strong>' + oneShots.length + '</strong> one-shot (--print)</span>';
      html += '<span style="margin-left:auto">scanned ' + new Date(data.scannedAt).toLocaleTimeString() + '</span>';
      html += '</div>';
      if (data.instances.length === 0) {
        html += '<div style="padding:2rem;text-align:center;color:var(--text-muted);background:var(--bg-tertiary,#1a1a1a);border-radius:6px">No Claude CLI instances running.</div>';
      } else {
        html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem">';
        html += '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">';
        html += '<th style="padding:0.4rem 0.3rem">pid</th><th>model</th><th>type</th><th>uptime</th><th>cwd</th></tr></thead><tbody>';
        const now = Date.now();
        for (const i of [...interactive, ...oneShots]) {
          const uptime = i.startedAt ? Math.floor((now - i.startedAt) / 1000) : null;
          const utStr = uptime == null ? '—'
            : uptime < 60 ? uptime + 's'
            : uptime < 3600 ? Math.floor(uptime/60) + 'm'
            : uptime < 86400 ? Math.floor(uptime/3600) + 'h'
            : Math.floor(uptime/86400) + 'd';
          html += '<tr style="border-bottom:1px solid var(--border)" title="' + _esc2(i.command) + '">';
          html += '<td style="padding:0.35rem 0.3rem;font-family:monospace">' + i.pid + '</td>';
          html += '<td style="font-family:monospace">' + _esc2(i.model || '—') + '</td>';
          html += '<td>' + (i.oneShot ? '<span style="color:var(--text-muted)">one-shot</span>' : '<span style="color:var(--green)">interactive</span>') + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + utStr + '</td>';
          html += '<td style="font-family:monospace;color:var(--text-muted)">' + _esc2((i.cwd || '').replace(/^\/Users\/[^\/]+/, '~')) + '</td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }
      document.getElementById('claude-content').innerHTML = html;
    }

    updateClaudeBadge();
    setInterval(updateClaudeBadge, 30000);

    async function regenNginx(dryRun) {
      try {
        const res = await fetch('/api/nginx/regen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun }),
        });
        const data = await res.json();
        if (data.ok) {
          toast(dryRun ? 'Preview generated' : 'Regenerated — reload nginx manually (sudo nginx -s reload)', 'ok');
          alert((dryRun ? 'Preview output:' : 'Generated. nginx -t result:') + '\n\n' + (data.output || data.nginxTest || '(no output)'));
        } else {
          toast('Regen failed: ' + (data.error || 'unknown'), 'err');
          alert('Failed:\n' + (data.error || data.output || ''));
        }
      } catch (err) { toast('Regen failed: ' + err.message, 'err'); }
      openNginxModal();
    }

    // ── Item Detail (source + tags) modal ────────────────────────────────
    // Shared across pm2 / daemon / cron / launchd. Two sections per item:
    //   1. Source — read-only fields specific to the type
    //   2. Tags   — editable, persisted by stableKey(type,key) so they survive
    //               restarts, reboots, and rediscovery (key is derived from
    //               the most stable identifier each type has, never the pid).
    async function openItemDetail(type, key, displayName) {
      document.getElementById('detail-title').textContent =
        (displayName || key) + '  —  ' + type;
      document.getElementById('detail-modal').classList.add('open');
      document.getElementById('detail-content').innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
      let data;
      try {
        const res = await fetch('/api/' + _detailPath(type) + '/' + encodeURIComponent(key) + '/source');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (err) {
        document.getElementById('detail-content').innerHTML =
          '<p style="color:var(--red)">Failed to load: ' + _esc2(err.message) + '</p>';
        return;
      }
      _renderItemDetail(data);
    }

    function _detailPath(type) {
      return ({ pm2: 'pm2', daemon: 'daemons', cron: 'crons', launchd: 'launchd' })[type] || type;
    }

    function _renderItemDetail(d) {
      const tags = d.tags || [];
      let html = '';

      // ── Source section ────────────────────────────────────────────────
      html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem;color:var(--text-muted)">Source</h3>';
      html += '<div style="background:var(--bg-tertiary,#1a1a1a);padding:0.75rem;border-radius:4px;font-family:monospace;font-size:0.78rem;line-height:1.5;margin-bottom:1rem;white-space:pre-wrap;word-break:break-word">';

      if (d.type === 'daemon') {
        html += '<strong>command:</strong>  ' + _esc2(d.command || '(none)') + '\n';
        html += '<strong>workdir:</strong>  ' + _esc2(d.workdir || '(default)') + '\n';
        html += '<strong>autoRestart:</strong> ' + (d.autoRestart ? 'yes' : 'no') + '  (max ' + d.maxRestarts + ', delay ' + d.restartDelay + 'ms)\n';
        if (d.logFile)  html += '<strong>stdout:</strong>   ' + _esc2(d.logFile) + '\n';
        if (d.errFile)  html += '<strong>stderr:</strong>   ' + _esc2(d.errFile) + '\n';
        if (d.pidFile)  html += '<strong>pidFile:</strong>  ' + _esc2(d.pidFile) + '\n';
        const envKeys = Object.keys(d.env || {});
        if (envKeys.length) {
          html += '\n<strong>env (' + envKeys.length + ' keys):</strong>\n';
          for (const k of envKeys) html += '  ' + _esc2(k) + '=' + _esc2(d.env[k]) + '\n';
        }
      } else if (d.type === 'cron') {
        html += '<strong>schedule:</strong> ' + _esc2(d.schedule) + '\n';
        html += '<strong>human:</strong>    ' + _esc2(d.humanSchedule || '(unparsed)') + '\n';
        html += '<strong>command:</strong>  ' + _esc2(d.command) + '\n';
        html += '<strong>enabled:</strong>  ' + (d.enabled ? 'yes' : 'no  (overridden via cronOverrides)') + '\n';
        if (d.nextRun) html += '<strong>next run:</strong> ' + new Date(d.nextRun).toLocaleString() + '\n';
        html += '<strong>source:</strong>   ' + _esc2(d.crontabPath) + '\n';
        html += '\n<strong>raw line:</strong>\n  ' + _esc2(d.rawLine);
      } else if (d.type === 'launchd') {
        html += '<strong>label:</strong>    ' + _esc2(d.label) + '\n';
        html += '<strong>plist:</strong>    ' + _esc2(d.plistPath || '(unknown)') + '\n';
        html += '<strong>runAtLoad:</strong> ' + (d.runAtLoad ? 'yes' : 'no') + '\n';
        html += '<strong>keepAlive:</strong> ' + (d.keepAlive == null ? 'no' : (typeof d.keepAlive === 'object' ? JSON.stringify(d.keepAlive) : String(d.keepAlive))) + '\n';
        if (d.program) html += '<strong>program:</strong>  ' + _esc2(d.program) + '\n';
        if (Array.isArray(d.programArguments) && d.programArguments.length) {
          html += '<strong>args:</strong>\n';
          for (const a of d.programArguments) html += '  ' + _esc2(a) + '\n';
        }
        if (d.stdoutPath) html += '<strong>stdout:</strong>   ' + _esc2(d.stdoutPath) + '\n';
        if (d.stderrPath) html += '<strong>stderr:</strong>   ' + _esc2(d.stderrPath) + '\n';
        if (d.plistRaw) {
          html += '\n<details><summary style="cursor:pointer;color:var(--text-muted)">show raw plist (' + (d.plistRaw.length) + ' bytes)</summary>';
          html += '<pre style="margin:0.5rem 0 0;font-size:0.72rem;white-space:pre-wrap">' + _esc2(d.plistRaw) + '</pre></details>';
        }
      } else if (d.type === 'pm2') {
        html += '<strong>script:</strong>      ' + _esc2(d.script || '(unknown)') + '\n';
        html += '<strong>cwd:</strong>         ' + _esc2(d.cwd || '(unknown)') + '\n';
        html += '<strong>execMode:</strong>    ' + _esc2(d.execMode || 'fork') + '\n';
        html += '<strong>interpreter:</strong> ' + _esc2(d.interpreter || 'default') + '\n';
        if (Array.isArray(d.args) && d.args.length) html += '<strong>args:</strong>        ' + _esc2(d.args.join(' ')) + '\n';
        if (d.ecosystemFile) html += '<strong>ecosystem:</strong>   ' + _esc2(d.ecosystemFile) + ' (best-guess path)\n';
        const envKeys = Object.keys(d.env || {});
        if (envKeys.length) {
          html += '\n<strong>env (' + envKeys.length + ' keys):</strong>\n';
          for (const k of envKeys) html += '  ' + _esc2(k) + '=' + _esc2(d.env[k]) + '\n';
        }
      }
      html += '</div>';

      // ── Tags section ──────────────────────────────────────────────────
      html += '<h3 style="font-size:0.9rem;margin:0 0 0.5rem;color:var(--text-muted)">Tags <span style="font-size:0.7rem;font-weight:normal;color:var(--text-muted)">(stableKey: ' + _esc2(d.stableKey) + ')</span></h3>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem" id="detail-tag-list">';
      if (tags.length === 0) html += '<em style="color:var(--text-muted);font-size:0.78rem">no tags yet</em>';
      else for (const t of tags) {
        html += '<span class="tag-pill" style="background:var(--bg-tertiary,#222);border:1px solid var(--border);padding:0.15rem 0.5rem;border-radius:10px;font-size:0.75rem;display:inline-flex;align-items:center;gap:0.3rem">';
        html += _esc2(t);
        html += '<button onclick="_removeTag(' + JSON.stringify(d.type).replace(/"/g, '&quot;') + ',' + JSON.stringify(d.key).replace(/"/g, '&quot;') + ',' + JSON.stringify(t).replace(/"/g, '&quot;') + ')" style="background:none;border:0;color:var(--text-muted);cursor:pointer;padding:0;font-size:0.85rem;line-height:1" title="Remove tag">×</button>';
        html += '</span>';
      }
      html += '</div>';
      html += '<div style="display:flex;gap:0.4rem;align-items:center">';
      html += '<input type="text" id="detail-tag-input" placeholder="add tag and press Enter" style="flex:1;padding:0.3rem 0.5rem;background:var(--bg-tertiary,#1a1a1a);border:1px solid var(--border);color:var(--text);border-radius:3px;font-size:0.78rem" onkeydown="if(event.key===\'Enter\')_addTag(' + JSON.stringify(d.type).replace(/"/g, '&quot;') + ',' + JSON.stringify(d.key).replace(/"/g, '&quot;') + ')">';
      html += '</div>';
      html += '<p style="margin-top:0.75rem;font-size:0.72rem;color:var(--text-muted)">Tags persist by <code>' + _esc2(d.stableKey) + '</code> — they survive restarts, reboots, and rediscovery. They\'re lost only if the underlying identifier changes (e.g. the pm2 name is renamed, the cron line is rewritten, the plist Label changes).</p>';

      document.getElementById('detail-content').innerHTML = html;
    }

    async function _setTags(type, key, tags) {
      const url = '/api/tags/' + encodeURIComponent(type) + '/' + encodeURIComponent(key);
      const res = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function _addTag(type, key) {
      const input = document.getElementById('detail-tag-input');
      const t = (input?.value || '').trim();
      if (!t) return;
      // re-fetch current to avoid race
      const cur = await fetch('/api/tags/' + encodeURIComponent(type) + '/' + encodeURIComponent(key)).then(r => r.json());
      const next = [...new Set([...(cur.tags || []), t])];
      try {
        await _setTags(type, key, next);
        toast('Tag added: ' + t, 'ok');
        openItemDetail(type, key);
      } catch (err) { toast('Tag add failed: ' + err.message, 'err'); }
    }

    async function _removeTag(type, key, tag) {
      const cur = await fetch('/api/tags/' + encodeURIComponent(type) + '/' + encodeURIComponent(key)).then(r => r.json());
      const next = (cur.tags || []).filter(t => t !== tag);
      try {
        await _setTags(type, key, next);
        toast('Tag removed: ' + tag, 'ok');
        openItemDetail(type, key);
      } catch (err) { toast('Tag remove failed: ' + err.message, 'err'); }
    }
