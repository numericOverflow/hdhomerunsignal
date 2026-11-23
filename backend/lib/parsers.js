// Parsers for hdhomerun_config output. Pure functions, so they can be tested without a device.

// "ch=8vsb:575000000 lock=8vsb ss=79 snq=63 seq=100 bps=5221888 pps=0" -> status object.
// "none" -> { channel: 'none', lock: false }.
function parseTunerStatus(statusLine) {
  const line = (statusLine || '').trim();
  if (!line || line === 'none') return { channel: 'none', lock: false };

  const status = {};
  const channel = /ch=([^\s]+)/.exec(line);
  if (channel) status.channel = channel[1];

  ['ss', 'snq', 'seq', 'bps', 'pps'].forEach(key => {
    const match = new RegExp(`\\b${key}=(\\d+)`).exec(line);
    if (match) status[key] = parseInt(match[1], 10);
  });

  // lock=<modulation> (for example 8vsb) means locked. lock=none means no lock.
  // A value in parentheses, for example (8vsb), is a detected but unsupported modulation.
  const lock = /lock=([^\s]+)/.exec(line);
  status.lock = Boolean(lock) && lock[1] !== 'none' && !lock[1].startsWith('(');
  return status;
}

// dB estimates from the "dbg=65-19/-1817" field of /tunerN/debug. These are
// heuristic estimates, not values that the device reports. Returns {} if absent.
function parseDebugDb(debugText) {
  const match = /dbg=(\d+)-(\d+)\/(-?\d+)/.exec(debugText || '');
  if (!match) return {};
  const signalRaw = parseInt(match[1], 10);
  const snrRaw = parseInt(match[2], 10);

  // Signal: map raw 9-86 to roughly -80 to -40 dBm (from observed data)
  let signalDbm;
  if (signalRaw >= 80) signalDbm = -40 - (100 - signalRaw) * 0.5;
  else if (signalRaw >= 60) signalDbm = -50 - (80 - signalRaw) * 0.5;
  else if (signalRaw >= 20) signalDbm = -60 - (60 - signalRaw) * 0.5;
  else signalDbm = -80 - (20 - signalRaw) * 0.5;

  // SNR: raw 0-80 is roughly 0-25 dB
  const snrDb = snrRaw * 0.31;

  return {
    ssDb: Math.round(signalDbm * 10) / 10,
    snrDb: snrRaw > 0 ? Math.round(snrDb * 10) / 10 : 0,
    debugRaw: `${signalRaw}-${snrRaw}/${match[3]}`
  };
}

// /tunerN/program output: a program number, or "none"/"0" when no program filter is set.
function parseProgram(text) {
  const value = (text || '').trim();
  return value && value !== 'none' && value !== '0' ? value : null;
}

// /tunerN/streaminfo output -> programs.
// ATSC 1.0: "program=3: 11.1 KARE-HD" or "program=1: 12.1 WHYY (encrypted)"
// ATSC 3.0: "service=1: 12.1 WHYY (atsc3)"
// No guide data yet: "program=3: 0 (no data)"
function parseStreamInfo(text) {
  const programs = [];
  (text || '').split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
    const match = /(?:(?:program|service)=)?(\d+):\s*([\d.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(line);
    if (!match) return;

    let name = match[3].trim();
    let status = match[4] || '';
    // "0 (no data)" parses with the whole "(no data)" as the name
    const bareStatus = /^\(([^)]+)\)$/.exec(name);
    if (bareStatus) {
      status = bareStatus[1];
      name = '';
    }

    programs.push({
      programNum: match[1],
      virtualChannel: match[2],
      name,
      callsign: name,
      status,
      encrypted: status.includes('encrypted'),
      atsc3: status.includes('atsc3'),
      noData: match[2] === '0' || /no data/i.test(status)
    });
  });
  return programs;
}

// /tunerN/plpinfo output, for example "0: sfi=0 mod=qam256 cod=10/15 layer=core ti=cti lls=1 lock=1"
function parsePlpInfo(text) {
  const plps = {};
  (text || '').split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
    const id = /^(\d+):/.exec(line);
    if (!id) return;
    const plp = {};
    const field = (pattern) => {
      const match = pattern.exec(line);
      return match ? match[1] : undefined;
    };
    const sfi = field(/sfi=(\w+)/);
    const modulation = field(/mod=(\w+)/);
    const coderate = field(/cod=([0-9/]+)/);
    const layer = field(/layer=(\w+)/);
    const timeInterleaving = field(/ti=(\w+)/);
    const lls = field(/lls=(\d+)/);
    const lock = field(/lock=(\d+)/);
    if (sfi !== undefined) plp.sfi = sfi;
    if (modulation !== undefined) plp.modulation = modulation;
    if (coderate !== undefined) plp.coderate = coderate;
    if (layer !== undefined) plp.layer = layer;
    if (timeInterleaving !== undefined) plp.timeInterleaving = timeInterleaving;
    if (lls !== undefined) plp.lls = lls === '1';
    if (lock !== undefined) plp.lock = lock === '1';
    plps[id[1]] = plp;
  });
  return Object.keys(plps).length > 0 ? plps : null;
}

// /tunerN/l1info output: key=value pairs
function parseL1Info(text) {
  const info = {};
  (text || '').split('\n').forEach(line => {
    (line.match(/(\w+)=([^\s]+)/g) || []).forEach(pair => {
      const [key, value] = pair.split('=');
      info[key] = value;
    });
  });
  return Object.keys(info).length > 0 ? info : null;
}

module.exports = {
  parseTunerStatus,
  parseDebugDb,
  parseProgram,
  parseStreamInfo,
  parsePlpInfo,
  parseL1Info
};
