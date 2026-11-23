import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  Grid,
  Paper,
  IconButton,
  Tooltip as MuiTooltip
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import StationPicker, { tunerStateText } from './StationPicker';
import { getClientId } from '../clientId';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const MAX_DATA_POINTS = 60; // Keep 60 seconds of data

// Convert frequency (in Hz) to broadcast channel number
function frequencyToChannel(freqHz) {
  const freqMhz = freqHz / 1000000;

  // VHF Low (channels 2-6): 54-88 MHz
  if (freqMhz >= 54 && freqMhz <= 88) {
    const vhfLowChannels = [
      { ch: 2, freq: 57 }, { ch: 3, freq: 63 }, { ch: 4, freq: 69 },
      { ch: 5, freq: 79 }, { ch: 6, freq: 85 }
    ];
    let closest = vhfLowChannels[0];
    let minDiff = Math.abs(freqMhz - closest.freq);
    for (const ch of vhfLowChannels) {
      const diff = Math.abs(freqMhz - ch.freq);
      if (diff < minDiff) {
        minDiff = diff;
        closest = ch;
      }
    }
    return closest.ch;
  }

  // VHF High (channels 7-13): 174-216 MHz
  if (freqMhz >= 174 && freqMhz <= 216) {
    const channel = Math.round((freqMhz - 177) / 6) + 7;
    return Math.max(7, Math.min(13, channel));
  }

  // UHF (channels 14-36): 470-608 MHz (post-repack)
  if (freqMhz >= 470 && freqMhz <= 608) {
    const channel = Math.round((freqMhz - 473) / 6) + 14;
    return Math.max(14, Math.min(36, channel));
  }

  return null; // Unknown frequency range
}

// Format channel display - convert frequency format to channel number
function formatChannelDisplay(channelStr) {
  if (!channelStr || channelStr === 'none') {
    return 'Not tuned';
  }

  // Check for frequency format (e.g., "auto6t:605028615")
  const freqMatch = channelStr.match(/:(\d{8,})/);
  if (freqMatch) {
    const freqHz = parseInt(freqMatch[1]);
    const channel = frequencyToChannel(freqHz);
    if (channel) {
      return `Channel ${channel}`;
    }
  }

  // Standard format (e.g., "auto:4" -> "Channel 4")
  const channelMatch = channelStr.match(/(?:auto:)?(\d+)/);
  if (channelMatch) {
    return `Channel ${channelMatch[1]}`;
  }

  return channelStr; // Fallback to raw format
}

const PROGRAM_FETCH_MAX_ATTEMPTS = 3;
const PROGRAM_FETCH_RETRY_MS = 5000;

