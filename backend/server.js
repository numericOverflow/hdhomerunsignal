const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const http = require('http');
const https = require('https');
const path = require('path');
const cors = require('cors');
const { DeviceClient, execFileRunner } = require('./lib/deviceClient');
const { DevicePoller } = require('./lib/devicePoller');
const {
  parseTunerStatus,
  parseDebugDb,
  parseProgram,
  parseStreamInfo,
  parsePlpInfo,
  parseL1Info
} = require('./lib/parsers');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Virtual channel such as 11.1 or 102.1
const VCHANNEL_PATTERN = /^\d{1,4}(\.\d{1,4})?$/;
const CHANNEL_MAP_PATTERN = /^[a-z]{2}-[a-z]+$/;
const LINEUP_TTL_MS = 10 * 60 * 1000;
const TARGETS_TTL_MS = 3000;
const DEVICE_STATS_LOG_MS = 60 * 1000;

function compareVchannel(a, b) {
  const [aMajor, aMinor = 0] = a.vchannel.split('.').map(Number);
  const [bMajor, bMinor = 0] = b.vchannel.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

// GET a JSON document from the device web server. Resolves null on any failure.
function fetchDeviceJson(host, urlPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: 80, path: urlPath, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

class HDHomeRunController {
  constructor() {
    this.devices = [];
    this.deviceNameCache = new Map(); // Cache for device name lookups
    this.cacheTTL = 5 * 60 * 1000; // 5 minute TTL
    this.httpDiscoveryCache = null; // Cached HTTP API results; only refreshed on explicit user request
    this.lineupCache = new Map(); // deviceId -> { at, stations }
    this.targetsCache = new Map(); // deviceId -> { at, targets, refreshing }
    this.clients = new Map(); // deviceId -> DeviceClient
    this.pollers = new Map(); // deviceId -> DevicePoller

    this.statsTimer = setInterval(() => this.logDeviceStats(), DEVICE_STATS_LOG_MS);
    this.statsTimer.unref();
  }

  // All hdhomerun_config calls for a device go through its client
  client(deviceId) {
    if (!this.clients.has(deviceId)) this.clients.set(deviceId, new DeviceClient(deviceId));
    return this.clients.get(deviceId);
  }

  // One status poller per device, shared by every browser that watches it
  poller(deviceId) {
    if (!this.pollers.has(deviceId)) {
      this.pollers.set(deviceId, new DevicePoller({
        deviceId,
        reader: {
          readStatus: (tuner, options) => this.readTunerStatus(deviceId, tuner, options),
          readProgram: (tuner) => this.readParsed(deviceId, `/tuner${tuner}/program`, parseProgram),
          readPlpInfo: (tuner) => this.readParsed(deviceId, `/tuner${tuner}/plpinfo`, parsePlpInfo),
          readL1Info: (tuner) => this.readParsed(deviceId, `/tuner${tuner}/l1info`, parseL1Info)
        }
      }));
    }
    return this.pollers.get(deviceId);
  }

  // Tell a running poller to read program and ATSC 3.0 data again, for example after a tune
  invalidateTuner(deviceId, tuner) {
    const poller = this.pollers.get(deviceId);
    if (poller) poller.invalidate(tuner);
  }

  // Log call statistics per device once a minute, so slow or failing device calls
  // show in the container log
  logDeviceStats() {
    this.clients.forEach((client, deviceId) => {
      const stats = client.takeStats();
      if (stats.calls === 0) return;
      const seconds = Math.round((stats.until - stats.since) / 1000);
      const average = Math.round(stats.totalMs / stats.calls);
      const line = `Device ${deviceId}: ${stats.calls} calls in ${seconds} s, ${stats.failures} failed (${stats.timeouts} timed out), ` +
        `avg ${average} ms, max ${stats.maxMs} ms, max queued ${stats.maxQueued}`;
      if (stats.failures > 0) console.warn(`${line}. Last error: ${stats.lastError}`);
      else console.log(line);
    });
  }

  // get a value and parse it. Resolves { ok: true, value } or { ok: false, error }.
  async readParsed(deviceId, valuePath, parse) {
    const result = await this.client(deviceId).get(valuePath);
    return result.ok ? { ok: true, value: parse(result.stdout) } : result;
  }

  // Resolves { ok: true, status } or { ok: false, error }. withDebug adds the dB estimates.
  async readTunerStatus(deviceId, tuner, { withDebug = false } = {}) {
    const client = this.client(deviceId);
    const [statusResult, debugResult] = await Promise.all([
      client.get(`/tuner${tuner}/status`),
      withDebug ? client.get(`/tuner${tuner}/debug`) : Promise.resolve(null)
    ]);
    if (!statusResult.ok) return statusResult;
    const status = parseTunerStatus(statusResult.stdout);
    if (debugResult?.ok && status.channel !== 'none') Object.assign(status, parseDebugDb(debugResult.stdout));
    return { ok: true, status };
  }

  // Raw value of /tunerN/<name>, or null if the read failed
  async getStatusCommand(deviceId, tuner, name) {
    const result = await this.client(deviceId).get(`/tuner${tuner}/${name}`);
    return result.ok ? result.stdout : null;
  }

  // set a value. Rejects with the device error, for example "ERROR: resource locked".
  async setValue(deviceId, valuePath, value) {
    const result = await this.client(deviceId).set(valuePath, value);
    if (!result.ok) throw new Error(result.error);
    return result.stdout;
  }

  getDeviceIp(deviceId) {
    const device = this.devices.find(d => d.id === deviceId);
    return device?.ip || null;
  }

  // Stream target IP per tuner index from the device status.json, for example { 0: '192.168.1.210', 1: null }.
  // Resolves null when the device web server cannot be reached.
  async getTunerTargets(deviceId) {
    const ip = this.getDeviceIp(deviceId);
    if (!ip) return null;
    const raw = await fetchDeviceJson(ip, '/status.json', 1500);
    if (!Array.isArray(raw)) return null;
    const targets = {};
    raw.forEach(entry => {
      const match = /^tuner(\d+)$/.exec(entry.Resource || '');
      if (match) targets[match[1]] = entry.TargetIP || null;
    });
    return targets;
  }

  // Last known status.json targets, refreshed in the background at most every
  // TARGETS_TTL_MS, so a status tick never waits on the device web server.
  // Returns null until the first read finishes.
  getTunerTargetsCached(deviceId) {
    let entry = this.targetsCache.get(deviceId);
    if (!entry) {
      entry = { at: 0, targets: null, refreshing: false };
      this.targetsCache.set(deviceId, entry);
    }
    if (!entry.refreshing && Date.now() - entry.at >= TARGETS_TTL_MS) {
      entry.refreshing = true;
      this.getTunerTargets(deviceId)
        .then(targets => {
          if (targets) entry.targets = targets;
        })
        .finally(() => {
          entry.at = Date.now();
          entry.refreshing = false;
        });
    }
    return entry.targets;
  }

  // Station list from the device's own channel scan (lineup.json), sorted by virtual channel
  async getLineup(deviceId, force = false) {
    const cached = this.lineupCache.get(deviceId);
    if (!force && cached && Date.now() - cached.at < LINEUP_TTL_MS) {
      return cached.stations;
    }

    const ip = this.getDeviceIp(deviceId);
    if (!ip) return cached ? cached.stations : null;

    const raw = await fetchDeviceJson(ip, '/lineup.json');
    if (!Array.isArray(raw)) return cached ? cached.stations : null;

    const stations = raw
      .filter(entry => VCHANNEL_PATTERN.test(String(entry.GuideNumber || '')))
      .map(entry => ({
        vchannel: String(entry.GuideNumber),
        name: entry.GuideName || '',
        atsc3: entry.VideoCodec === 'HEVC' || entry.AudioCodec === 'AC4',
        drm: entry.DRM === 1
      }))
      .sort(compareVchannel);

    this.lineupCache.set(deviceId, { at: Date.now(), stations });
    return stations;
  }

  async discoverDevices(forceRefresh = false) {
    // Clear device name cache on explicit user refresh to ensure fresh data
    if (forceRefresh) this.deviceNameCache.clear();

    const devices = [];
    const deviceSet = new Set(); // Track seen device IDs
    const disableDiscovery = process.env.HDHOMERUN_DISABLE_DISCOVERY === 'true';
    const manualDevices = process.env.HDHOMERUN_DEVICES || '';

    // Auto-discover devices unless disabled
    if (!disableDiscovery) {
      const autoDiscovered = await this.autoDiscoverDevices(forceRefresh);
      autoDiscovered.forEach(device => {
        if (!deviceSet.has(device.id)) {
          deviceSet.add(device.id);
          devices.push(device);
        }
      });
    } else {
      console.log('Auto-discovery disabled via HDHOMERUN_DISABLE_DISCOVERY');
    }

    // Add manually specified devices
    if (manualDevices) {
      const manualHosts = manualDevices.split(',').map(h => h.trim()).filter(h => h);
      console.log(`Adding ${manualHosts.length} manual device(s):`, manualHosts);

      const manualResults = await Promise.all(
        manualHosts.map(host => this.getDeviceByHost(host))
      );

      manualResults.forEach(device => {
        if (device && !deviceSet.has(device.id)) {
          deviceSet.add(device.id);
          devices.push(device);
          console.log(`Added manual device: ${device.id} at ${device.ip} (${device.online ? 'online' : 'offline'})`);
        }
      });
    }

    this.devices = devices;
    return devices;
  }

  async autoDiscoverDevices(forceRefresh = false) {
    // Try UDP broadcast discovery first
    const udpDevices = await this.udpDiscoverDevices();
    if (udpDevices.length > 0) {
      console.log(`UDP discovery found ${udpDevices.length} device(s)`);
      return udpDevices;
    }

    // Fallback to HTTP discovery API - only hit the remote API on explicit user refresh
    // to avoid hammering the HDHomeRun cloud service on every automatic call.
    if (!forceRefresh && this.httpDiscoveryCache !== null) {
      console.log(`UDP discovery found no devices, using cached HTTP discovery results (${this.httpDiscoveryCache.length} device(s))`);
      return this.httpDiscoveryCache;
    }

    console.log('UDP discovery found no devices, trying HTTP discovery fallback...');
    const httpDevices = await this.httpDiscoverDevices();
    if (httpDevices.length > 0) {
      console.log(`HTTP discovery found ${httpDevices.length} device(s)`);
    } else {
      console.log('HTTP discovery also found no devices');
    }
    this.httpDiscoveryCache = httpDevices;
    return httpDevices;
  }

  async udpDiscoverDevices() {
    const result = await execFileRunner(['discover'], 5000);
    if (!result.ok) {
      console.error('UDP discovery error:', result.error);
      return [];
    }

    const discovered = new Map(); // deviceId -> deviceIp
    result.stdout.split('\n').forEach(line => {
      const match = /hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)/.exec(line);
      if (match && !discovered.has(match[1])) discovered.set(match[1], match[2]);
    });

    // Fetch model info for each discovered device
    return Promise.all(Array.from(discovered.entries()).map(async ([deviceId, deviceIp]) => {
      const model = await this.getDeviceModel(deviceIp);
      return {
        id: deviceId,
        ip: deviceIp,
        name: model ? `HDHomeRun ${deviceId} (${model})` : `HDHomeRun ${deviceId}`,
        online: true
      };
    }));
  }

  async httpDiscoverDevices() {
    return new Promise((resolve) => {
      const req = https.get('https://ipv4-api.hdhomerun.com/discover', (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const entries = JSON.parse(data);
            // Filter to tuner devices only (they have DeviceID; DVRs have StorageID instead)
            const tuners = entries.filter(e => e.DeviceID);

            Promise.all(
              tuners.map(entry => {
                const ip = entry.LocalIP;
                const deviceId = entry.DeviceID;
                return this.getDeviceModel(ip).then(model => ({
                  id: ip,
                  ip: ip,
                  name: model
                    ? `HDHomeRun ${deviceId} (${model})`
                    : `HDHomeRun ${deviceId}`,
                  online: true
                }));
              })
            ).then(devices => resolve(devices));
          } catch (parseErr) {
            console.error('HTTP discovery JSON parse error:', parseErr.message);
            resolve([]);
          }
        });
      });

      req.on('error', (err) => {
        console.error('HTTP discovery request error:', err.message);
        resolve([]);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        console.error('HTTP discovery request timed out');
        resolve([]);
      });
    });
  }

  async getDeviceModel(host) {
    const result = await execFileRunner([host, 'get', '/sys/hwmodel'], 5000);
    return result.ok ? result.stdout || null : null;
  }

  async getDeviceByHost(host) {
    // Check cache first
    const cached = this.deviceNameCache.get(host);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.device;
    }

    // Query the device to verify it's reachable and get model info for the name
    const modelResult = await execFileRunner([host, 'get', '/sys/hwmodel'], 5000);
    if (!modelResult.ok) {
      console.error(`Failed to query device at ${host}:`, modelResult.error);
      // Return offline device instead of null so UI can show it grayed out
      const offlineDevice = {
        id: host,
        ip: host,
        name: `HDHomeRun (${host})`,
        online: false
      };
      this.deviceNameCache.set(host, { device: offlineDevice, timestamp: Date.now() });
      return offlineDevice;
    }

    const model = modelResult.stdout || 'Unknown';

    // Try to get the device ID for display purposes
    const discoverResult = await execFileRunner(['discover', host], 5000);
    const match = discoverResult.ok && /hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)/.exec(discoverResult.stdout);
    const deviceId = match ? match[1] : null;

    // Always use the user-specified host as the ID for commands
    // This ensures hdhomerun_config can reach the device directly by IP/hostname
    // rather than trying to rediscover it (which may fail across subnets)
    const device = {
      id: host,
      ip: host,
      name: deviceId ? `HDHomeRun ${deviceId} (${model})` : `HDHomeRun ${model} (${host})`,
      online: true
    };

    this.deviceNameCache.set(host, { device, timestamp: Date.now() });
    return device;
  }

  async getDeviceInfo(deviceId) {
    const modelResult = await this.client(deviceId).get('/sys/model');
    if (!modelResult.ok) return { model: 'Unknown', tuners: 2, atsc3Support: false };

    // ATSC 3.0 support is detected later from PLP data
    return { model: modelResult.stdout, tuners: await this.getTunerCount(deviceId), atsc3Support: true };
  }

  // A tuner exists if /tunerN/status can be read (its value can be "none")
  async getTunerCount(deviceId) {
    const client = this.client(deviceId);
    const results = await Promise.all(Array.from({ length: 8 }, (_, tuner) => client.get(`/tuner${tuner}/status`)));
    const tunerCount = results.filter(result => result.ok).length;
    return tunerCount > 0 ? tunerCount : 2;
  }

  async scanChannels(deviceId, tuner = 0, channelMap = 'us-bcast') {
    const result = await this.client(deviceId).run(['scan', `/tuner${tuner}`, channelMap], { timeoutMs: 60000 });
    if (!result.ok) {
      console.error('Scan error:', result.error);
      return [];
    }

    const channels = [];
    result.stdout.split('\n').forEach(line => {
      const scanMatch = line.match(/SCANNING: (\d+) \(([^)]+)\)/);
      const lockMatch = line.match(/LOCK: (\w+) \(ss=(\d+) snq=(\d+) seq=(\d+)\)/);
      const programMatch = line.match(/PROGRAM (\d+): ([\d.]+) (.+)/);

      if (scanMatch && lockMatch) {
        channels.push({
          frequency: scanMatch[1],
          channel: scanMatch[2],
          modulation: lockMatch[1],
          signalStrength: parseInt(lockMatch[2], 10),
          snr: parseInt(lockMatch[3], 10),
          symbolQuality: parseInt(lockMatch[4], 10),
          programs: []
        });
      }

      if (programMatch && channels.length > 0) {
        channels[channels.length - 1].programs.push({
          programNum: programMatch[1],
          virtualChannel: programMatch[2],
          name: programMatch[3]
        });
      }
    });
    return channels;
  }

  // Status with dB estimates, or null if the read failed (REST routes)
  async getTunerStatus(deviceId, tuner = 0) {
    const result = await this.readTunerStatus(deviceId, tuner, { withDebug: true });
    return result.ok ? result.status : null;
  }

  // Programs on the tuned RF channel, from /tunerN/streaminfo. Reads again while the
  // list is empty or some programs have no guide data yet (the device reports "0 (no data)").
  async getCurrentChannelPrograms(deviceId, tuner = 0, maxRetries = 3) {
    const status = await this.getTunerStatus(deviceId, tuner);
    if (!status || !status.lock || status.channel === 'none') return [];

    let programs = [];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2000));
      const result = await this.client(deviceId).get(`/tuner${tuner}/streaminfo`);
      if (!result.ok) continue;
      programs = parseStreamInfo(result.stdout);
      if (programs.length > 0 && !programs.some(program => program.noData)) break;
    }
    return programs;
  }

  setChannel(deviceId, tuner, channel) {
    return this.setValue(deviceId, `/tuner${tuner}/channel`, channel);
  }

  setVchannel(deviceId, tuner, vchannel) {
    return this.setValue(deviceId, `/tuner${tuner}/vchannel`, vchannel);
  }

  setAtsc3Channel(deviceId, tuner, channel, plps = []) {
    const value = plps.length > 0 ? `atsc3:${channel}:${plps.join('+')}` : `atsc3:${channel}`;
    return this.setValue(deviceId, `/tuner${tuner}/channel`, value);
  }

  incrementChannel(deviceId, tuner) {
    return this.setValue(deviceId, `/tuner${tuner}/channel`, '+');
  }

  decrementChannel(deviceId, tuner) {
    return this.setValue(deviceId, `/tuner${tuner}/channel`, '-');
  }

  clearTuner(deviceId, tuner) {
    return this.setValue(deviceId, `/tuner${tuner}/channel`, 'none');
  }

  async getPlpInfo(deviceId, tuner = 0) {
    const result = await this.readParsed(deviceId, `/tuner${tuner}/plpinfo`, parsePlpInfo);
    return result.ok ? result.value : null;
  }

  async getL1Info(deviceId, tuner = 0) {
    const result = await this.readParsed(deviceId, `/tuner${tuner}/l1info`, parseL1Info);
    return result.ok ? result.value : null;
  }
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const TUNER_PATTERN = /^\d{1,2}$/;

function parseIdleMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : 15;
}

// Tracks tuners that this app tuned for a browser (client ID), and frees them
// again so a test tune can never hold a tuner forever. The app never takes a
// resource lock, so a DVR or TV can always take a test tuner; the app then lets go.
class TestTuneManager {
  constructor(controller, { idleMs, disconnectGraceMs }) {
    this.controller = controller;
    this.idleMs = idleMs;
    this.disconnectGraceMs = disconnectGraceMs;
    this.tunes = new Map(); // "deviceId|tuner" -> { deviceId, tuner, clientId, vchannel, source, lastActionAt }
    this.clientSockets = new Map(); // clientId -> Set of socket IDs
    this.disconnectTimers = new Map(); // clientId -> timeout

    if (idleMs > 0) {
      this.sweepTimer = setInterval(() => this.releaseIdle(), 30 * 1000);
      this.sweepTimer.unref();
    }
  }

  key(deviceId, tuner) {
    return `${deviceId}|${tuner}`;
  }

  get(deviceId, tuner) {
    return this.tunes.get(this.key(deviceId, tuner)) || null;
  }

  record(deviceId, tuner, clientId, { vchannel = null, source }) {
    this.tunes.set(this.key(deviceId, tuner), {
      deviceId,
      tuner: String(tuner),
      clientId,
      vchannel,
      source,
      lastActionAt: Date.now()
    });
  }

