/**
 * Unit tests for pure functions in server.cjs
 * Run: PM2_MANAGE_TEST=1 node --test tests/unit.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  _cronId,
  _parseCronLine,
  cronNextRun,
  cronToHuman,
  formatTimeUntil,
  _launchdSchedule,
} = require('../server.cjs');

// ── _cronId ────────────────────────────────────────────────────────────────

describe('_cronId', () => {
  test('returns 8-char hex string', () => {
    const id = _cronId('0 9 * * 1', 'bash ~/.claude/scripts/weekly-todo.sh ensure');
    assert.match(id, /^[0-9a-f]{8}$/);
  });

  test('is deterministic — same inputs always produce same id', () => {
    const a = _cronId('*/30 * * * *', 'bash ~/.claude/scripts/process-stats-daemon.sh');
    const b = _cronId('*/30 * * * *', 'bash ~/.claude/scripts/process-stats-daemon.sh');
    assert.equal(a, b);
  });

  test('different schedule → different id', () => {
    const a = _cronId('0 9 * * 1', 'echo hello');
    const b = _cronId('0 10 * * 1', 'echo hello');
    assert.notEqual(a, b);
  });

  test('different command → different id', () => {
    const a = _cronId('0 9 * * 1', 'echo hello');
    const b = _cronId('0 9 * * 1', 'echo world');
    assert.notEqual(a, b);
  });

  test('schedule separator "|" is included in hash input', () => {
    // "a|b" vs "ab" should differ — separator prevents collision
    const a = _cronId('a', 'b');
    const b = _cronId('ab', '');
    assert.notEqual(a, b);
  });
});

// ── _parseCronLine ─────────────────────────────────────────────────────────

describe('_parseCronLine', () => {
  test('parses standard 5-field schedule', () => {
    const r = _parseCronLine('0 9 * * 1 bash script.sh arg1');
    assert.equal(r.schedule, '0 9 * * 1');
    assert.equal(r.command, 'bash script.sh arg1');
  });

  test('parses @-alias schedule', () => {
    const r = _parseCronLine('@daily bash cleanup.sh');
    assert.equal(r.schedule, '@daily');
    assert.equal(r.command, 'bash cleanup.sh');
  });

  test('returns null for too-few fields', () => {
    assert.equal(_parseCronLine('0 9 * * '), null);
  });

  test('handles commands with spaces correctly', () => {
    const r = _parseCronLine('0 2 * * * bash -c "echo hello world"');
    assert.equal(r.schedule, '0 2 * * *');
    assert.equal(r.command, 'bash -c "echo hello world"');
  });

  test('@reboot with no command returns null for missing command', () => {
    const r = _parseCronLine('@reboot');
    assert.equal(r, null);
  });
});

// ── cronToHuman ────────────────────────────────────────────────────────────

describe('cronToHuman', () => {
  test('@daily → Daily at midnight', () => {
    assert.equal(cronToHuman('@daily'), 'Daily at midnight');
  });

  test('@weekly → Weekly (Sun midnight)', () => {
    assert.equal(cronToHuman('@weekly'), 'Weekly (Sun midnight)');
  });

  test('@reboot → On reboot', () => {
    assert.equal(cronToHuman('@reboot'), 'On reboot');
  });

  test('@hourly → Every hour', () => {
    assert.equal(cronToHuman('@hourly'), 'Every hour');
  });

  test('*/30 * * * * → Every 30 min', () => {
    assert.equal(cronToHuman('*/30 * * * *'), 'Every 30 min');
  });

  test('0 */2 * * * → Every 2h', () => {
    assert.equal(cronToHuman('0 */2 * * *'), 'Every 2h');
  });

  test('0 9 * * * → Daily at 9:00 AM', () => {
    assert.equal(cronToHuman('0 9 * * *'), 'Daily at 9:00 AM');
  });

  test('0 14 * * 1 → Every Mon at 2:00 PM', () => {
    assert.equal(cronToHuman('0 14 * * 1'), 'Every Mon at 2:00 PM');
  });

  test('0 0 1 * * → Monthly day 1 at 12:00 AM', () => {
    assert.equal(cronToHuman('0 0 1 * *'), 'Monthly day 1 at 12:00 AM');
  });
});

// ── cronNextRun ────────────────────────────────────────────────────────────

