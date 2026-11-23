// Integration test: real server and real sockets, no device. hdhomerun_config is
// missing or cannot reach "test-device", so every read fails and must show as stale.
process.env.HDHOMERUN_DISABLE_DISCOVERY = 'true';
delete process.env.HDHOMERUN_DEVICES;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { server, io, hdhrController } = require('../server');

const nextEvent = (socket, event) => new Promise(resolve => socket.once(event, resolve));
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let url;
const clients = [];
const connect = (clientId) => {
  const client = ioClient(url, { auth: { clientId }, transports: ['websocket'] });
  clients.push(client);
  return new Promise(resolve => client.once('connect', () => resolve(client)));
};

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  clients.forEach(client => client.close());
  hdhrController.pollers.forEach(poller => poller.stop());
  io.close();
});

test('two browsers on one device share one poller and get stale readings', async () => {
  const antennaClient = await connect('test-client-antenna');
  const singleClient = await connect('test-client-single');

  const antennaStatus = nextEvent(antennaClient, 'antenna-mode-status');
  const singleStatus = nextEvent(singleClient, 'tuner-status');
  antennaClient.emit('start-antenna-mode', { deviceId: 'test-device', tunerCount: 2 });
  singleClient.emit('start-monitoring', { deviceId: 'test-device', tuner: 1 });

  const [antenna, single] = await Promise.all([antennaStatus, singleStatus]);

  assert.equal(antenna.length, 2);
  antenna.forEach((item, index) => {
    assert.equal(item.tuner, index);
    assert.equal(item.stale, true);
    assert.equal(item.status, null);
    assert.equal(item.tunerState.state, 'free');
  });
  assert.equal(single.stale, true);
  assert.equal(single.tunerStates[1].state, 'free');

  assert.equal(hdhrController.pollers.size, 1);
  const poller = hdhrController.pollers.get('test-device');
  assert.equal(poller.subscribers.size, 2);

  antennaClient.emit('stop-monitoring');
  singleClient.disconnect();
  await wait(200);
  assert.equal(poller.idle, true);
});

test('invalid socket requests do not start a poller', async () => {
  const client = await connect('test-client-bad');
  client.emit('start-monitoring', { deviceId: 'bad device; rm -rf /', tuner: 0 });
  client.emit('start-antenna-mode', { deviceId: 'test-device-2', tunerCount: 99 });
  client.emit('start-monitoring', { deviceId: 'test-device-3', tuner: 'x' });

  // A valid request after the invalid ones proves the server handled them in order
  const status = nextEvent(client, 'tuner-status');
  client.emit('start-monitoring', { deviceId: 'test-device-4', tuner: 0 });
  await status;

  assert.equal(hdhrController.pollers.has('bad device; rm -rf /'), false);
  assert.equal(hdhrController.pollers.has('test-device-2'), false);
  assert.equal(hdhrController.pollers.has('test-device-3'), false);
  assert.equal(hdhrController.pollers.has('test-device-4'), true);
});