  forget(deviceId, tuner) {
    this.tunes.delete(this.key(deviceId, tuner));
  }

  // IP or description of another client that holds or streams from the tuner, or null
  async findHolder(deviceId, tuner) {
    const [lockkey, target, targets] = await Promise.all([
      this.controller.getStatusCommand(deviceId, tuner, 'lockkey'),
      this.controller.getStatusCommand(deviceId, tuner, 'target'),
      this.controller.getTunerTargets(deviceId)
    ]);
    if (lockkey && lockkey !== 'none') return lockkey;
    if (target && target !== 'none') {
      const match = /\/\/([^:/]+)/.exec(target);
      return match ? match[1] : target;
    }
    return targets?.[String(tuner)] || null;
  }

  // Resolves { ok: true } when this client may change the tuner, otherwise { ok: false, error }
  async checkCanTune(deviceId, tuner, clientId) {
    const entry = this.get(deviceId, tuner);
    if (entry && entry.clientId !== clientId) {
      return { ok: false, error: 'Tuner is being tested from another browser' };
    }
    const holder = await this.findHolder(deviceId, tuner);
    if (holder) {
      this.forget(deviceId, tuner);
      return { ok: false, error: `Tuner in use by ${holder}` };
    }
    return { ok: true };
  }

  // Free a controlled tuner, unless another client took it in the meantime
  async release(deviceId, tuner, reason) {
    const entry = this.get(deviceId, tuner);
    if (!entry) return;
    this.forget(deviceId, tuner);

    const holder = await this.findHolder(deviceId, tuner);
    if (holder) {
      console.log(`Test tune ${deviceId} tuner ${tuner}: not released (${reason}), now in use by ${holder}`);
      return;
    }
    try {
      await this.controller.clearTuner(deviceId, tuner);
      console.log(`Test tune ${deviceId} tuner ${tuner}: released (${reason})`);
    } catch (error) {
      console.error(`Test tune ${deviceId} tuner ${tuner}: release failed (${reason}):`, error.message);
    }
  }

