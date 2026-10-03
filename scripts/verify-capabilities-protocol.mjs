import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { blankMapData } from '../dist/tools/mapTools.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'mz-capabilities-protocol-'));
const project = path.join(root, 'project');
const otherProject = path.join(root, 'other');
const json = (file, value) => writeFile(file, JSON.stringify(value));
const end = { code: 0, indent: 0, parameters: [] };
const text = { code: 401, indent: 0, parameters: ['Gatekeeper welcomes you.'] };
const commands = [
  { code: 101, indent: 0, parameters: ['', 0, 0, 2, 'Gatekeeper'] },
  text,
  { code: 121, indent: 0, parameters: [1, 1, 0] },
  { code: 201, indent: 0, parameters: [0, 2, 1, 1, 2, 0] },
  end,
];
async function fixture(directory) {
  await mkdir(path.join(directory, 'data'), { recursive: true });
  await mkdir(path.join(directory, 'js/plugins'), { recursive: true });
  await mkdir(path.join(directory, 'img/tilesets'), { recursive: true });
  await writeFile(path.join(directory, 'game.rmmzproject'), 'RPGMZ 1.0.0');
  await writeFile(path.join(directory, 'js/plugins.js'), 'var $plugins = [];\n');
  // Generated fixture pixels, not RPG Maker assets.
  await writeFile(
    path.join(directory, 'img/tilesets/Fixture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await json(path.join(directory, 'data/System.json'), {
    gameTitle: 'Capabilities protocol fixture',
    startMapId: 1,
    startX: 2,
    startY: 2,
    switches: ['', 'Gate'],
    variables: ['', 'Count'],
    partyMembers: [],
  });
  for (const name of [
    'Actors',
    'Classes',
    'Skills',
    'Items',
    'Weapons',
    'Armors',
    'Enemies',
    'Troops',
    'States',
    'Animations',
  ]) {
    await json(path.join(directory, `data/${name}.json`), [null]);
  }
  await json(path.join(directory, 'data/CommonEvents.json'), [
    null,
    { id: 1, name: 'Repeated greeting', trigger: 0, switchId: 1, list: commands },
  ]);
  const flags = Array(8192).fill(0);
  flags[0] = 16;
  flags[2] = 15;
  await json(path.join(directory, 'data/Tilesets.json'), [
    null,
    {
      id: 1,
      name: 'Fixture',
      mode: 1,
      flags,
      tilesetNames: ['', '', '', '', '', 'Fixture', '', '', ''],
    },
  ]);
  const infos = [null];
  for (let id = 1; id <= 2; id++) {
    const map = blankMapData(17, 13, 1);
    map.data.fill(1, 0, 17 * 13);
    if (id === 1)
      map.events = [
        null,
        {
          id: 1,
          name: 'Gatekeeper',
          note: '',
          x: 3,
          y: 3,
          pages: [
            {
              conditions: {},
              image: { tileId: 0, characterName: '' },
              priorityType: 1,
              trigger: 0,
              list: commands,
            },
          ],
        },
      ];
    await json(path.join(directory, `data/Map00${id}.json`), map);
    infos.push({
      id,
      name: `Map ${id}`,
      parentId: 0,
      order: id,
      expanded: false,
      scrollX: 0,
      scrollY: 0,
    });
  }
  await json(path.join(directory, 'data/MapInfos.json'), infos);
}
async function snapshot(directory) {
  const files = {};
  const visit = async (current) => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) await visit(file);
      else
        files[path.relative(directory, file)] = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
    }
  };
  await visit(directory);
  return files;
}

