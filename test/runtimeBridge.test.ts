import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import vm from 'vm';
import {
  startBridge,
  stopBridge,
  runtimeStatus,
  requestRuntime,
  readTelemetry,
} from '../src/bridge/bridge.js';
import { originAllowed } from '../src/bridge/wsServer.js';
import { buildRuntimePlugin, PLUGIN_NAME } from '../src/bridge/pluginSource.js';
import { HANDSHAKE_FILE } from '../src/bridge/protocol.js';
import {
  installRuntimeBridge,
  parseRuntimeManifest,
  runtimeCommand,
  runtimeScreenshot,
  runtimeToolDefinitions,
} from '../src/tools/runtimeTools.js';
import { commitStore } from '../src/utils/commit.js';
import { connectAuthed, TestClient } from './runtimeClient.js';

const projects: string[] = [];
const clients: TestClient[] = [];
async function project() {
  const path = await mkdtemp(join(tmpdir(), 'rpgmz-runtime-'));
  projects.push(path);
  await mkdir(join(path, 'js'));
  await writeFile(
    join(path, 'js', 'plugins.js'),
    'var $plugins = [{"name":"Existing","status":false,"parameters":{"x":"1"}}];\n',
  );
  return path;
}
async function connected(path: string) {
  const status = await startBridge(path, 0);
  const handshake = JSON.parse(await readFile(join(path, HANDSHAKE_FILE), 'utf8'));
  const client = await connectAuthed(status.port!, handshake.token, status.projectPath!);
  clients.push(client);
  return client;
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await stopBridge();
  for (const path of projects.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('MZ runtime installation and previews', () => {
  it('previews both files without creating a plugin directory or backups', async () => {
    const path = await project();
    const context = { dryRun: true, commits: [] };
    await commitStore.run(context, () => installRuntimeBridge(path));
    expect(context.commits).toHaveLength(2);
    expect(await readdir(join(path, 'js'))).toEqual(['plugins.js']);
  });
  it('preserves other plugins, backs up the manifest and is idempotent', async () => {
    const path = await project();
    expect((await installRuntimeBridge(path)).changed).toBe(true);
    const source = await readFile(join(path, 'js', 'plugins.js'), 'utf8');
    expect(parseRuntimeManifest(source).entries[0]).toEqual({
      name: 'Existing',
      status: false,
      parameters: { x: '1' },
    });
    expect(parseRuntimeManifest(source).entries[1].name).toBe(PLUGIN_NAME);
    expect((await readdir(join(path, 'js', 'plugins.js.mcp-backups'))).length).toBe(1);
    expect((await installRuntimeBridge(path)).changed).toBe(false);
  });
  it('refuses different plugin source and executable manifests without modifying them', async () => {
    const path = await project();
    await mkdir(join(path, 'js', 'plugins'));
    await writeFile(join(path, 'js', 'plugins', `${PLUGIN_NAME}.js`), '// user code');
    await expect(installRuntimeBridge(path)).rejects.toThrow('different contents');
    await writeFile(join(path, 'js', 'plugins.js'), 'var $plugins = []; globalThis.evil = true;');
    await expect(installRuntimeBridge(path, true)).rejects.toThrow('plain editor-generated');
    expect(await readFile(join(path, 'js', 'plugins', `${PLUGIN_NAME}.js`), 'utf8')).toBe(
      '// user code',
    );
  });
  it('all runtime previews leave sockets, game and filesystem untouched', async () => {
    const path = await project();
    const start = runtimeToolDefinitions.find((tool) => tool.name === 'start_runtime_bridge')!;
    await start.handler({ projectPath: path }, { dryRun: true });
    expect(
      await runtimeCommand(path, { action: 'press_button', button: 'ok', dryRun: true }),
    ).toMatchObject({ dryRun: true });
    expect(await runtimeScreenshot(path, { dryRun: true })).toMatchObject({ dryRun: true });
    expect(runtimeStatus().running).toBe(false);
    expect(await readdir(path)).toEqual(['js']);
  });
  it('plugin exits outside MZ playtest before touching Node or browser APIs', () => {
    const source = buildRuntimePlugin();
    expect(() =>
      vm.runInNewContext(source, { Utils: { RPGMAKER_NAME: 'MZ', isNwjs: () => false } }),
    ).not.toThrow();
    expect(() =>
      vm.runInNewContext(source, {
        Utils: { RPGMAKER_NAME: 'MZ', isNwjs: () => true, isOptionValid: () => false },
      }),
    ).not.toThrow();
    expect(source).not.toContain('eval(');
    expect(source).not.toContain('Window_Message.prototype');
  });
});

describe('authenticated project-bound transport', () => {
  it('refuses browser origins and never exposes the token in status', async () => {
    expect(originAllowed('https://example.com')).toBe(false);
    expect(originAllowed('chrome-extension://game')).toBe(true);
    const path = await project();
    await connected(path);
    expect(runtimeStatus()).toMatchObject({ running: true, connected: true });
    expect(runtimeStatus()).not.toHaveProperty('token');
  });
  it('correlates replies and collects bounded telemetry without keeping screenshot payloads', async () => {
    const path = await project();
    const client = await connected(path);
    client.onMessage((message) =>
      client.send({ type: 'state_dump', requestId: message.requestId, variables: [null, 42] }),
    );
    const reply = await requestRuntime(path, { action: 'get_state' });
    expect(reply.variables).toEqual([null, 42]);
    expect(readTelemetry().frames.some((frame) => frame.type === 'state_dump')).toBe(true);
    expect(readTelemetry(100, ['state_dump'], false).count).toBe(1);
    expect(readTelemetry().count).toBe(0);
  });
  it('rejects invalid tokens and a second authenticated playtest', async () => {
    const path = await project();
    await connected(path);
    const handshake = JSON.parse(await readFile(join(path, HANDSHAKE_FILE), 'utf8'));
    for (const token of ['wrong', handshake.token]) {
      const extra = new TestClient();
      clients.push(extra);
      await extra.connect(runtimeStatus().port!);
      const closed = new Promise<void>((resolve) => extra.onClose(resolve));
      extra.send({ type: 'auth', token, projectPath: runtimeStatus().projectPath });
      await closed;
      expect(runtimeStatus().connected).toBe(true);
    }
  });
  it('refuses cross-project commands and removes only its own handshake', async () => {
    const first = await project();
    const second = await project();
    await connected(first);
    await expect(requestRuntime(second, { action: 'ping' })).rejects.toThrow('active project');
    expect(runtimeStatus().running).toBe(false);
    expect(await readdir(first)).not.toContain(HANDSHAKE_FILE);
    await writeFile(join(second, HANDSHAKE_FILE), '{"token":"someone-else"}');
    await expect(startBridge(second, 0)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(JSON.parse(await readFile(join(second, HANDSHAKE_FILE), 'utf8')).token).toBe(
      'someone-else',
    );
  });
  it('refuses a copied handshake presented from another canonical project', async () => {
    const first = await project();
    const copy = await project();
    const status = await startBridge(first, 0);
    const handshake = JSON.parse(await readFile(join(first, HANDSHAKE_FILE), 'utf8'));
    const client = new TestClient();
    clients.push(client);
    await client.connect(status.port!);
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    client.send({ type: 'auth', token: handshake.token, projectPath: copy });
    await closed;
    expect(runtimeStatus().connected).toBe(false);
  });
  it('bounds retained telemetry by bytes as well as frame count', async () => {
    const path = await project();
    const client = await connected(path);
    for (let index = 0; index < 60; index++)
      client.send({ type: 'log', message: 'x'.repeat(60000) });
    client.onMessage((message) => client.send({ type: 'pong', requestId: message.requestId }));
    await requestRuntime(path, { action: 'ping' });
    expect(runtimeStatus().bufferedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(runtimeStatus().droppedFrames).toBeGreaterThan(0);
  });
  it('bounds waits and rejects arbitrary script commands and invalid control parameters', async () => {
    const path = await project();
    await connected(path);
    await expect(requestRuntime(path, { action: 'ping' }, 10)).rejects.toThrow('timed out');
    await expect(runtimeCommand(path, { action: 'run_js', code: 'alert(1)' })).rejects.toThrow();
    await expect(
      runtimeCommand(path, { action: 'teleport_player', x: -1, y: 2 }),
    ).rejects.toThrow();
    await expect(
      runtimeCommand(path, { action: 'reload_database', file: '../System.json' }),
    ).rejects.toThrow();
  });
});
