const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTunerStatus,
  parseDebugDb,
  parseProgram,
  parseStreamInfo,
  parsePlpInfo,
  parseL1Info
} = require('../lib/parsers');

test('parseTunerStatus reads a locked tuner', () => {
  assert.deepEqual(parseTunerStatus('ch=8vsb:575000000 lock=8vsb ss=79 snq=63 seq=100 bps=5221888 pps=0'), {
    channel: '8vsb:575000000', lock: true, ss: 79, snq: 63, seq: 100, bps: 5221888, pps: 0
  });
});

test('parseTunerStatus treats lock=none and (modulation) as not locked', () => {
  assert.equal(parseTunerStatus('ch=auto:31 lock=none ss=45 snq=0 seq=0 bps=0 pps=0').lock, false);
  assert.equal(parseTunerStatus('ch=auto:31 lock=(8vsb) ss=45 snq=0 seq=0 bps=0 pps=0').lock, false);
});

test('parseTunerStatus reads an idle tuner', () => {
  assert.deepEqual(parseTunerStatus('none'), { channel: 'none', lock: false });
  assert.equal(parseTunerStatus('ch=none lock=none ss=0 snq=0 seq=0 bps=0 pps=0').channel, 'none');
});

test('parseDebugDb estimates dB from the dbg field', () => {
  assert.deepEqual(parseDebugDb('tun: ch=8vsb:575000000 lock=8vsb ss=79 snq=63 seq=100 dbg=65-19/-1817'), {
    ssDb: -57.5, snrDb: 5.9, debugRaw: '65-19/-1817'
  });
  assert.deepEqual(parseDebugDb('no dbg here'), {});
});

test('parseProgram returns null when no program filter is set', () => {
  assert.equal(parseProgram('3\n'), '3');
  assert.equal(parseProgram('none'), null);
  assert.equal(parseProgram('0'), null);
  assert.equal(parseProgram(''), null);
});

test('parseStreamInfo reads ATSC 1.0 and ATSC 3.0 programs', () => {
  const programs = parseStreamInfo([
    'tsid=0x0001',
    'program=3: 11.1 KARE-HD',
    'program=4: 11.2 Quest (encrypted)',
    'service=1: 111.1 KARE (atsc3)'
  ].join('\n'));
  assert.equal(programs.length, 3);
  assert.deepEqual(programs.map(p => [p.programNum, p.virtualChannel, p.name, p.encrypted, p.atsc3, p.noData]), [
    ['3', '11.1', 'KARE-HD', false, false, false],
    ['4', '11.2', 'Quest', true, false, false],
    ['1', '111.1', 'KARE', false, true, false]
  ]);
});

test('parseStreamInfo marks programs without guide data', () => {
  const [program] = parseStreamInfo('program=3: 0 (no data)');
  assert.equal(program.programNum, '3');
  assert.equal(program.virtualChannel, '0');
  assert.equal(program.name, '');
  assert.equal(program.status, 'no data');
  assert.equal(program.noData, true);
});

test('parsePlpInfo and parseL1Info read key=value output', () => {
  assert.deepEqual(parsePlpInfo('0: sfi=0 mod=qam256 cod=10/15 layer=core ti=cti lls=1 lock=1'), {
    0: { sfi: '0', modulation: 'qam256', coderate: '10/15', layer: 'core', timeInterleaving: 'cti', lls: true, lock: true }
  });
  assert.equal(parsePlpInfo(''), null);
  assert.deepEqual(parseL1Info('l1_basic_mode=1 fft_size=8192'), { l1_basic_mode: '1', fft_size: '8192' });
  assert.equal(parseL1Info(''), null);
});
