import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG_BIN, FFPROBE_BIN } from '../src/main/engine/ffmpeg';
import { ProjectStore } from '../src/main/state';
import { MCPServer } from '../src/main/mcp/server';
import { MCP_TOOL_DEFINITIONS } from '../src/main/mcp/tools';
import { ensurePlayableProxy } from '../src/main/engine/ffmpeg';
import { runMagicPrompt } from '../src/main/magic/agentConnect';

const execFileAsync = promisify(execFile);

describe('MCP Server + Real FFmpeg Pipeline', () => {
  let tmpDir: string;
  let sampleVideo: string;
  let sampleAudio: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectrail-test-'));
    process.env.VECTRAIL_CACHE_DIR = path.join(tmpDir, 'cache');
    sampleVideo = path.join(tmpDir, 'sample.mp4');
    sampleAudio = path.join(tmpDir, 'music.wav');

    await execFileAsync(FFMPEG_BIN, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      sampleVideo,
    ], { windowsHide: true });

    await execFileAsync(FFMPEG_BIN, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=110:sample_rate=48000:duration=4',
      '-af', 'tremolo=f=2:d=0.8',
      sampleAudio,
    ], { windowsHide: true });
  }, 30000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('runs full MCP lifecycle: import, analyze, look_at_media, edit, get_frame, auto_edit, and export MP4', async () => {
    const store = new ProjectStore();
    const mcp = new MCPServer(store);

    const init = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } });
    expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe('vectrail');

    const listTools = await mcp.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (listTools?.result as { tools: unknown[] }).tools;
    expect(tools.length).toBe(MCP_TOOL_DEFINITIONS.length);
    expect(tools.length).toBeGreaterThanOrEqual(40);

    const imp = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'import_media', arguments: { paths: [sampleVideo, sampleAudio] } },
    });
    const impText = ((imp?.result as { content: Array<{ text: string }> }).content[0]).text;
    const impData = JSON.parse(impText) as { imported: Array<{ id: string; kind: string }> };
    expect(impData.imported.length).toBe(2);

    const vidId = impData.imported.find((a) => a.kind === 'video')!.id;
    const audId = impData.imported.find((a) => a.kind === 'audio')!.id;

    const anaV = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'analyze_media', arguments: { asset_id: vidId } },
    });
    expect((anaV?.result as { isError: boolean }).isError).toBe(false);

    const anaA = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'analyze_media', arguments: { asset_id: audId } },
    });
    const anaAText = ((anaA?.result as { content: Array<{ text: string }> }).content[0]).text;
    expect(JSON.parse(anaAText).bpm).toBeGreaterThan(50);

    const lookRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'look_at_media', arguments: { asset_id: vidId, frames: 3 } },
    });
    const lookContent = (lookRes?.result as { content: Array<{ type: string; data?: string }> }).content;
    expect(lookContent[0].type).toBe('image');
    expect(lookContent[0].data!.length).toBeGreaterThan(100);

    await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'add_clip', arguments: { asset_id: vidId, start: 0, duration: 2 } },
    });
    expect(store.project.clips.length).toBe(2);

    const frameRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'get_frame', arguments: { time: 0.5 } },
    });
    expect(((frameRes?.result as { content: Array<{ type: string }> }).content[0]).type).toBe('image');

    const autoRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'auto_edit', arguments: {} },
    });
    expect((autoRes?.result as { isError: boolean }).isError).toBe(false);
    expect(store.project.clips.length).toBeGreaterThanOrEqual(3);

    const savePath = path.join(tmpDir, 'test.vectrail');
    store.saveToFile(savePath);
    expect(fs.existsSync(savePath)).toBe(true);

    const expRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'export',
        arguments: { name: 'final-cut', height: 360, quality: 'web', loudness: -14, wait: true },
      },
    });
    const expText = ((expRes?.result as { content: Array<{ text: string }> }).content[0]).text;
    const expInfo = JSON.parse(expText) as { status: string; file: string; error?: string };
    expect(expInfo.error).toBeUndefined();
    expect(expInfo.status).toBe('done');
    expect(fs.existsSync(expInfo.file)).toBe(true);

    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', expInfo.file,
    ], { windowsHide: true });
    const probed = JSON.parse(stdout) as { format: { duration: string } };
    expect(Number.parseFloat(probed.format.duration)).toBeGreaterThan(0.5);

    // Verify grade + speed ramp + caption burn-in + audio-only export
    const videoClips = store.project.clips.filter((c) => c.kind === 'video');
    if (videoClips[0]) {
      await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'set_grade',
          arguments: { clip_ids: [videoClips[0].id], look: 'Film print', exposure: 0.15, saturation: 10 },
        },
      });
      await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'set_speed',
          arguments: { clip_id: videoClips[0].id, speed: 1.5 },
        },
      });
    }
    store.transcripts[vidId] = {
      duration: 3,
      words: [
        { text: 'Hello', start: 0.1, end: 0.5 },
        { text: 'Vectrail', start: 0.55, end: 1.0 },
      ],
    };
    await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'set_captions', arguments: { style: 'bold', position: 0.8 } },
    });
    const gradedRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'export',
        arguments: { name: 'graded-captioned', height: 480, quality: 'web', enhance_detail: true, wait: true },
      },
    });
    const gradedInfo = JSON.parse(((gradedRes?.result as { content: Array<{ text: string }> }).content[0]).text) as {
      status: string;
      file: string;
      error?: string;
    };
    expect(gradedInfo.error).toBeUndefined();
    expect(gradedInfo.status).toBe('done');
    expect(fs.existsSync(gradedInfo.file)).toBe(true);

    const wavRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'export',
        arguments: { name: 'audio-mix', format: 'audio', wait: true },
      },
    });
    const wavInfo = JSON.parse(((wavRes?.result as { content: Array<{ text: string }> }).content[0]).text) as {
      status: string;
      file: string;
      error?: string;
    };
    expect(wavInfo.error).toBeUndefined();
    expect(wavInfo.status).toBe('done');
    expect(wavInfo.file.endsWith('.wav')).toBe(true);
    expect(fs.existsSync(wavInfo.file)).toBe(true);

    // Verify replaceProject removes deleted optional fields
    const cleared = JSON.parse(JSON.stringify(store.project)) as typeof store.project;
    delete cleared.captions;
    store.replaceProject(cleared, true);
    expect(store.project.captions).toBeUndefined();

    // Verify MKV proxy remuxing, transitions, audio ducking, and Magic @mentions
    const mkvPath = path.join(tmpDir, 'camera.mkv');
    await execFileAsync(FFMPEG_BIN, [
      '-y', '-i', sampleVideo, '-c', 'copy', mkvPath,
    ], { windowsHide: true });
    const importedMkv = await store.importFiles([mkvPath]);
    const proxy = await ensurePlayableProxy(importedMkv[0]);
    expect(proxy).toBeDefined();
    expect(fs.existsSync(proxy!)).toBe(true);

    const magicRes = await runMagicPrompt(
      'Apply warm film grade and dissolve transitions and title "Final" at @playhead',
      'local',
      store,
      []
    );
    expect(magicRes.ok).toBe(true);
    expect(magicRes.summary).toContain('Warm film');
    expect(magicRes.backend).toBe('local');
    expect(magicRes.processSteps?.length).toBeGreaterThanOrEqual(3);
    expect(magicRes.processSteps?.every((s) => s.status === 'done')).toBe(true);

    const textClip = store.project.clips.find((c) => c.kind === 'text');
    expect(textClip).toBeDefined();
    if (textClip?.text) {
      textClip.text.strokeWidth = 6;
      textClip.text.strokeColor = { r: 0, g: 0, b: 0, a: 1 };
      textClip.text.bgColor = { r: 0.1, g: 0.1, b: 0.12, a: 0.8 };
      textClip.text.bgPadding = 18;
      const styledFrame = await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 19,
        method: 'tools/call',
        params: { name: 'get_frame', arguments: { time: textClip.start + 0.1 } },
      });
      const styledContent = (styledFrame?.result as { content: Array<{ type: string; data?: string }> }).content;
      expect(styledContent[0].type).toBe('image');
      expect(styledContent[0].data!.length).toBeGreaterThan(5000);
    }

    const progressSteps: string[] = [];
    const zoomMagicRes = await runMagicPrompt('zoom in', 'local', store, [], {
      runId: 'test-zoom',
      onProgress: (ev) => {
        if (ev.step) progressSteps.push(ev.step.id);
      },
    });
    expect(zoomMagicRes.ok).toBe(true);
    expect(zoomMagicRes.summary).toContain('zoom in');
    expect(progressSteps).toContain('scan-media');
    expect(progressSteps).toContain('local-plan');

    const externalEvents: string[] = [];
    mcp.setExternalToolListener((ev) => externalEvents.push(`${ev.clientName}:${ev.toolName}:${ev.status}`));
    await mcp.handleRpc(
      {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'list_looks', arguments: {} },
      },
      'TestAgent'
    );
    mcp.setExternalToolListener(undefined);
    expect(externalEvents).toContain('TestAgent:list_looks:done');

    if (videoClips[0]) {
      const tfRes = await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: { name: 'set_transform', arguments: { clip_id: videoClips[0].id, scale: 0.4, x: 0.32, y: -0.35 } },
      });
      expect((tfRes?.result as { isError: boolean }).isError).toBe(false);

      const compFrame = await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: { name: 'get_frame', arguments: { time: videoClips[0].start + 0.2 } },
      });
      const compContent = (compFrame?.result as { content: Array<{ type: string; text?: string; data?: string }> }).content;
      expect(compContent[0].type).toBe('image');
      expect(compContent[0].data!.length).toBeGreaterThan(8000);
      expect(compContent[1].text).toContain('Composited frame');
    }

    const mcpSavePath = path.join(tmpDir, 'mcp-saved.vectrail');
    const saveRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'save_project', arguments: { path: mcpSavePath, title: 'MCP Saved' } },
    });
    expect((saveRes?.result as { isError: boolean }).isError).toBe(false);
    expect(fs.existsSync(mcpSavePath)).toBe(true);

    const duckRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'set_track', arguments: { track: 'A1', duck_under: 'A1', duck_db: -12 } },
    });
    expect((duckRes?.result as { isError: boolean }).isError).toBe(false);
    expect(store.project.audioTracks[0].duckDB).toBe(-12);

    // Verify wipe transition + speed ramp + vertical reframe crop in real FFmpeg export
    const vList = store.project.clips.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start);
    if (vList.length >= 2) {
      await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'set_transition', arguments: { clip_id: vList[1].id, kind: 'wipe', duration: 0.35 } },
      });
    }
    if (vList[0]) {
      await mcp.handleRpc({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'set_speed_ramp', arguments: { clip_id: vList[0].id, speed: 2.0 } },
      });
    }
    const vertRes = await mcp.handleRpc({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'export',
        arguments: {
          name: 'vertical-reframe-wipe',
          shape: 'vertical',
          height: 360,
          reframe_x: 0.7,
          reframe_y: 0.5,
          quality: 'web',
          wait: true,
        },
      },
    });
    const vertInfo = JSON.parse(((vertRes?.result as { content: Array<{ text: string }> }).content[0]).text) as {
      status: string;
      file: string;
      error?: string;
    };
    expect(vertInfo.error).toBeUndefined();
    expect(vertInfo.status).toBe('done');
    expect(fs.existsSync(vertInfo.file)).toBe(true);
    const { stdout: vProbe } = await execFileAsync(
      FFPROBE_BIN,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', vertInfo.file],
      { windowsHide: true }
    );
    const vStreams = (JSON.parse(vProbe) as { streams: Array<{ codec_type: string; width?: number; height?: number }> }).streams;
    const vStream = vStreams.find((s) => s.codec_type === 'video');
    expect(vStream?.width).toBe(360);
    expect(vStream?.height).toBe(640);

    await store.waitForIdle();
  }, 60000);
});