  async releaseWhere(predicate, reason) {
    const entries = Array.from(this.tunes.values()).filter(predicate);
    await Promise.all(entries.map(entry => this.release(entry.deviceId, entry.tuner, reason)));
  }

  releaseClient(clientId, { source = null, deviceId = null } = {}, reason = 'client request') {
    return this.releaseWhere(
      entry => entry.clientId === clientId &&
        (!source || entry.source === source) &&
        (!deviceId || entry.deviceId === deviceId),
      reason
    );
  }

  releaseIdle() {
    const cutoff = Date.now() - this.idleMs;
    return this.releaseWhere(entry => entry.lastActionAt < cutoff, 'idle timeout');
  }

  releaseAll(reason) {
    return this.releaseWhere(() => true, reason);
  }

  attachSocket(socket) {
    const clientId = socket.handshake.auth?.clientId;
    if (!CLIENT_ID_PATTERN.test(clientId || '')) return;
    socket.data.clientId = clientId;

    if (!this.clientSockets.has(clientId)) this.clientSockets.set(clientId, new Set());
    this.clientSockets.get(clientId).add(socket.id);

    const timer = this.disconnectTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(clientId);
    }
  }

  detachSocket(socket) {
    const clientId = socket.data.clientId;
    if (!clientId) return;
    const sockets = this.clientSockets.get(clientId);
    if (!sockets) return;
    sockets.delete(socket.id);
    if (sockets.size > 0) return;

    this.clientSockets.delete(clientId);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(clientId);
      this.releaseClient(clientId, {}, 'browser disconnected');
    }, this.disconnectGraceMs);
    timer.unref();
    this.disconnectTimers.set(clientId, timer);
  }

  // Called each status tick. Drops the entry when another client took the tuner
  // or the tuner was cleared, so the app never frees a tuner it no longer owns.
  reconcile(deviceId, tuner, status, targetIp) {
    const entry = this.get(deviceId, tuner);
    if (!entry) return;
    if (targetIp || status?.channel === 'none') this.forget(deviceId, tuner);
  }

  // State of one tuner as seen by one browser
  stateFor(deviceId, tuner, targetIp, clientId) {
    if (targetIp) return { state: 'in-use', owner: targetIp };
    const entry = this.get(deviceId, tuner);
    if (!entry) return { state: 'free' };
    if (entry.clientId !== clientId) return { state: 'in-use', owner: 'another browser' };
    return {
      state: 'controlled',
      vchannel: entry.vchannel,
      source: entry.source,
      releaseInMs: this.idleMs > 0 ? Math.max(0, entry.lastActionAt + this.idleMs - Date.now()) : null
    };
  }

  // States for all tuners of a device, keyed by tuner index
  statesFor(deviceId, tunerIndexes, targets, statuses, clientId) {
    const states = {};
    tunerIndexes.forEach(tuner => {
      const targetIp = targets?.[String(tuner)] || null;
      if (statuses && tuner in statuses) this.reconcile(deviceId, tuner, statuses[tuner], targetIp);
      states[tuner] = this.stateFor(deviceId, tuner, targetIp, clientId);
    });
    return states;
  }
}

