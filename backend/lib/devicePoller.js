const DEFAULT_PERIOD_MS = 1000;
// program, plpinfo and l1info change only on a retune, so they are read this often,
// and right away when the channel changes or after invalidate()
const DEFAULT_SLOW_FIELD_MS = 5000;

// One poller per device. It reads each tuner once per tick, no matter how many
// browsers watch, and only reads what a subscriber shows:
//   single view:  status + debug (dB estimates) for its tuner, plus plpinfo and l1info
//   antenna mode: status for every tuner, plus program (for the active-program pill)
// A tick starts only after the previous tick finished, so calls never pile up.
// A failed read keeps the last good values and marks the tuner stale, with the
// time since the last good read. Subscribers decide how to show that.
//
// reader: {
//   readStatus(tuner, { withDebug }) -> { ok, status } | { ok: false, error }
//   readProgram(tuner)               -> { ok, value }  | { ok: false, error }
//   readPlpInfo(tuner)               -> { ok, value }  | { ok: false, error }
//   readL1Info(tuner)                -> { ok, value }  | { ok: false, error }
// }
class DevicePoller {
  constructor({ deviceId, reader, periodMs = DEFAULT_PERIOD_MS, slowFieldMs = DEFAULT_SLOW_FIELD_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onError = console.error }) {
    this.deviceId = deviceId;
    this.reader = reader;
    this.periodMs = periodMs;
    this.slowFieldMs = slowFieldMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.subscribers = new Map(); // id -> { mode: 'single', tuner, emit } | { mode: 'antenna', tunerCount, emit }
    this.readings = new Map(); // tuner -> reading
    this.timer = null;
    this.running = false;
    this.ticking = false;
  }

  subscribe(id, subscriber) {
    this.subscribers.set(id, subscriber);
    if (!this.running) {
      this.running = true;
      this.schedule(0);
    }
  }

  unsubscribe(id) {
    this.subscribers.delete(id);
    if (this.subscribers.size === 0) this.stop();
  }

  get idle() {
    return this.subscribers.size === 0;
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  // Read program, plpinfo and l1info for the tuner on the next tick, for example after a tune
  invalidate(tuner) {
    const reading = this.readings.get(Number(tuner));
    if (reading) reading.slowDue = true;
  }

  schedule(delayMs) {
    if (!this.running || this.ticking) return;
    this.timer = this.setTimer(() => this.run(), delayMs);
  }

  async run() {
    this.timer = null;
    if (!this.running) return;
    this.ticking = true;
    const startedAt = this.now();
    try {
      await this.tick();
    } catch (error) {
      this.onError(`Device poller ${this.deviceId} tick failed:`, error);
    }
    this.ticking = false;
    this.schedule(Math.max(0, this.periodMs - (this.now() - startedAt)));
  }

  // What each tuner needs this tick, merged over all subscribers
  needs() {
    const needs = new Map();
    const need = (tuner) => {
      if (!needs.has(tuner)) needs.set(tuner, { debug: false, program: false, atsc3: false });
      return needs.get(tuner);
    };
    this.subscribers.forEach(subscriber => {
      if (subscriber.mode === 'single') {
        const n = need(Number(subscriber.tuner));
        n.debug = true;
        n.atsc3 = true;
      } else if (subscriber.mode === 'antenna') {
        for (let tuner = 0; tuner < subscriber.tunerCount; tuner++) need(tuner).program = true;
      }
    });
    return needs;
  }

  reading(tuner) {
    if (!this.readings.has(tuner)) {
      this.readings.set(tuner, {
        status: null,
        currentProgram: null,
        plpInfo: null,
        l1Info: null,
        okAt: null,
        failedSince: null,
        error: null,
        slowAt: 0,
        slowDue: true
      });
    }
    return this.readings.get(tuner);
  }

  async tick() {
    const needs = this.needs();
    await Promise.all(Array.from(needs.entries()).map(([tuner, need]) => this.readTuner(tuner, need)));
    const snapshot = this.snapshot(Array.from(needs.keys()));
    this.subscribers.forEach(subscriber => {
      try {
        subscriber.emit(snapshot);
      } catch (error) {
        this.onError(`Device poller ${this.deviceId} emit failed:`, error);
      }
    });
  }

  async readTuner(tuner, need) {
    const reading = this.reading(tuner);
    const result = await this.reader.readStatus(tuner, { withDebug: need.debug });
    const now = this.now();

    if (!result.ok) {
      if (reading.failedSince === null) reading.failedSince = now;
      reading.error = result.error;
      return;
    }

    const channelChanged = !reading.status || reading.status.channel !== result.status.channel;
    reading.status = result.status;
    reading.okAt = now;
    reading.failedSince = null;
    reading.error = null;

    if (result.status.channel === 'none') {
      reading.currentProgram = null;
      reading.plpInfo = null;
      reading.l1Info = null;
      reading.slowAt = now;
      reading.slowDue = false;
      return;
    }

    if (!channelChanged && !reading.slowDue && now - reading.slowAt < this.slowFieldMs) return;
    reading.slowAt = now;
    reading.slowDue = false;

    // On a failed slow read, keep the previous value unless the channel changed
    const apply = (field, slowResult) => {
      if (slowResult.ok) reading[field] = slowResult.value;
      else if (channelChanged) reading[field] = null;
    };
    const reads = [];
    if (need.program) reads.push(this.reader.readProgram(tuner).then(r => apply('currentProgram', r)));
    if (need.atsc3) {
      reads.push(this.reader.readPlpInfo(tuner).then(r => apply('plpInfo', r)));
      reads.push(this.reader.readL1Info(tuner).then(r => apply('l1Info', r)));
    }
    await Promise.all(reads);
  }

  // tuner -> { status, currentProgram, plpInfo, l1Info, stale, staleForMs, error }
  snapshot(tuners) {
    const now = this.now();
    const snapshot = {};
    tuners.forEach(tuner => {
      const reading = this.reading(tuner);
      const stale = reading.failedSince !== null || reading.okAt === null;
      snapshot[tuner] = {
        status: reading.status,
        currentProgram: reading.currentProgram,
        plpInfo: reading.plpInfo,
        l1Info: reading.l1Info,
        stale,
        staleForMs: stale && reading.okAt !== null ? now - reading.okAt : null,
        error: reading.error
      };
    });
    return snapshot;
  }
}

module.exports = { DevicePoller };