function AntennaMode({ allTunersData, deviceId }) {
  const [historyData, setHistoryData] = useState({});
  const [programsByTuner, setProgramsByTuner] = useState({});
  const lastChannelRef = useRef({}); // Track last-seen channel per tuner
  // Per tuner: { channel, attempts, inFlight, done, nextAt }
  const programFetchRef = useRef({});

  // Reset program data when the device changes
  useEffect(() => {
    programFetchRef.current = {};
    setProgramsByTuner({});
  }, [deviceId]);

  // Fetch the program list (virtual channel + call sign) once per tuned channel
  useEffect(() => {
    if (!deviceId || !allTunersData || allTunersData.length === 0) return;

    allTunersData.forEach(({ tuner, status }) => {
      const channel = status?.channel;
      const fetchState = programFetchRef.current[tuner];

      if (!channel || channel === 'none') {
        if (fetchState) {
          delete programFetchRef.current[tuner];
          setProgramsByTuner(prev => {
            const next = { ...prev };
            delete next[tuner];
            return next;
          });
        }
        return;
      }

      if (!fetchState || fetchState.channel !== channel) {
        programFetchRef.current[tuner] = { channel, attempts: 0, inFlight: false, done: false, nextAt: 0 };
        setProgramsByTuner(prev => {
          if (!prev[tuner]) return prev;
          const next = { ...prev };
          delete next[tuner];
          return next;
        });
      }

      // Wait for lock before spending fetch attempts
      if (!status.lock) return;

      const state = programFetchRef.current[tuner];
      if (state.done || state.inFlight || state.attempts >= PROGRAM_FETCH_MAX_ATTEMPTS || Date.now() < state.nextAt) {
        return;
      }

      state.inFlight = true;
      state.attempts += 1;
      axios.get(`/api/devices/${deviceId}/tuner/${tuner}/programs`)
        .then(response => response.data)
        .catch(error => {
          console.error(`Failed to get programs for tuner ${tuner}:`, error);
          return [];
        })
        .then(programs => {
          // Ignore the response if the tuner changed channel while the request ran
          if (programFetchRef.current[tuner] !== state) return;
          state.inFlight = false;
          if (Array.isArray(programs) && programs.length > 0) {
            state.done = true;
            setProgramsByTuner(prev => ({ ...prev, [tuner]: programs }));
          } else {
            state.nextAt = Date.now() + PROGRAM_FETCH_RETRY_MS;
          }
        });
    });
  }, [allTunersData, deviceId]);

  // Update history data when new tuner data arrives
  useEffect(() => {
    if (!allTunersData || allTunersData.length === 0) return;

    setHistoryData(prev => {
      const newHistory = { ...prev };

      allTunersData.forEach(({ tuner, status }) => {
        const currentChannel = status?.channel || 'none';
        const lastChannel = lastChannelRef.current[tuner];

        // Reset history if channel changed for this tuner
        if (lastChannel !== undefined && lastChannel !== currentChannel) {
          newHistory[tuner] = {
            signal: [],
            snr: [],
            timestamps: []
          };
        }
        lastChannelRef.current[tuner] = currentChannel;

        if (!newHistory[tuner]) {
          newHistory[tuner] = {
            signal: [],
            snr: [],
            timestamps: []
          };
        }

        const history = newHistory[tuner];
        const now = new Date().toLocaleTimeString();

        // Add new data point
        history.signal.push(status?.ss || 0);
        history.snr.push(status?.snq || 0);
        history.timestamps.push(now);

        // Keep only MAX_DATA_POINTS
        if (history.signal.length > MAX_DATA_POINTS) {
          history.signal.shift();
          history.snr.shift();
          history.timestamps.shift();
        }
      });

      return newHistory;
    });
  }, [allTunersData]);

  const getSymbolColor = (symbolQuality) => {
    if (symbolQuality === 100) return 'success';
    if (symbolQuality > 0) return 'error';
    return 'default';
  };

  const getSymbolLabel = (symbolQuality) => {
    if (symbolQuality === 100) return '100% ✓';
    if (symbolQuality > 0) return `${symbolQuality}%`;
    return 'No Signal';
  };

  // Free a tuner this browser tuned for testing
  const stopTestTune = (tuner) => {
    axios.post(`/api/devices/${deviceId}/tuner/${tuner}/clear`, { clientId: getClientId() })
      .catch(error => console.error(`Failed to stop test tune on tuner ${tuner}:`, error));
  };

  const formatProgram = (program) => `${program.virtualChannel} ${program.callsign}`;

  // Compact line: one program chip plus "+N more" with the full list in a tooltip.
  // The active program (the one a client is watching) is shown first as a filled chip.
  const renderPrograms = (programs, currentProgram) => {
    if (!programs || programs.length === 0) return null;

    const isActive = (program) => currentProgram != null && String(program.programNum) === String(currentProgram);
    const active = programs.find(isActive);
    const primary = active || programs[0];
    const others = programs.length - 1;

    return (
      <>
        <Chip
          label={formatProgram(primary)}
          size="small"
          color="primary"
          variant={active ? 'filled' : 'outlined'}
          title={active ? 'Program a client is watching on this tuner' : undefined}
          sx={{ height: 20, fontSize: '0.7rem' }}
        />
        {others > 0 && (
          <MuiTooltip
            enterTouchDelay={0}
            leaveTouchDelay={4000}
            title={
              <Box>
                {programs.map(program => (
                  <Typography
                    key={program.programNum}
                    variant="caption"
                    component="div"
                    sx={{ fontWeight: isActive(program) ? 700 : 400 }}
                  >
                    {formatProgram(program)}{isActive(program) ? ' (watching)' : ''}
                  </Typography>
                ))}
              </Box>
            }
          >
            <Typography variant="caption" sx={{ fontSize: '0.7rem', color: 'text.secondary', cursor: 'pointer', textDecoration: 'underline dotted' }}>
              +{others} more
            </Typography>
          </MuiTooltip>
        )}
      </>
    );
  };

  const createChartData = (tuner, type) => {
    const history = historyData[tuner];
    if (!history) return null;

    const data = type === 'signal' ? history.signal : history.snr;
    const color = type === 'signal' ? 'rgba(76, 175, 80, 1)' : 'rgba(255, 152, 0, 1)';
    const fillColor = type === 'signal' ? 'rgba(76, 175, 80, 0.1)' : 'rgba(255, 152, 0, 0.1)';

    return {
      labels: history.timestamps,
      datasets: [
        {
          label: type === 'signal' ? 'Signal' : 'SNR',
          data: data,
          borderColor: color,
          backgroundColor: fillColor,
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0
        }
      ]
    };
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: {
        min: 0,
        max: 100,
        ticks: {
          color: 'rgba(255, 255, 255, 0.7)',
          font: { size: 10 }
        },
        grid: {
          color: 'rgba(255, 255, 255, 0.1)'
        }
      },
      x: {
        display: false
      }
    },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        enabled: false
      }
    }
  };

  if (!allTunersData || allTunersData.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body1" color="text.secondary">
          Starting antenna tuning mode...
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2, fontSize: '1rem', textAlign: 'center' }}>
        Antenna Tuning Mode - All Tuners
      </Typography>

      <Grid container spacing={2}>
        {allTunersData.map(({ tuner, status, currentProgram, tunerState }) => (
          <Grid item xs={12} md={6} key={tuner}>
            <Card>
              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                  <Typography variant="body1" sx={{ fontWeight: 600, fontSize: '0.95rem' }}>
                    Tuner {tuner}
                  </Typography>
                  <Chip
                    label={getSymbolLabel(status?.seq || 0)}
                    color={getSymbolColor(status?.seq || 0)}
                    size="small"
                    sx={{ fontWeight: 600 }}
                  />
                </Box>

                {status?.channel && status.channel !== 'none' && (
                  <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                    <Typography variant="body2" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                      {formatChannelDisplay(status.channel)}
                    </Typography>
                    {renderPrograms(programsByTuner[tuner], currentProgram)}
                  </Box>
                )}

                {tunerState && (
                  <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: tunerState.state === 'in-use' ? 'warning.main' : 'text.secondary' }}>
                    {tunerStateText(tunerState)}
                  </Typography>
                )}

                {/* Test tune: only on a tuner this browser may change */}
                {tunerState && tunerState.state !== 'in-use' && (
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, mb: 1 }}>
                    <Box sx={{ flex: 1 }}>
                      <StationPicker deviceId={deviceId} tuner={tuner} tunerState={tunerState} source="antenna" />
                    </Box>
                    {tunerState.state === 'controlled' && (
                      <IconButton size="small" onClick={() => stopTestTune(tuner)} aria-label="Stop test tune">
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Box>
                )}

                <Grid container spacing={1}>
                  <Grid item xs={6}>
                    <Typography variant="caption" sx={{ fontSize: '0.7rem', fontWeight: 500 }}>
                      Signal: {status?.ss || 0}%
                    </Typography>
                    <Box sx={{ height: 80, mt: 0.5 }}>
                      {historyData[tuner] && (
                        <Line data={createChartData(tuner, 'signal')} options={chartOptions} />
                      )}
                    </Box>
                  </Grid>

                  <Grid item xs={6}>
                    <Typography variant="caption" sx={{ fontSize: '0.7rem', fontWeight: 500 }}>
                      SNR: {status?.snq || 0}%
                    </Typography>
                    <Box sx={{ height: 80, mt: 0.5 }}>
                      {historyData[tuner] && (
                        <Line data={createChartData(tuner, 'snr')} options={chartOptions} />
                      )}
                    </Box>
                  </Grid>
                </Grid>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default AntennaMode;