const hdhrController = new HDHomeRunController();
const testTunes = new TestTuneManager(hdhrController, {
  idleMs: parseIdleMinutes(process.env.TEST_TUNE_IDLE_MINUTES ?? 15) * 60 * 1000,
  disconnectGraceMs: 2 * 60 * 1000
});

// API Routes
app.get('/api/devices', async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const devices = await hdhrController.discoverDevices(forceRefresh);
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/info', async (req, res) => {
  try {
    const info = await hdhrController.getDeviceInfo(req.params.id);
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/lineup', async (req, res) => {
  try {
    const stations = await hdhrController.getLineup(req.params.id, req.query.force === 'true');
    if (!stations) {
      res.status(502).json({ error: 'Could not read the station list (lineup.json) from the device' });
      return;
    }
    res.json(stations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Call statistics and poller state for one device, to diagnose slow or failing device calls
app.get('/api/devices/:id/diagnostics', (req, res) => {
  const { id } = req.params;
  const client = hdhrController.clients.get(id);
  const poller = hdhrController.pollers.get(id);
  res.json({
    calls: client ? { ...client.stats, activeNow: client.active, queuedNow: client.queue.high.length + client.queue.normal.length } : null,
    poller: poller ? {
      subscribers: poller.subscribers.size,
      tuners: Object.fromEntries(Array.from(poller.readings.entries()).map(([tuner, reading]) => [tuner, {
        channel: reading.status?.channel ?? null,
        lastGoodAgoMs: reading.okAt ? Date.now() - reading.okAt : null,
        failing: reading.failedSince !== null,
        error: reading.error
      }]))
    } : null
  });
});

app.get('/api/devices/:id/scan/:tuner', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const channelMap = String(req.query.channelMap || 'us-bcast');
    if (!TUNER_PATTERN.test(tuner) || !CHANNEL_MAP_PATTERN.test(channelMap)) {
      res.status(400).json({ error: 'Invalid tuner or channel map' });
      return;
    }
    const channels = await hdhrController.scanChannels(id, tuner, channelMap);
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/status', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const status = await hdhrController.getTunerStatus(id, tuner);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/programs', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const programs = await hdhrController.getCurrentChannelPrograms(id, tuner);
    res.json(programs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// RF channel values such as 31, auto:31 or atsc3:27:0+1
const CHANNEL_PATTERN = /^[A-Za-z0-9:+.-]{1,40}$/;

// Shared check for routes that change a tuner. Refuses a tuner that another
// client holds or that another browser is testing. Resolves the caller's client
// ID (or null for an old frontend), or sends an error response and resolves undefined.
async function guardTunerChange(req, res) {
  const { id, tuner } = req.params;
  if (!TUNER_PATTERN.test(tuner)) {
    res.status(400).json({ error: 'Invalid tuner' });
    return undefined;
  }
  const clientId = CLIENT_ID_PATTERN.test(req.body?.clientId || '') ? req.body.clientId : null;
  const check = await testTunes.checkCanTune(id, tuner, clientId);
  if (!check.ok) {
    res.status(409).json({ error: check.error });
    return undefined;
  }
  return clientId;
}

function testTuneSource(req) {
  return req.body?.source === 'antenna' ? 'antenna' : 'single';
}

// Tune by virtual channel, for example 11.1. The device maps it to the RF channel and program.
app.post('/api/devices/:id/tuner/:tuner/vchannel', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const vchannel = String(req.body?.vchannel || '');
    if (!VCHANNEL_PATTERN.test(vchannel)) {
      res.status(400).json({ error: 'Invalid virtual channel' });
      return;
    }
    const clientId = await guardTunerChange(req, res);
    if (clientId === undefined) return;

    const result = await hdhrController.setVchannel(id, tuner, vchannel);
    hdhrController.invalidateTuner(id, tuner);
    if (clientId) testTunes.record(id, tuner, clientId, { vchannel, source: testTuneSource(req) });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const channel = String(req.body?.channel || '');
    if (!CHANNEL_PATTERN.test(channel)) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }
    const clientId = await guardTunerChange(req, res);
    if (clientId === undefined) return;

    const result = await hdhrController.setChannel(id, tuner, channel);
    hdhrController.invalidateTuner(id, tuner);
    if (clientId) testTunes.record(id, tuner, clientId, { source: testTuneSource(req) });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel/up', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const clientId = await guardTunerChange(req, res);
    if (clientId === undefined) return;

    const result = await hdhrController.incrementChannel(id, tuner);
    hdhrController.invalidateTuner(id, tuner);
    if (clientId) testTunes.record(id, tuner, clientId, { source: testTuneSource(req) });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel/down', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const clientId = await guardTunerChange(req, res);
    if (clientId === undefined) return;

    const result = await hdhrController.decrementChannel(id, tuner);
    hdhrController.invalidateTuner(id, tuner);
    if (clientId) testTunes.record(id, tuner, clientId, { source: testTuneSource(req) });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/clear', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const clientId = await guardTunerChange(req, res);
    if (clientId === undefined) return;

    const result = await hdhrController.clearTuner(id, tuner);
    testTunes.forget(id, tuner);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/plpinfo', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const plpInfo = await hdhrController.getPlpInfo(id, tuner);
    res.json(plpInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/l1info', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const l1Info = await hdhrController.getL1Info(id, tuner);
    res.json(l1Info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/atsc3', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const channel = String(req.body?.channel || '');
    const plps = Array.isArray(req.body?.plps) ? req.body.plps.map(String) : [];
    if (!/^\d{1,3}$/.test(channel) || !plps.every(plp => /^\d{1,2}$/.test(plp))) {
      res.status(400).json({ error: 'Invalid ATSC 3.0 channel or PLP list' });
      return;
    }
    const clientId = await guardTunerChange(req, res);
    if (clientId === undefined) return;

    const result = await hdhrController.setAtsc3Channel(id, tuner, channel, plps);
    hdhrController.invalidateTuner(id, tuner);
    if (clientId) testTunes.record(id, tuner, clientId, { source: testTuneSource(req) });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stream URL only (for copying to clipboard)
// Uses RF channel + program number to avoid virtual channel ambiguity
app.get('/api/devices/:id/stream/url', async (req, res) => {
  try {
    const { id } = req.params;
    const { ch, program } = req.query;

    if (!ch || !program) {
      res.status(400).json({ error: 'Missing ch or program query parameter' });
      return;
    }

    const device = hdhrController.devices.find(d => d.id === id);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const streamUrl = `http://${device.ip}:5004/auto/ch${ch}-${program}`;
    res.json({ url: streamUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// M3U playlist endpoint for streaming
// Uses RF channel + program number instead of virtual channel
app.get('/api/devices/:id/stream/play.m3u', async (req, res) => {
  try {
    const { id } = req.params;
    const { ch, program, name } = req.query;

    if (!ch || !program) {
      res.status(400).json({ error: 'Missing ch or program query parameter' });
      return;
    }

    const channelName = name || `Ch${ch} Program ${program}`;

    const device = hdhrController.devices.find(d => d.id === id);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    // Tune by RF channel + program number so no channel scan is needed
    // and virtual channel collisions (e.g. two stations on 2.1) are avoided
    const streamUrl = `http://${device.ip}:5004/auto/ch${ch}-${program}`;
    const m3uContent = `#EXTM3U
#EXTINF:-1,${channelName}
${streamUrl}
`;

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    const filename = name ? name.replace(/[^a-zA-Z0-9._-]/g, '_') : `ch${ch}-${program}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.m3u"`);
    res.send(m3uContent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  testTunes.attachSocket(socket);

  // Free the tuners this browser tuned, for example when it leaves Antenna Mode
  socket.on('release-test-tunes', ({ deviceId, source } = {}) => {
    const clientId = socket.data.clientId;
    if (!clientId) return;
    testTunes.releaseClient(clientId, { deviceId, source }, source ? `left ${source}` : 'client request');
  });

  // Single-tuner view: status, dB estimates and ATSC 3.0 data for one tuner
  socket.on('start-monitoring', ({ deviceId, tuner } = {}) => {
    if (!isDeviceId(deviceId) || !TUNER_PATTERN.test(String(tuner))) return;
    const tunerIndex = Number(tuner);
    subscribeSocket(socket, deviceId, {
      mode: 'single',
      tuner: tunerIndex,
      emit: (snapshot) => {
        const reading = snapshot[tunerIndex];
        const targets = hdhrController.getTunerTargetsCached(deviceId);
        const tunerIndexes = targets ? Object.keys(targets).map(Number) : [tunerIndex];
        const freshStatuses = reading.stale ? {} : { [tunerIndex]: reading.status };
        socket.emit('tuner-status', {
          ...(reading.status || {}),
          plpInfo: reading.plpInfo,
          l1Info: reading.l1Info,
          stale: reading.stale,
          staleForMs: reading.staleForMs,
          tunerStates: testTunes.statesFor(deviceId, tunerIndexes, targets, freshStatuses, socket.data.clientId)
        });
      }
    });
  });

  // Antenna Mode: status and active program for every tuner
  socket.on('start-antenna-mode', ({ deviceId, tunerCount } = {}) => {
    const count = Number(tunerCount);
    if (!isDeviceId(deviceId) || !Number.isInteger(count) || count < 1 || count > 8) return;
    const tuners = Array.from({ length: count }, (_, i) => i);
    subscribeSocket(socket, deviceId, {
      mode: 'antenna',
      tunerCount: count,
      emit: (snapshot) => {
        const targets = hdhrController.getTunerTargetsCached(deviceId);
        const freshStatuses = {};
        tuners.forEach(tuner => {
          if (!snapshot[tuner].stale) freshStatuses[tuner] = snapshot[tuner].status;
        });
        const tunerStates = testTunes.statesFor(deviceId, tuners, targets, freshStatuses, socket.data.clientId);
        socket.emit('antenna-mode-status', tuners.map(tuner => ({
          tuner,
          status: snapshot[tuner].status,
          currentProgram: snapshot[tuner].currentProgram,
          stale: snapshot[tuner].stale,
          staleForMs: snapshot[tuner].staleForMs,
          tunerState: tunerStates[tuner]
        })));
      }
    });
  });

  socket.on('stop-monitoring', () => {
    unsubscribeSocket(socket);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    unsubscribeSocket(socket);
    testTunes.detachSocket(socket);
  });
});

function isDeviceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9.:-]{1,64}$/.test(value);
}

// A socket watches at most one device at a time, through that device's shared poller
function subscribeSocket(socket, deviceId, subscriber) {
  unsubscribeSocket(socket);
  socket.data.watchedDevice = deviceId;
  hdhrController.poller(deviceId).subscribe(socket.id, subscriber);
}

function unsubscribeSocket(socket) {
  const deviceId = socket.data.watchedDevice;
  if (!deviceId) return;
  socket.data.watchedDevice = null;
  hdhrController.poller(deviceId).unsubscribe(socket.id);
}

// Version endpoint for update checking
app.get('/api/version', (req, res) => {
  try {
    const versionPath = path.join(__dirname, 'public', 'build-version.json');
    const fs = require('fs');
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      res.json(versionData);
    } else {
      // Fallback if version file doesn't exist
      res.json({ hash: 'unknown', buildTime: null });
    }
  } catch (error) {
    res.json({ hash: 'unknown', buildTime: null });
  }
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Free test tunes on a normal container stop. Docker sends SIGTERM to PID 1.
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, releasing test tunes`);
  const forceExit = setTimeout(() => process.exit(0), 5000);
  await testTunes.releaseAll('server shutdown');
  clearTimeout(forceExit);
  process.exit(0);
};

// Listen only when run directly (node server.js). Tests require the module and listen on their own port.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`HDHomeRun Signal server running on port ${PORT}`);
  });
}

module.exports = { app, server, io, hdhrController, testTunes };