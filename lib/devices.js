import { execFile } from 'node:child_process';

// Virtual devices that carry system playback back in as an input. If one of
// these is present the user can record the Teams/Zoom desktop apps directly.
const LOOPBACK_HINTS = [
  /blackhole/i, /soundflower/i, /loopback/i, /aggregate/i,
  /multi-output/i, /vb-cable/i, /existential/i, /ishowu/i,
];

/** Devices that exist but never carry other apps' audio — hide them from the picker. */
const NOT_USEFUL = [/zoomaudiodevice/i, /microsoft teams audio/i];

let cache = { at: 0, devices: [] };

/**
 * Enumerate AVFoundation audio inputs. ffmpeg prints them to stderr and then
 * exits non-zero because no real input was given — that's expected, not a failure.
 */
export function listAudioDevices({ maxAgeMs = 4000 } = {}) {
  const now = Date.now();
  if (now - cache.at < maxAgeMs) return Promise.resolve(cache.devices);

  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { timeout: 8000 },
      (_err, _stdout, stderr) => {
        const devices = parseDeviceList(stderr || '');
        cache = { at: Date.now(), devices };
        resolve(devices);
      },
    );
  });
}

export function parseDeviceList(stderr) {
  const devices = [];
  let inAudio = false;
  for (const line of stderr.split('\n')) {
    if (/AVFoundation video devices:/i.test(line)) { inAudio = false; continue; }
    if (/AVFoundation audio devices:/i.test(line)) { inAudio = true; continue; }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (!m) continue;
    const name = m[2].trim();
    if (!name) continue;
    devices.push({
      index: Number(m[1]),
      name,
      loopback: LOOPBACK_HINTS.some((re) => re.test(name)),
      microphone: /microphone|mic\b|built-in|airpods|headset/i.test(name),
      recommended: LOOPBACK_HINTS.some((re) => re.test(name)),
      unusable: NOT_USEFUL.some((re) => re.test(name)),
    });
  }
  return devices;
}

/** True when at least one virtual loopback input exists. */
export async function hasLoopbackDevice() {
  return (await listAudioDevices()).some((d) => d.loopback);
}