describe('cronNextRun', () => {
  test('returns a future timestamp for "* * * * *"', () => {
    const now = Date.now();
    const next = cronNextRun('* * * * *');
    assert.ok(next > now, 'next run should be in the future');
    assert.ok(next < now + 2 * 60 * 1000, 'next run should be within 2 minutes');
  });

  test('returns null for @reboot', () => {
    assert.equal(cronNextRun('@reboot'), null);
  });

  test('@daily alias resolves to midnight run', () => {
    const next = cronNextRun('@daily');
    assert.ok(next !== null);
    const d = new Date(next);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
  });

  test('@hourly → next run within 1 hour', () => {
    const next = cronNextRun('@hourly');
    const now = Date.now();
    assert.ok(next > now);
    assert.ok(next <= now + 3600 * 1000);
  });

  test('*/30 * * * * → next run within 30 minutes', () => {
    const next = cronNextRun('*/30 * * * *');
    const now = Date.now();
    assert.ok(next > now);
    assert.ok(next <= now + 30 * 60 * 1000);
  });

  test('returns null for invalid schedule', () => {
    const next = cronNextRun('invalid');
    assert.equal(next, null);
  });

  test('DOM/DOW OR logic — specific dom+dow fires on either condition', () => {
    // "1 5 15 * 1" = 5:01 AM on the 15th OR any Monday (POSIX OR logic)
    const next = cronNextRun('1 5 15 * 1');
    assert.ok(next !== null);
    // Verify the result day satisfies dom=15 OR dow=Monday
    const d = new Date(next);
    const isDay15 = d.getDate() === 15;
    const isMonday = d.getDay() === 1;
    assert.ok(isDay15 || isMonday, 'should fire on day-15 or Monday');
  });
});

// ── formatTimeUntil ────────────────────────────────────────────────────────

describe('formatTimeUntil', () => {
  test('null/undefined → "—"', () => {
    assert.equal(formatTimeUntil(null), '—');
    assert.equal(formatTimeUntil(undefined), '—');
  });

  test('past/zero → "now"', () => {
    assert.equal(formatTimeUntil(Date.now() - 1000), 'now');
  });

  test('seconds < 60 → Ns', () => {
    const result = formatTimeUntil(Date.now() + 30 * 1000);
    assert.match(result, /^\d+s$/);
  });

  test('minutes (no hours) → "in Nm"', () => {
    const result = formatTimeUntil(Date.now() + 5 * 60 * 1000);
    assert.match(result, /^in \d+m$/);
  });

  test('hours → "in Nh Nm"', () => {
    const result = formatTimeUntil(Date.now() + 3 * 3600 * 1000 + 20 * 60 * 1000);
    assert.match(result, /^in \d+h \d+m$/);
  });

  test('days → "in Nd Nh"', () => {
    const result = formatTimeUntil(Date.now() + 2 * 24 * 3600 * 1000);
    assert.match(result, /^in \d+d \d+h$/);
  });
});

// ── _launchdSchedule ───────────────────────────────────────────────────────

describe('_launchdSchedule', () => {
  test('StartCalendarInterval daily at fixed time', () => {
    const result = _launchdSchedule({
      StartCalendarInterval: { Hour: 6, Minute: 4 },
    });
    assert.equal(result, 'Daily at 6:04 AM');
  });

  test('StartCalendarInterval weekly', () => {
    const result = _launchdSchedule({
      StartCalendarInterval: { Weekday: 1, Hour: 9, Minute: 0 },
    });
    assert.equal(result, 'Every Mon at 9:00 AM');
  });

  test('StartCalendarInterval monthly', () => {
    const result = _launchdSchedule({
      StartCalendarInterval: { Day: 1, Hour: 2, Minute: 30 },
    });
    assert.equal(result, 'Monthly day 1 at 2:30 AM');
  });

  test('StartInterval in seconds < 60', () => {
    const result = _launchdSchedule({ StartInterval: 30 });
    assert.equal(result, 'Every 30s');
  });

  test('StartInterval in minutes', () => {
    const result = _launchdSchedule({ StartInterval: 3600 });
    assert.equal(result, 'Every 1h');
  });

  test('StartInterval every 30 minutes', () => {
    const result = _launchdSchedule({ StartInterval: 1800 });
    assert.equal(result, 'Every 30m');
  });

  test('RunAtLoad only → "On load"', () => {
    const result = _launchdSchedule({ RunAtLoad: true });
    assert.equal(result, 'On load');
  });

  test('empty plist → null', () => {
    const result = _launchdSchedule({});
    assert.equal(result, null);
  });
});
