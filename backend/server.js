const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const cors = require('cors');

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

// Virtual channel such as 11.1 or 102.1. Strict, because the value goes into a shell command.
const VCHANNEL_PATTERN = /^\d{1,4}(\.\d{1,4})?$/;
const LINEUP_TTL_MS = 10 * 60 * 1000;

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
    this.activeDevice = null;
    this.activeTuner = 0;
    this.monitoringIntervals = new Map(); // Per-socket monitoring intervals
    this.deviceNameCache = new Map(); // Cache for device name lookups
    this.cacheTTL = 5 * 60 * 1000; // 5 minute TTL
    this.httpDiscoveryCache = null; // Cached HTTP API results; only refreshed on explicit user request
    this.lineupCache = new Map(); // deviceId -> { at, stations }
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
    return new Promise((resolve) => {
      exec('hdhomerun_config discover', { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('UDP discovery error:', error.message);
          resolve([]);
          return;
        }

        const deviceSet = new Set();
        const discoveredDevices = [];
        const lines = stdout.split('\n').filter(line => line.trim());

        lines.forEach(line => {
          const match = line.match(/hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)/);
          if (match) {
            const deviceId = match[1];
            const deviceIp = match[2];

            if (!deviceSet.has(deviceId)) {
              deviceSet.add(deviceId);
              discoveredDevices.push({ deviceId, deviceIp });
            }
          }
        });

        // Fetch model info for each discovered device
        Promise.all(
          discoveredDevices.map(({ deviceId, deviceIp }) => this.getDeviceModel(deviceIp).then(model => ({
            id: deviceId,
            ip: deviceIp,
            name: model ? `HDHomeRun ${deviceId} (${model})` : `HDHomeRun ${deviceId}`,
            online: true
          })))
        ).then(devices => resolve(devices));
      });
    });
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
    return new Promise((resolve) => {
      exec(`hdhomerun_config ${host} get /sys/hwmodel`, { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      });
    });
  }

  async getDeviceByHost(host) {
    // Check cache first
    const cached = this.deviceNameCache.get(host);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log(`Using cached device info for ${host}`);
      return cached.device;
    }

    return new Promise((resolve) => {
      // Query the device to verify it's reachable and get model info for the name
      exec(`hdhomerun_config ${host} get /sys/hwmodel`, { timeout: 5000 }, (error, stdout) => {
        if (error) {
          console.error(`Failed to query device at ${host}:`, error.message);
          // Return offline device instead of null so UI can show it grayed out
          const offlineDevice = {
            id: host,
            ip: host,
            name: `HDHomeRun (${host})`,
            online: false
          };
          this.deviceNameCache.set(host, { device: offlineDevice, timestamp: Date.now() });
          resolve(offlineDevice);
          return;
        }

        const model = stdout.trim() || 'Unknown';

        // Try to get the device ID for display purposes
        exec(`hdhomerun_config discover ${host}`, { timeout: 5000 }, (discoverErr, discoverOut) => {
          const match = discoverOut && discoverOut.match(/hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)/);
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

          // Cache the result
          this.deviceNameCache.set(host, { device, timestamp: Date.now() });
          console.log(`Cached device info for ${host}`);

          resolve(device);
        });
      });
    });
  }

  async getDeviceInfo(deviceId) {
    return new Promise((resolve, reject) => {
      // Get both model and tuner count
      exec(`hdhomerun_config ${deviceId} get /sys/model`, (error, stdout) => {
        if (error) {
          resolve({ model: 'Unknown', tuners: 2, atsc3Support: false });
          return;
        }
        
        const model = stdout.trim();
        
        // ATSC 3.0 support - will be auto-detected based on PLP data availability
        const atsc3Support = true; // Auto-detect rather than model-based
        
        // Try to get actual tuner count by checking which tuners exist
        this.getTunerCount(deviceId).then(tunerCount => {
          resolve({ model, tuners: tunerCount, atsc3Support });
        }).catch(() => {
          // Fallback to model-based detection
          let tuners = 2;
          if (model.includes('PRIME')) tuners = 3;
          else if (model.includes('QUATTRO') || model.includes('QUATRO')) tuners = 4;
          else if (model.includes('DUO')) tuners = 2;
          else if (model.includes('FLEX')) tuners = 2;
          else if (model.includes('CONNECT')) tuners = 2;
          
          resolve({ model, tuners, atsc3Support });
        });
      });
    });
  }

  async getTunerCount(deviceId) {
    return new Promise((resolve, reject) => {
      // Check tuners 0-7 to see which ones exist
      const checkTuner = (tunerNum) => {
        return new Promise((resolveCheck) => {
          exec(`hdhomerun_config ${deviceId} get /tuner${tunerNum}/status`, (error, stdout) => {
            // If no error, tuner exists (even if status is 'none')
            resolveCheck(!error);
          });
        });
      };

      Promise.all([
        checkTuner(0), checkTuner(1), checkTuner(2), checkTuner(3),
        checkTuner(4), checkTuner(5), checkTuner(6), checkTuner(7)
      ]).then(results => {
        const tunerCount = results.filter(exists => exists).length;
        resolve(tunerCount > 0 ? tunerCount : 2); // Default to 2 if none found
      }).catch(() => {
        resolve(2); // Default fallback
      });
    });
  }

  async scanChannels(deviceId, tuner = 0, channelMap = 'us-bcast') {
    return new Promise((resolve, reject) => {
      const command = `hdhomerun_config ${deviceId} scan /tuner${tuner} ${channelMap}`;
      
      exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('Scan error:', error);
          resolve([]);
          return;
        }

        const channels = [];
        const lines = stdout.split('\n');
        
        lines.forEach(line => {
          const scanMatch = line.match(/SCANNING: (\d+) \(([^)]+)\)/);
          const lockMatch = line.match(/LOCK: (\w+) \(ss=(\d+) snq=(\d+) seq=(\d+)\)/);
          const programMatch = line.match(/PROGRAM (\d+): ([\d.]+) (.+)/);
          
          if (scanMatch && lockMatch) {
            const frequency = scanMatch[1];
            const channel = scanMatch[2];
            const modulation = lockMatch[1];
            const signalStrength = parseInt(lockMatch[2]);
            const snr = parseInt(lockMatch[3]);
            const symbolQuality = parseInt(lockMatch[4]);
            
            channels.push({
              frequency,
              channel,
              modulation,
              signalStrength,
              snr,
              symbolQuality,
              programs: []
            });
          }
          
          if (programMatch && channels.length > 0) {
            const programNum = programMatch[1];
            const virtualChannel = programMatch[2];
            const name = programMatch[3];
            
            channels[channels.length - 1].programs.push({
              programNum,
              virtualChannel,
              name
            });
          }
        });

        resolve(channels);
      });
    });
  }

  async getTunerStatus(deviceId, tuner = 0) {
    return new Promise(async (resolve, reject) => {
      try {
        // Get both regular status and debug info simultaneously
        const [statusResult, debugResult] = await Promise.all([
          this.getStatusCommand(deviceId, tuner, 'status'),
          this.getStatusCommand(deviceId, tuner, 'debug')
        ]);

        if (!statusResult) {
          resolve(null);
          return;
        }

        const status = {};
        const statusLine = statusResult.trim();
        
        if (statusLine === 'none') {
          resolve({ channel: 'none', lock: false });
          return;
        }

        const patterns = {
          channel: /ch=([^\s]+)/,
          lock: /lock=([^\s]+)/,
          ss: /ss=(\d+)/,
          snq: /snq=(\d+)/,
          seq: /seq=(\d+)/,
          bps: /bps=(\d+)/,
          pps: /pps=(\d+)/
        };

        Object.entries(patterns).forEach(([key, pattern]) => {
          const match = statusLine.match(pattern);
          if (match) {
            status[key] = key === 'lock' ? match[1] : 
                         ['ss', 'snq', 'seq', 'bps', 'pps'].includes(key) ? 
                         parseInt(match[1]) : match[1];
          }
        });

        // lock=<modulation> (for example 8vsb) means locked. lock=none means no lock.
        // A value in parentheses, for example (8vsb), is a detected but unsupported modulation.
        status.lock = typeof status.lock === 'string' &&
                       status.lock !== 'none' &&
                       !status.lock.startsWith('(');
        
        // Extract dB values from debug output with educated conversion
        if (debugResult) {
          const dbgMatch = debugResult.match(/dbg=(\d+)-(\d+)\/(-?\d+)/);
          if (dbgMatch) {
            const signalRaw = parseInt(dbgMatch[1]);
            const snrRaw = parseInt(dbgMatch[2]);
            
            // Signal strength: map raw values to realistic ATSC dBm range
            // Based on observed data: 9-86 raw maps to roughly -80 to -40 dBm
            let estimatedSignalDbm;
            if (signalRaw >= 80) estimatedSignalDbm = -40 - (100 - signalRaw) * 0.5;  // Strong: -40 to -50
            else if (signalRaw >= 60) estimatedSignalDbm = -50 - (80 - signalRaw) * 0.5;   // Good: -50 to -60
            else if (signalRaw >= 20) estimatedSignalDbm = -60 - (60 - signalRaw) * 0.5;   // Fair: -60 to -80
            else estimatedSignalDbm = -80 - (20 - signalRaw) * 0.5;                       // Weak: -80+
            
            // SNR: more direct conversion (0-80 raw ≈ 0-25 dB)
            const estimatedSnrDb = snrRaw * 0.31; // Rough linear conversion
            
            status.ssDb = Math.round(estimatedSignalDbm * 10) / 10;
            status.snrDb = snrRaw > 0 ? Math.round(estimatedSnrDb * 10) / 10 : 0;
            status.debugRaw = `${signalRaw}-${snrRaw}/${dbgMatch[3]}`;
            
            console.log(`dB estimate: ${status.ss}% signal = ${signalRaw} raw → ${status.ssDb}dBm, ${status.snq}% SNR = ${snrRaw} raw → ${status.snrDb}dB`);
          }
        }
        
        resolve(status);
      } catch (error) {
        resolve(null);
      }
    });
  }

  async getStatusCommand(deviceId, tuner, command) {
    return new Promise((resolve) => {
      exec(`hdhomerun_config ${deviceId} get /tuner${tuner}/${command}`, (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  async getSignalDbValues(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      // Try to get dB values using various debug commands
      Promise.all([
        this.getDbValue(deviceId, tuner, 'debug'),
        this.getDbValue(deviceId, tuner, 'vstatus'),
        this.getDbValue(deviceId, tuner, 'streaminfo'),
        this.getDbValue(deviceId, tuner, 'plotsample')
      ]).then(results => {
        console.log(`dB query results for ${deviceId} tuner ${tuner}:`, results);
        
        const dbData = {};
        
        // Parse results for dB values
        results.forEach((result, index) => {
          if (result) {
            console.log(`Command ${index} output:`, result);
            
            // Look for HDHomeRun debug format: dbg=65-19/-1817
            const dbgMatch = result.match(/dbg=(\d+)-(\d+)\/(-?\d+)/);
            if (dbgMatch) {
              // Format appears to be: signal-snr/something
              const signalRaw = parseInt(dbgMatch[1]);
              const snrRaw = parseInt(dbgMatch[2]);
              const thirdValue = parseInt(dbgMatch[3]);
              
              // Convert to actual dB values 
              // Different conversion for ATSC 1.0 vs 3.0 - try simpler mapping
              // For 71% signal, expect around -50 to -60 dBm
              dbData.ssDb = -100 + (signalRaw * 0.5); // Linear scaling attempt
              dbData.snrDb = snrRaw;
              dbData.debugRaw = `${signalRaw}-${snrRaw}/${thirdValue}`;
              
              console.log(`Converted dB values: signal=${signalRaw} -> ${dbData.ssDb}dBm, snr=${snrRaw} -> ${dbData.snrDb}dB`);
            }
            
            // Look for standard dB patterns as fallback
            const ssDbMatch = result.match(/ss=(-?\d+(?:\.\d+)?)dBm/i);
            const snrDbMatch = result.match(/snr=(-?\d+(?:\.\d+)?)dB/i);
            const rssiMatch = result.match(/rssi=(-?\d+(?:\.\d+)?)/i);
            
            if (ssDbMatch) dbData.ssDb = parseFloat(ssDbMatch[1]);
            if (snrDbMatch) dbData.snrDb = parseFloat(snrDbMatch[1]);
            if (rssiMatch) dbData.rssi = parseFloat(rssiMatch[1]);
          }
        });
        
        console.log('Parsed dB data:', dbData);
        resolve(dbData);
      }).catch((error) => {
        console.log('dB query error:', error);
        resolve({});
      });
    });
  }

  async getDbValue(deviceId, tuner, command) {
    return new Promise((resolve) => {
      exec(`hdhomerun_config ${deviceId} get /tuner${tuner}/${command}`, (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  async getCurrentProgram(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} get /tuner${tuner}/program`, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const program = stdout.trim();
        if (program && program !== 'none') {
          resolve(program);
        } else {
          resolve(null);
        }
      });
    });
  }

  async getCurrentChannelPrograms(deviceId, tuner = 0, maxRetries = 3) {
    return new Promise(async (resolve, reject) => {
      // First check if tuner is locked
      const status = await this.getTunerStatus(deviceId, tuner);
      if (!status || !status.lock || status.channel === 'none') {
        resolve([]);
        return;
      }

      let attempt = 0;
      const tryGetPrograms = () => {
        exec(`hdhomerun_config ${deviceId} get /tuner${tuner}/streaminfo`, (error, stdout) => {
          if (error) {
            if (attempt < maxRetries) {
              attempt++;
              setTimeout(tryGetPrograms, 1500); // Wait 1.5s between retries
              return;
            }
            resolve([]);
            return;
          }

          const programs = [];
          const lines = stdout.split('\n').filter(line => line.trim());
          
          lines.forEach(line => {
            // Enhanced parsing for both ATSC 1.0 and 3.0 formats
            // ATSC 1.0: tsid=0x0001 program=1: 12.1 WHYY (encrypted)
            // ATSC 3.0: service=1: 12.1 WHYY (atsc3) or program=1: 12.1 WHYY
            const programMatch = line.match(/(?:program|service)=(\d+):\s*([\d.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$/);
            if (programMatch) {
              const programNum = programMatch[1];
              const virtualChannel = programMatch[2];
              const name = programMatch[3].trim();
              const status = programMatch[4] || '';
              
              programs.push({
                programNum,
                virtualChannel,
                name,
                callsign: name,
                status,
                encrypted: status.includes('encrypted'),
                atsc3: status.includes('atsc3')
              });
            } else {
              // Try alternative format parsing
              const altMatch = line.match(/(\d+):\s*([\d.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$/);
              if (altMatch) {
                programs.push({
                  programNum: altMatch[1],
                  virtualChannel: altMatch[2],
                  name: altMatch[3].trim(),
                  callsign: altMatch[3].trim(),
                  status: altMatch[4] || '',
                  encrypted: (altMatch[4] || '').includes('encrypted'),
                  atsc3: (altMatch[4] || '').includes('atsc3')
                });
              }
            }
          });

          // If no programs found and we have retries left, try again
          if (programs.length === 0 && attempt < maxRetries) {
            attempt++;
            setTimeout(tryGetPrograms, 2000); // Wait longer for ATSC 3.0
            return;
          }

          resolve(programs);
        });
      };

      tryGetPrograms();
    });
  }

  async setChannel(deviceId, tuner, channel) {
    return new Promise((resolve, reject) => {
      // Handle ATSC 3.0 format: atsc3:27:0+1+2 or regular format: 27
      let command;
      if (channel.includes('atsc3:')) {
        command = `hdhomerun_config ${deviceId} set /tuner${tuner}/channel ${channel}`;
      } else {
        // For regular channels, check if we should use ATSC 3.0 format
        // This could be enhanced to auto-detect based on device capabilities
        command = `hdhomerun_config ${deviceId} set /tuner${tuner}/channel ${channel}`;
      }
      
      exec(command, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async setVchannel(deviceId, tuner, vchannel) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} set /tuner${tuner}/vchannel ${vchannel}`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async setAtsc3Channel(deviceId, tuner, channel, plps = []) {
    return new Promise((resolve, reject) => {
      let channelStr = `atsc3:${channel}`;
      if (plps.length > 0) {
        channelStr += `:${plps.join('+')}`;
      }
      
      exec(`hdhomerun_config ${deviceId} set /tuner${tuner}/channel ${channelStr}`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async incrementChannel(deviceId, tuner) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} set /tuner${tuner}/channel +`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async decrementChannel(deviceId, tuner) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} set /tuner${tuner}/channel -`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async clearTuner(deviceId, tuner) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} set /tuner${tuner}/channel none`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async getPlpInfo(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} get /tuner${tuner}/plpinfo`, (error, stdout) => {
        console.log(`PLP Info for ${deviceId} tuner ${tuner}:`, error ? 'ERROR: ' + error.message : stdout);
        
        if (error) {
          resolve(null);
          return;
        }

        const plpData = {};
        const lines = stdout.split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
          // Parse PLP info output
          // Actual format: "0: sfi=0 mod=qam256 cod=10/15 layer=core ti=cti lls=1 lock=1"
          const plpMatch = line.match(/^(\d+):/);
          if (plpMatch) {
            const plpId = plpMatch[1];
            plpData[plpId] = {};
            
            // Extract all key=value pairs
            const sfiMatch = line.match(/sfi=(\w+)/);
            const modMatch = line.match(/mod=(\w+)/);
            const codMatch = line.match(/cod=([0-9/]+)/);
            const layerMatch = line.match(/layer=(\w+)/);
            const tiMatch = line.match(/ti=(\w+)/);
            const llsMatch = line.match(/lls=(\d+)/);
            const lockMatch = line.match(/lock=(\d+)/);
            
            if (sfiMatch) plpData[plpId].sfi = sfiMatch[1];
            if (modMatch) plpData[plpId].modulation = modMatch[1];
            if (codMatch) plpData[plpId].coderate = codMatch[1];
            if (layerMatch) plpData[plpId].layer = layerMatch[1];
            if (tiMatch) plpData[plpId].timeInterleaving = tiMatch[1];
            if (llsMatch) plpData[plpId].lls = llsMatch[1] === '1';
            if (lockMatch) plpData[plpId].lock = lockMatch[1] === '1';
          }
        });

        console.log('Parsed PLP data:', plpData);
        resolve(Object.keys(plpData).length > 0 ? plpData : null);
      });
    });
  }

  async getL1Info(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      exec(`hdhomerun_config ${deviceId} get /tuner${tuner}/l1info`, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const l1Data = {};
        const lines = stdout.split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
          // Parse L1 info output
          // Format examples: l1_basic_mode=1 l1_detail_mode=2 fft_size=8192
          const keyValueMatch = line.match(/(\w+)=([^\s]+)/g);
          if (keyValueMatch) {
            keyValueMatch.forEach(match => {
              const [key, value] = match.split('=');
              l1Data[key] = value;
            });
          }
        });

        resolve(Object.keys(l1Data).length > 0 ? l1Data : null);
      });
    });
  }

  startMonitoring(socket, deviceId, tuner) {
    this.stopMonitoring(socket);

    const intervalId = setInterval(async () => {
      try {
        const [status, currentProgram, targets] = await Promise.all([
          this.getTunerStatus(deviceId, tuner),
          this.getCurrentProgram(deviceId, tuner),
          this.getTunerTargets(deviceId)
        ]);

        // Free / controlled / in-use for every tuner, for the tuner selector and the station picker
        const tunerIndexes = targets ? Object.keys(targets).map(Number) : [Number(tuner)];
        const tunerStates = testTunes.statesFor(deviceId, tunerIndexes, targets, { [Number(tuner)]: status }, socket.data.clientId);

        // Get ATSC 3.0 info if channel is tuned and device supports it
        let plpInfo = null;
        let l1Info = null;
        if (status && status.channel && status.channel !== 'none') {
          // Try to get ATSC 3.0 info - will return null if not ATSC 3.0
          plpInfo = await this.getPlpInfo(deviceId, tuner);
          l1Info = await this.getL1Info(deviceId, tuner);
        }

        socket.emit('tuner-status', {
          ...status,
          currentProgram,
          plpInfo,
          l1Info,
          tunerStates
        });
      } catch (error) {
        console.error('Monitoring error:', error);
      }
    }, 1000);

    this.monitoringIntervals.set(socket.id, intervalId);
  }

  startAntennaMode(socket, deviceId, tunerCount) {
    this.stopMonitoring(socket);

    console.log(`Starting antenna mode for device ${deviceId} with ${tunerCount} tuners`);

    const intervalId = setInterval(async () => {
      try {
        // Monitor all tuners simultaneously. currentProgram is the program
        // number a client is filtering (null when the whole RF channel is open).
        const [allTunersData, targets] = await Promise.all([
          Promise.all(
            Array.from({ length: tunerCount }, (_, i) =>
              Promise.all([
                this.getTunerStatus(deviceId, i),
                this.getCurrentProgram(deviceId, i)
              ])
                .then(([status, currentProgram]) => ({ tuner: i, status, currentProgram }))
                .catch(error => {
                  console.error(`Error monitoring tuner ${i}:`, error);
                  return { tuner: i, status: null, currentProgram: null };
                })
            )
          ),
          this.getTunerTargets(deviceId)
        ]);

        const statuses = {};
        allTunersData.forEach(({ tuner, status }) => { statuses[tuner] = status; });
        const tunerStates = testTunes.statesFor(
          deviceId,
          allTunersData.map(({ tuner }) => tuner),
          targets,
          statuses,
          socket.data.clientId
        );

        socket.emit('antenna-mode-status', allTunersData.map(item => ({
          ...item,
          tunerState: tunerStates[item.tuner]
        })));
      } catch (error) {
        console.error('Antenna mode monitoring error:', error);
      }
    }, 1000);

    this.monitoringIntervals.set(socket.id, intervalId);
  }

  stopMonitoring(socket) {
    const socketId = socket?.id;
    if (socketId && this.monitoringIntervals.has(socketId)) {
      clearInterval(this.monitoringIntervals.get(socketId));
      this.monitoringIntervals.delete(socketId);
    }
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

app.get('/api/devices/:id/scan/:tuner', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const { channelMap = 'us-bcast' } = req.query;
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

// RF channel values such as 31, auto:31 or atsc3:27:0+1. Strict, because the value goes into a shell command.
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
    if (clientId) testTunes.record(id, tuner, clientId, { source: testTuneSource(req) });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel/up', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const result = await hdhrController.incrementChannel(id, tuner);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel/down', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const result = await hdhrController.decrementChannel(id, tuner);
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
    const { channel, plps } = req.body;
    const result = await hdhrController.setAtsc3Channel(id, tuner, channel, plps);
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

  socket.on('start-monitoring', ({ deviceId, tuner }) => {
    console.log(`Starting monitoring for device ${deviceId}, tuner ${tuner}`);
    hdhrController.startMonitoring(socket, deviceId, tuner);
  });

  socket.on('start-antenna-mode', ({ deviceId, tunerCount }) => {
    console.log(`Starting antenna mode for device ${deviceId} with ${tunerCount} tuners`);
    hdhrController.startAntennaMode(socket, deviceId, tunerCount);
  });

  socket.on('stop-monitoring', () => {
    console.log('Stopping monitoring for:', socket.id);
    hdhrController.stopMonitoring(socket);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    hdhrController.stopMonitoring(socket);
    testTunes.detachSocket(socket);
  });
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
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HDHomeRun Signal server running on port ${PORT}`);
});