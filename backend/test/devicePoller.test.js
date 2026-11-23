const test = require('node:test');
const assert = require('node:assert/strict');
const { DevicePoller } = require('../lib/devicePoller');

const status = (channel, extra = {}) => ({ channel, lock: channel !== 'none', ss: 80, snq: 90, seq: 100, ...extra });

// Fake reader that records calls. statusFor(tuner) decides each status result.
function fakeReader(statusFor) {
  const calls = [];
  const reader = {
    readStatus: async (tuner, options) => {
      calls.push(['status', tuner, options.withDebug]);
      return statusFor(tuner);
    },
    readProgram: async (tuner) => { calls.push(['program', tuner]); return { ok: true, value: '3' }; },
    readPlpInfo: async (tuner) => { calls.push(['plp', tuner]); return { ok: true, value: null }; },
    readL1Info: async (tuner) => { calls.push(['l1', tuner]); return { ok: true, value: null }; }
  };
  return { calls, reader };
}

// Poller with a manual clock and no real timers
function makePoller(reader, options = {}) {
  let clock = 1000;
  const poller = new DevicePoller({
    deviceId: 'dev',
    reader,
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    onError: () => {},
    ...options
  });
  return { poller, advance: (ms) => { clock += ms; } };
}

test('one tick reads each tuner once, however many subscribers watch it', async () => {
  const { calls, reader } = fakeReader(() => ({ ok: true, status: status('8vsb:575000000') }));
  const { poller } = makePoller(reader);
  const seen = [];
  poller.subscribe('a', { mode: 'antenna', tunerCount: 2, emit: s => seen.push(['a', s]) });
  poller.subscribe('b', { mode: 'antenna', tunerCount: 2, emit: s => seen.push(['b', s]) });
  poller.subscribe('c', { mode: 'single', tuner: 1, emit: s => seen.push(['c', s]) });

  await poller.tick();

  const statusCalls = calls.filter(c => c[0] === 'status');
  assert.deepEqual(statusCalls, [['status', 0, false], ['status', 1, true]]);
  assert.equal(seen.length, 3);
});

test('antenna mode reads program but no debug, plpinfo or l1info', async () => {
  const { calls, reader } = fakeReader(() => ({ ok: true, status: status('8vsb:575000000') }));
  const { poller } = makePoller(reader);
  poller.subscribe('a', { mode: 'antenna', tunerCount: 1, emit: () => {} });
  await poller.tick();
  assert.deepEqual(calls, [['status', 0, false], ['program', 0]]);
});

test('slow fields are read again only after slowFieldMs, a channel change, or invalidate', async () => {
  let channel = '8vsb:575000000';
  const { calls, reader } = fakeReader(() => ({ ok: true, status: status(channel) }));
  const { poller, advance } = makePoller(reader, { slowFieldMs: 5000 });
  poller.subscribe('a', { mode: 'antenna', tunerCount: 1, emit: () => {} });
  const programReads = () => calls.filter(c => c[0] === 'program').length;

  await poller.tick();
  assert.equal(programReads(), 1);
  advance(1000);
  await poller.tick();
  assert.equal(programReads(), 1);

  channel = '8vsb:599000000';
  advance(1000);
  await poller.tick();
  assert.equal(programReads(), 2);

  advance(1000);
  poller.invalidate(0);
  await poller.tick();
  assert.equal(programReads(), 3);

  advance(5000);
  await poller.tick();
  assert.equal(programReads(), 4);
});

test('a failed read keeps the last values and reports stale with the age', async () => {
  let fail = false;
  const { reader } = fakeReader(() => (fail ? { ok: false, error: 'timeout' } : { ok: true, status: status('8vsb:575000000') }));
  const { poller, advance } = makePoller(reader);
  let last;
  poller.subscribe('a', { mode: 'antenna', tunerCount: 1, emit: s => { last = s[0]; } });

  await poller.tick();
  assert.equal(last.stale, false);
  assert.equal(last.currentProgram, '3');

  fail = true;
  advance(2000);
  await poller.tick();
  assert.equal(last.stale, true);
  assert.equal(last.staleForMs, 2000);
  assert.equal(last.status.channel, '8vsb:575000000');
  assert.equal(last.currentProgram, '3');
  assert.equal(last.error, 'timeout');

  fail = false;
  advance(1000);
  await poller.tick();
  assert.equal(last.stale, false);
  assert.equal(last.staleForMs, null);
});

test('a tuner that was never read is stale with no status', async () => {
  const { reader } = fakeReader(() => ({ ok: false, error: 'unreachable' }));
  const { poller } = makePoller(reader);
  let last;
  poller.subscribe('a', { mode: 'single', tuner: 0, emit: s => { last = s[0]; } });
  await poller.tick();
  assert.equal(last.status, null);
  assert.equal(last.stale, true);
  assert.equal(last.staleForMs, null);
});

test('an untuned tuner clears program and ATSC 3.0 data', async () => {
  let channel = '8vsb:575000000';
  const { reader } = fakeReader(() => ({ ok: true, status: status(channel) }));
  const { poller } = makePoller(reader);
  let last;
  poller.subscribe('a', { mode: 'antenna', tunerCount: 1, emit: s => { last = s[0]; } });
  await poller.tick();
  assert.equal(last.currentProgram, '3');
  channel = 'none';
  await poller.tick();
  assert.equal(last.currentProgram, null);
});

test('ticks never overlap and the loop stops with the last subscriber', async () => {
  let active = 0;
  let maxActive = 0;
  const reader = {
    readStatus: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      active -= 1;
      return { ok: true, status: status('none') };
    },
    readProgram: async () => ({ ok: true, value: null }),
    readPlpInfo: async () => ({ ok: true, value: null }),
    readL1Info: async () => ({ ok: true, value: null })
  };
  const poller = new DevicePoller({ deviceId: 'dev', reader, periodMs: 10, onError: () => {} });
  let ticks = 0;
  poller.subscribe('a', { mode: 'single', tuner: 0, emit: () => { ticks += 1; } });
  await new Promise(resolve => setTimeout(resolve, 200));
  poller.unsubscribe('a');
  const ticksAtStop = ticks;
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(maxActive, 1);
  assert.ok(ticksAtStop >= 3, `expected at least 3 ticks, got ${ticksAtStop}`);
  assert.ok(ticks - ticksAtStop <= 1, 'at most the in-flight tick finishes after stop');
  assert.equal(poller.idle, true);
});