// Use raw pipes here: StdioClientTransport.close() may terminate its child and
// hide a listener leaked when EOF races an in-flight bridge start operation.
async function verifyEofDuringBridgeStart(directory) {
  const child = spawn(process.execPath, [entry], {
    env: { ...getDefaultEnvironment(), RPGMAKER_PROJECT_PATH: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let errors = '';
  let submitted = false;
  let closed = false;
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP did not exit after EOF during bridge start: ${errors}`)),
        8000,
      );
      child.once('error', reject);
      child.stdin.on('error', reject);
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        while (output.includes('\n')) {
          const split = output.indexOf('\n');
          const line = output.slice(0, split);
          output = output.slice(split + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            reject(error);
            return;
          }
          if (message.id === 1 && !submitted) {
            submitted = true;
            child.stdin.end(
              JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
                '\n' +
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'tools/call',
                  params: {
                    name: 'start_runtime_bridge',
                    arguments: { port: 0 },
                  },
                }) +
                '\n',
            );
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'eof-during-start-regression', version: '1.0.0' },
          },
        }) + '\n',
      );
    });
    assert.ok(submitted, 'Raw client must submit the bridge start before EOF');
    assert.equal(result.code, 0, `MCP should exit cleanly: ${errors}`);
    assert.equal(result.signal, null, 'MCP must exit without being killed by the test');
    await assert.rejects(access(path.join(directory, '.mcp-mz-bridge.json')));
  } finally {
    clearTimeout(timer);
    if (!closed && child.pid) {
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await exited;
    }
  }
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: 'pipe',
  env: { ...getDefaultEnvironment(), RPGMAKER_PROJECT_PATH: '' },
});
const client = new Client({ name: 'mz-capabilities-verification', version: '1.0.0' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return (
    result.structuredContent ?? JSON.parse(result.content.find((part) => part.type === 'text').text)
  );
}
try {
  await fixture(project);
  await fixture(otherProject);
  await client.connect(transport);
  const listed = await client.listTools();
  const required = [
    'analyze_project',
    'analyze_map_layout',
    'generate_dungeon_map',
    'generate_map_from_template',
    'install_runtime_bridge',
    'start_runtime_bridge',
    'stop_runtime_bridge',
    'runtime_status',
    'runtime_telemetry',
    'runtime_command',
    'runtime_screenshot',
    'launch_playtest',
  ];
  for (const name of required)
    assert.equal(listed.tools.filter((tool) => tool.name === name).length, 1, name);
  assert.equal((await call('runtime_status')).running, false);
  await call('set_project', { path: project });
  const before = await snapshot(project);
  for (const args of [
    { view: 'overview' },
    { view: 'graph', removeMapId: 2 },
    { view: 'explain', namespace: 'switch', id: 1 },
    { view: 'usage', namespace: 'switch', id: 1 },
    { view: 'outline', mapId: 1, eventId: 1 },
    { view: 'balance' },
    { view: 'search', query: 'Gatekeeper' },
    { view: 'duplicates', minLength: 4 },
  ])
    assert.ok(await call('analyze_project', args));
  await call('analyze_map_layout', { mapId: 1, start: { x: 2, y: 2 } });
  const generation = {
    name: 'Seeded dungeon',
    width: 31,
    height: 23,
    tilesetId: 1,
    seed: 'protocol',
    tileProfile: { floorTileId: 1, wallTileId: 2 },
  };
  const preview = await call('generate_dungeon_map', { ...generation, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.wouldChange.length, 2);
  assert.equal(
    (
      await call('generate_map_from_template', {
        sourceMapId: 1,
        name: 'Layout copy',
        dryRun: true,
      })
    ).dryRun,
    true,
  );
  const installPreview = await call('install_runtime_bridge', { dryRun: true });
  assert.equal(installPreview.dryRun, true);
  assert.equal(installPreview.wouldChange.length, 2);
  for (const [name, args] of [
    ['start_runtime_bridge', { port: 0 }],
    ['stop_runtime_bridge', {}],
    ['runtime_command', { action: 'press_button', button: 'ok' }],
    ['runtime_screenshot', {}],
  ]) {
    assert.equal((await call(name, { ...args, dryRun: true })).dryRun, true);
  }
  assert.deepEqual(
    await snapshot(project),
    before,
    'Analysis and every preview must preserve all fixture files',
  );
  const created = await Promise.all([
    call('generate_dungeon_map', generation),
    call('generate_dungeon_map', { ...generation, name: 'Second dungeon' }),
  ]);
  assert.notEqual(
    created[0].mapId,
    created[1].mapId,
    'Concurrent requests must allocate distinct map IDs',
  );
  const copy = await call('generate_map_from_template', { sourceMapId: 1, name: 'Layout copy' });
  const copiedMap = JSON.parse(
    await readFile(
      path.join(project, `data/Map${String(copy.mapId).padStart(3, '0')}.json`),
      'utf8',
    ),
  );
  assert.deepEqual(copiedMap.events, [null]);
  await call('install_runtime_bridge');
  const afterInstall = await snapshot(project);
  await call('install_runtime_bridge');
  assert.deepEqual(
    await snapshot(project),
    afterInstall,
    'Reinstalling identical bridge should be idempotent',
  );
  const running = await call('start_runtime_bridge', { port: 0 });
  assert.equal(running.running, true);
  assert.ok(running.port > 0);
  assert.equal('token' in running, false);
  await access(path.join(project, '.mcp-mz-bridge.json'));
  await call('set_project', { path: otherProject });
  assert.equal((await call('runtime_status')).running, false);
  await assert.rejects(access(path.join(project, '.mcp-mz-bridge.json')));
  await call('start_runtime_bridge', { port: 0 });
  await client.close();
  await assert.rejects(access(path.join(otherProject, '.mcp-mz-bridge.json')));
  await verifyEofDuringBridgeStart(project);
  console.log(
    `PASS stdio: ${required.length} added tools, all analysis views, generation previews/commits/concurrency, plugin preview/idempotency, runtime previews, retarget, close cleanup and EOF during bridge start.`,
  );
} finally {
  await client.close();
  await transport.close();
  await rm(root, { recursive: true, force: true });
}
