const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceClient } = require('../lib/deviceClient');

// Fake runner: each call waits until the test releases it
function controlledRunner() {
  const calls = [];
  const runner = (args) => new Promise(resolve => calls.push({ args, resolve }));
  return { calls, runner };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('DeviceClient runs at most `concurrency` calls at once', async () => {
  const { calls, runner } = controlledRunner();
  const client = new DeviceClient('dev', { runner, concurrency: 2 });
  const results = [1, 2, 3, 4].map(n => client.get(`/tuner${n}/status`));
  await flush();
  assert.equal(calls.length, 2);

  calls[0].resolve({ ok: true, stdout: 'a' });
  await flush();
  assert.equal(calls.length, 3);

  calls.slice(1).forEach(call => call.resolve({ ok: true, stdout: 'b' }));
  await flush();
  calls[3].resolve({ ok: true, stdout: 'c' });
  const resolved = await Promise.all(results);
  assert.deepEqual(resolved.map(r => r.ok), [true, true, true, true]);
});

test('DeviceClient runs set calls before queued get calls', async () => {
  const { calls, runner } = controlledRunner();
  const client = new DeviceClient('dev', { runner, concurrency: 1 });
  client.get('/tuner0/status');
  client.get('/tuner1/status');
  client.set('/tuner2/vchannel', '11.1');
  await flush();
  assert.deepEqual(calls[0].args, ['dev', 'get', '/tuner0/status']);

  calls[0].resolve({ ok: true, stdout: '' });
  await flush();
  assert.deepEqual(calls[1].args, ['dev', 'set', '/tuner2/vchannel', '11.1']);
});

test('DeviceClient never rejects and counts failures and timeouts', async () => {
  const runner = async (args) => {
    if (args[2] === '/boom') throw new Error('spawn failed');
    if (args[2] === '/slow') return { ok: false, error: 'timeout', timedOut: true };
    return { ok: true, stdout: 'x' };
  };
  const client = new DeviceClient('dev', { runner });
  assert.deepEqual(await client.get('/boom'), { ok: false, error: 'spawn failed', timedOut: false });
  assert.equal((await client.get('/slow')).ok, false);
  assert.equal((await client.get('/fine')).ok, true);

  const stats = client.takeStats();
  assert.equal(stats.calls, 3);
  assert.equal(stats.failures, 2);
  assert.equal(stats.timeouts, 1);
  assert.equal(client.takeStats().calls, 0);
});
