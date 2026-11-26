import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const runtimeFile = path.join(appData, 'EditroomWindows', 'Runtime', 'mcp-port.json');
const portInfo = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
const endpoint = `http://127.0.0.1:${portInfo.port}/mcp`;
const mediaDir = path.join(os.tmpdir(), 'editroom-live-test');

let id = 0;

async function call(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Editroom-Client': 'Codex QA' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`);
  if (!text) return null;
  const json = JSON.parse(text);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

function resultText(result) {
  return result?.content?.map((item) => item.text ?? '').join('\n') ?? '';
}

const fixtures = ['city_walk.mp4', 'camera_clip.mkv', 'beat_track.wav', 'badge.png']
  .map((name) => path.join(mediaDir, name));
console.log('import', resultText(await call('tools/call', {
  name: 'import_media',
  arguments: { paths: fixtures },
})));
const initialProjectText = resultText(await call('tools/call', { name: 'get_project', arguments: {} }));
console.log('project', initialProjectText);
const initialProject = JSON.parse(initialProjectText);
const songAsset = initialProject.assets.find((asset) => asset.kind === 'audio' || asset.name.endsWith('.wav'));
console.log('auto_edit', resultText(await call('tools/call', {
  name: 'auto_edit',
  arguments: {
    title: 'Windows QA Cut',
    duration: 4,
    style: 'beat_cut',
    ...(songAsset ? { song_asset_id: songAsset.id } : {}),
  },
})));
const projectJson = resultText(await call('tools/call', { name: 'get_project', arguments: {} }));
const project = JSON.parse(projectJson);
const videoClip = project.clips.find((clip) => clip.track === 'V1' && (clip.kind === 'video' || clip.asset_kind === 'video'));
if (!videoClip) throw new Error('auto_edit did not create a V1 video clip');
console.log('set_grade', resultText(await call('tools/call', {
  name: 'set_grade',
  arguments: {
    clip_ids: [videoClip.id],
    look: 'Golden hour',
    exposure: 0.15,
    saturation: 18,
  },
})));
console.log('seek', resultText(await call('tools/call', {
  name: 'playback',
  arguments: { action: 'seek', time: 0.8 },
})));
console.log('frame_meta', resultText(await call('tools/call', {
  name: 'get_frame',
  arguments: { time: 0.8 },
})));
console.log('save', resultText(await call('tools/call', {
  name: 'save_project',
  arguments: { title: 'Windows QA Cut' },
})));
