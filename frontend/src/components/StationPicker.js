import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Autocomplete, Box, IconButton, TextField, Typography } from '@mui/material';
import { KeyboardArrowLeft, KeyboardArrowRight } from '@mui/icons-material';
import { getClientId } from '../clientId';

const RECENT_KEY = 'hdhr-recent-stations';
const MAX_RECENT = 5;
const GROUP_RECENT = 'Recent';
const GROUP_ALL = 'All stations';

// One lineup request per device, shared by every picker on the page
const lineupRequests = new Map();

function loadLineup(deviceId) {
  if (!lineupRequests.has(deviceId)) {
    const request = axios.get(`/api/devices/${deviceId}/lineup`)
      .then(response => response.data)
      .catch(error => {
        lineupRequests.delete(deviceId); // Allow a retry later
        throw error;
      });
    lineupRequests.set(deviceId, request);
  }
  return lineupRequests.get(deviceId);
}

function readRecent(deviceId) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
    return Array.isArray(all[deviceId]) ? all[deviceId] : [];
  } catch (error) {
    return [];
  }
}

function saveRecent(deviceId, vchannel) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}');
    const list = (Array.isArray(all[deviceId]) ? all[deviceId] : []).filter(v => v !== vchannel);
    all[deviceId] = [vchannel, ...list].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
    return all[deviceId];
  } catch (error) {
    return readRecent(deviceId);
  }
}

const majorOf = (vchannel) => (vchannel || '').split('.')[0];

const stationLabel = (station) =>
  `${station.vchannel} ${station.name}${station.atsc3 ? ' (3.0)' : ''}`;

// "free", "testing, auto-release in 12 min", or "In use by 192.168.1.210"
export function tunerStateText(tunerState) {
  if (!tunerState) return '';
  if (tunerState.state === 'in-use') return `In use by ${tunerState.owner}`;
  if (tunerState.state === 'controlled') {
    if (tunerState.releaseInMs === null || tunerState.releaseInMs === undefined) return 'testing';
    const minutes = Math.max(1, Math.ceil(tunerState.releaseInMs / 60000));
    return `testing, auto-release in ${minutes} min`;
  }
  return 'free';
}

// Pick a station by virtual channel or name, and step by major channel.
// Tunes as soon as a station is picked.
function StationPicker({ deviceId, tuner, tunerState, source, onTuned }) {
  const [stations, setStations] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [recent, setRecent] = useState(() => readRecent(deviceId));
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setStations(null);
    setLoadError('');
    setRecent(readRecent(deviceId));
    if (!deviceId) return undefined;
    loadLineup(deviceId)
      .then(data => { if (active) setStations(data); })
      .catch(err => {
        if (active) setLoadError(err.response?.data?.error || 'Could not load the station list');
      });
    return () => { active = false; };
  }, [deviceId]);

  const controlled = tunerState?.state === 'controlled';
  const inUse = tunerState?.state === 'in-use';
  const currentVchannel = pending || (controlled ? tunerState.vchannel : null);

  // Clear the pending pick once the status loop reports it
  useEffect(() => {
    if (pending && controlled && tunerState.vchannel === pending) setPending(null);
  }, [pending, controlled, tunerState?.vchannel]);

  const options = useMemo(() => {
    if (!stations) return [];
    const byVchannel = new Map(stations.map(s => [s.vchannel, s]));
    const recentOptions = recent
      .filter(v => byVchannel.has(v))
      .map(v => ({ ...byVchannel.get(v), group: GROUP_RECENT }));
    return [...recentOptions, ...stations.map(s => ({ ...s, group: GROUP_ALL }))];
  }, [stations, recent]);

  const value = useMemo(() => {
    if (!currentVchannel || !stations) return null;
    return options.find(o => o.group === GROUP_ALL && o.vchannel === currentVchannel) || null;
  }, [currentVchannel, options, stations]);

  const tune = async (vchannel) => {
    if (!vchannel || inUse) return;
    setError('');
    setPending(vchannel);
    try {
      await axios.post(`/api/devices/${deviceId}/tuner/${tuner}/vchannel`, {
        vchannel,
        clientId: getClientId(),
        source
      });
      setRecent(saveRecent(deviceId, vchannel));
      if (onTuned) onTuned(vchannel);
    } catch (err) {
      setPending(null);
      setError(err.response?.data?.error || 'Tune failed');
    }
  };

  // Step to the lowest subchannel of the previous or next major channel, wrapping around
  const step = (direction) => {
    if (!stations || stations.length === 0) return;
    const majors = [];
    stations.forEach(s => {
      const major = majorOf(s.vchannel);
      if (majors[majors.length - 1] !== major) majors.push(major);
    });
    const index = majors.indexOf(majorOf(currentVchannel));
    let nextIndex;
    if (index === -1) nextIndex = direction > 0 ? 0 : majors.length - 1;
    else nextIndex = (index + direction + majors.length) % majors.length;
    const target = stations.find(s => majorOf(s.vchannel) === majors[nextIndex]);
    if (target) tune(target.vchannel);
  };

  const disabled = !deviceId || inUse || !stations;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Autocomplete
          size="small"
          sx={{ flex: 1, minWidth: 180 }}
          options={options}
          groupBy={(option) => option.group}
          getOptionLabel={stationLabel}
          isOptionEqualToValue={(option, selected) => option.vchannel === selected.vchannel}
          renderOption={(props, option) => (
            <li {...props} key={`${option.group}-${option.vchannel}`}>
              {stationLabel(option)}
            </li>
          )}
          value={value}
          onChange={(event, selected) => { if (selected) tune(selected.vchannel); }}
          disabled={disabled}
          loading={!stations && !loadError}
          autoHighlight
          blurOnSelect
          openOnFocus
          disableClearable
          noOptionsText="No matching station"
          renderInput={(params) => (
            <TextField {...params} label="Station" placeholder="Type number or name" />
          )}
        />
        <IconButton size="small" onClick={() => step(-1)} disabled={disabled} aria-label="Previous station">
          <KeyboardArrowLeft />
        </IconButton>
        <IconButton size="small" onClick={() => step(1)} disabled={disabled} aria-label="Next station">
          <KeyboardArrowRight />
        </IconButton>
      </Box>
      {(error || loadError) && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error || loadError}
        </Typography>
      )}
    </Box>
  );
}

export default StationPicker;
