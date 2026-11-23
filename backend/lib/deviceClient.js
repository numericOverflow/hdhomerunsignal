const { execFile } = require('child_process');

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 3000;

function firstLine(text) {
  return (text || '').trim().split('\n')[0].trim();
}

// Runs hdhomerun_config without a shell, so arguments cannot inject shell commands.
// Resolves { ok: true, stdout } or { ok: false, error, timedOut }.
function execFileRunner(args, timeoutMs) {
  return new Promise(resolve => {
    execFile('hdhomerun_config', args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const out = (stdout || '').trim();
      if (error) {
        resolve({
          ok: false,
          error: firstLine(stderr) || firstLine(out) || error.message,
          timedOut: error.killed === true || error.signal === 'SIGTERM'
        });
        return;
      }
      // hdhomerun_config can print "ERROR: ..." (for example "ERROR: resource locked") with exit code 0
      if (/^ERROR\b/i.test(out)) {
        resolve({ ok: false, error: firstLine(out), timedOut: false });
        return;
      }
      resolve({ ok: true, stdout: out });
    });
  });
}

function emptyStats(now) {
  return { since: now, calls: 0, failures: 0, timeouts: 0, totalMs: 0, maxMs: 0, maxQueued: 0, lastError: '' };
}

// All hdhomerun_config calls for one device. Limits concurrent calls, because a burst
// of parallel control connections makes the device answer slowly or not at all.
// set calls go before queued get calls, so a tune is not stuck behind status polling.
class DeviceClient {
  constructor(deviceId, { runner = execFileRunner, concurrency = DEFAULT_CONCURRENCY, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
    this.deviceId = deviceId;
    this.runner = runner;
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.active = 0;
    this.queue = { high: [], normal: [] };
    this.stats = emptyStats(now());
  }

  get(path, options) {
    return this.run(['get', path], options);
  }

  set(path, value, options = {}) {
    return this.run(['set', path, String(value)], { priority: true, ...options });
  }

  // Resolves { ok, stdout } or { ok: false, error, timedOut }. Never rejects.
  run(args, { priority = false, timeoutMs = this.timeoutMs } = {}) {
    return new Promise(resolve => {
      (priority ? this.queue.high : this.queue.normal).push({ args: [this.deviceId, ...args], timeoutMs, resolve });
      const queued = this.queue.high.length + this.queue.normal.length;
      if (queued > this.stats.maxQueued) this.stats.maxQueued = queued;
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency) {
      const job = this.queue.high.shift() || this.queue.normal.shift();
      if (!job) return;
      this.active += 1;
      const startedAt = this.now();
      Promise.resolve()
        .then(() => this.runner(job.args, job.timeoutMs))
        .catch(error => ({ ok: false, error: error.message, timedOut: false }))
        .then(result => {
          this.record(result, this.now() - startedAt, job.args);
          this.active -= 1;
          job.resolve(result);
          this.pump();
        });
    }
  }

  record(result, ms, args) {
    const stats = this.stats;
    stats.calls += 1;
    stats.totalMs += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    if (!result.ok) {
      stats.failures += 1;
      if (result.timedOut) stats.timeouts += 1;
      stats.lastError = `${args.slice(1).join(' ')}: ${result.error}`;
    }
  }

  // Returns the stats since the last call and starts a new period
  takeStats() {
    const stats = { ...this.stats, until: this.now(), queuedNow: this.queue.high.length + this.queue.normal.length, activeNow: this.active };
    this.stats = emptyStats(stats.until);
    return stats;
  }
}

module.exports = { DeviceClient, execFileRunner };
