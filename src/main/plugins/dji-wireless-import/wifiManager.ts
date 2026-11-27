import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DjiEnvironmentStatus } from '../../../shared/djiTypes';

const execFileAsync = promisify(execFile);

async function runQuiet(cmd: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const res = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { ok: true, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

export async function getWindowsWifiProfile(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const wlan = await runQuiet('netsh', ['wlan', 'show', 'interfaces'], 3000);
  const match = wlan.stdout.match(/^\s*(?:Profile|配置文件)\s*:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

export async function detectPythonAndBleak(): Promise<{ pythonPath: string | null; pythonAvailable: boolean; bleakAvailable: boolean }> {
  const candidates: Array<[string, string[]]> = [
    ['python', ['-c', 'import sys, importlib.util; print(sys.executable); print("1" if importlib.util.find_spec("bleak") else "0")']],
    ['py', ['-3', '-c', 'import sys, importlib.util; print(sys.executable); print("1" if importlib.util.find_spec("bleak") else "0")']],
  ];
  for (const [bin, args] of candidates) {
    const res = await runQuiet(bin, args, 3500);
    if (res.ok) {
      const lines = res.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length >= 2) {
        return {
          pythonPath: lines[0],
          pythonAvailable: true,
          bleakAvailable: lines[1] === '1',
        };
      }
    }
  }
  return { pythonPath: null, pythonAvailable: false, bleakAvailable: false };
}

export async function probeWindowsNetworkAndRadios(): Promise<DjiEnvironmentStatus> {
  const notes: string[] = [];
  const pyPromise = detectPythonAndBleak();

  let wifiReady = false;
  let wifiConnectedProfile: string | null = null;
  let bluetoothReady = false;
  let ethernetActive = false;

  if (process.platform === 'win32') {
    const [py, wlan, ipRes, btRes] = await Promise.all([
      pyPromise,
      runQuiet('netsh', ['wlan', 'show', 'interfaces'], 3500),
      runQuiet('ipconfig', [], 3000),
      runQuiet(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq "OK"} | Select-Object -First 1 -ExpandProperty FriendlyName',
        ],
        4000
      ),
    ]);
    return buildEnvironmentStatus(py, wlan, ipRes, btRes, notes);
  } else {
    const py = await pyPromise;
    notes.push('DJI wireless hardware transport targets Windows 10/11; simulated camera mode remains available.');
    return finalizeEnvironmentStatus(py, bluetoothReady, wifiReady, wifiConnectedProfile, ethernetActive, notes);
  }
}

function buildEnvironmentStatus(
  py: { pythonPath: string | null; pythonAvailable: boolean; bleakAvailable: boolean },
  wlan: { ok: boolean; stdout: string; stderr: string },
  ipRes: { ok: boolean; stdout: string; stderr: string },
  btRes: { ok: boolean; stdout: string; stderr: string },
  notes: string[]
): DjiEnvironmentStatus {
  let wifiReady = false;
  let wifiConnectedProfile: string | null = null;
  let bluetoothReady = false;
  let ethernetActive = false;
    const wlanText = `${wlan.stdout}\n${wlan.stderr}`;
    if (/location/i.test(wlanText) && (/permission/i.test(wlanText) || /services/i.test(wlanText))) {
      wifiReady = true;
      notes.push('Windows Location Services is disabled; netsh status readback is restricted, falling back to DHCP IP check.');
    } else if (wlan.ok && /Name|名称|State|状态/i.test(wlan.stdout)) {
      wifiReady = true;
      const profileMatch = wlan.stdout.match(/^\s*(?:Profile|配置文件)\s*:\s*(.+)$/im);
      if (profileMatch) wifiConnectedProfile = profileMatch[1].trim();
    }

    if (/Ethernet|以太网/i.test(ipRes.stdout) && /IPv4[^:]*:\s*(?!169\.254\.)\d+\.\d+\.\d+\.\d+/i.test(ipRes.stdout)) {
      ethernetActive = true;
    }

    bluetoothReady = btRes.ok && btRes.stdout.trim().length > 0;

    if (wifiReady && !ethernetActive) {
      notes.push(
        'Single Wi-Fi adapter detected without wired Ethernet: connecting to the camera AP temporarily pauses PC internet until disconnected.'
      );
    } else if (ethernetActive) {
      notes.push('Wired Ethernet is active alongside Wi-Fi: PC internet stays online while transferring from camera AP.');
    }
  return finalizeEnvironmentStatus(py, bluetoothReady, wifiReady, wifiConnectedProfile, ethernetActive, notes);
}

function finalizeEnvironmentStatus(
  py: { pythonPath: string | null; pythonAvailable: boolean; bleakAvailable: boolean },
  bluetoothReady: boolean,
  wifiReady: boolean,
  wifiConnectedProfile: string | null,
  ethernetActive: boolean,
  notes: string[]
): DjiEnvironmentStatus {
  if (!py.pythonAvailable) {
    notes.push('Python 3.10+ was not found on PATH for the BLE/Datalink sidecar.');
  } else if (!py.bleakAvailable) {
    notes.push('Python package "bleak" is not installed yet (pip install bleak) for live BLE camera discovery.');
  }

  return {
    platform: process.platform,
    pythonPath: py.pythonPath,
    pythonAvailable: py.pythonAvailable,
    bleakAvailable: py.bleakAvailable,
    bluetoothReady,
    wifiReady,
    wifiConnectedProfile,
    ethernetActive,
    notes,
  };
}
