#!/usr/bin/env node
// Use only a disposable licensed MZ fixture. No engine source is copied into this repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBridge, stopBridge, runtimeStatus, readTelemetry } from '../dist/bridge/bridge.js';
import {
  installRuntimeBridge,
  launchPlaytest,
  runtimeCommand,
  runtimeScreenshot,
  parseRuntimeManifest,
} from '../dist/tools/runtimeTools.js';

const options = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), args[index + 1]]);
    return pairs;
  }, []),
);
assert.ok(
  options.project && options.runtime && options['disposable-fixture'] === 'yes',
  'Usage: node scripts/verify-mz-runtime.mjs --project /disposable/project --runtime /path/to/nw --disposable-fixture yes',
);
const project = resolve(options.project);
const mapPath = join(project, 'data', 'Map001.json');
const manifestPath = join(project, 'js', 'plugins.js');
const packagePath = join(project, 'package.json');
const originalPackage = await readFile(packagePath, 'utf8');
const focusPluginPath = join(project, 'js', 'plugins', 'McpRuntimeSmokeHarness.js');
const originalMap = await readFile(mapPath, 'utf8');
const map = JSON.parse(originalMap);
assert.ok(
  map.events.every((event) => !event),
  'Fixture Map001 must contain no existing events.',
);
assert.ok(map.width > 9 && map.height > 7, 'Fixture must have room for the test transfer.');
const system = JSON.parse(await readFile(join(project, 'data', 'System.json'), 'utf8'));
assert.equal(system.startMapId, 1, 'Fixture must start on map 1.');
let manifestBeforeHarness;
let childPid;
let screenshot;

async function until(name, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const errors = readTelemetry(500, ['exception', 'log']).frames.filter(
      (frame) => frame.type === 'exception' || frame.level === 'error',
    );
    assert.equal(errors.length, 0, `Runtime error: ${JSON.stringify(errors.slice(0, 2))}`);
    const result = await predicate();
    if (result) return result;
    await delay(200);
  }
  throw new Error(
    `${name} did not complete within ${timeout}ms. Errors: ${JSON.stringify(readTelemetry(20, ['exception', 'log']).frames)}. Recent telemetry: ${JSON.stringify(readTelemetry(2).frames)}`,
  );
}

try {
  await installRuntimeBridge(project, true);
  manifestBeforeHarness = await readFile(manifestPath, 'utf8');
  const manifest = parseRuntimeManifest(manifestBeforeHarness);
  assert.ok(!manifest.entries.some((entry) => entry.name === 'McpRuntimeSmokeHarness'));
  // MZ pauses unfocused/hidden windows. This fixture-only shim allows hidden CI playtesting.
  await writeFile(
    focusPluginPath,
    '/*: @target MZ */\nSceneManager.isGameActive = function() { return true; };\nsetInterval(function() { if (Graphics._app) { Graphics._app.ticker.stop(); Graphics._app.ticker.update(performance.now()); } }, 16);\n',
    { flag: 'wx' },
  );
  const packageData = JSON.parse(originalPackage);
  packageData['chromium-args'] =
    (packageData['chromium-args'] || '') +
    ' --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows';
  await writeFile(packagePath, JSON.stringify(packageData));
  manifest.entries.push({
    name: 'McpRuntimeSmokeHarness',
    status: true,
    description: 'Temporary smoke-test background execution',
    parameters: {},
  });
  await writeFile(manifestPath, `var $plugins = ${JSON.stringify(manifest.entries)};\n`);
  const command = (code, parameters = [], indent = 0) => ({ code, indent, parameters });
  const page = {
    conditions: {
      actorId: 1,
      actorValid: false,
      itemId: 1,
      itemValid: false,
      selfSwitchCh: 'A',
      selfSwitchValid: false,
      switch1Id: 1,
      switch1Valid: false,
      switch2Id: 1,
      switch2Valid: false,
      variableId: 1,
      variableValid: false,
      variableValue: 0,
    },
    directionFix: false,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
    list: [
      command(121, [1, 1, 0]),
      command(122, [1, 1, 0, 0, 42]),
      command(355, ['console.warn("MZ_MCP_RUNTIME_SMOKE");']),
      command(101, ['', 0, 0, 2, 'Runtime smoke']),
      command(401, ['MZ bridge event executed.']),
      command(0),
    ],
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: true,
    trigger: 0,
    walkAnime: true,
  };
  map.events[1] = {
    id: 1,
    name: 'MCP smoke',
    note: '',
    x: system.startX,
    y: system.startY,
    pages: [page],
  };
  await writeFile(mapPath, JSON.stringify(map));
  await startBridge(project, 0);
  const launched = await launchPlaytest(project, { runtimeExecutable: options.runtime });
  childPid = launched.pid;
  console.log(`Launched disposable MZ fixture PID ${childPid}.`);
  await until('Bridge connection', () => runtimeStatus().connected);
  const ping = await runtimeCommand(project, { action: 'ping' });
  assert.equal(ping.engine, 'MZ');
  console.log(`Authenticated RPG Maker MZ ${ping.version}.`);
  await until(
    'Title scene',
    async () => (await runtimeCommand(project, { action: 'get_state' })).scene === 'Scene_Title',
  );
  // Wait for the opening fade; MZ ignores title input during that transition.
  await delay(1300);
  console.log(
    `Title state: ${JSON.stringify(await runtimeCommand(project, { action: 'get_state' }))}`,
  );
  console.log(
    `Title screenshot: ${JSON.stringify(await runtimeScreenshot(project, { name: 'mz-runtime-title' }))}`,
  );
  await runtimeCommand(project, { action: 'press_button', button: 'ok', durationMs: 100 });
  await until(
    'New game',
    async () => (await runtimeCommand(project, { action: 'get_state' })).scene === 'Scene_Map',
  );
  await delay(700);
  await runtimeCommand(project, { action: 'interact' });
  const state = await until('Fixture event', async () => {
    const state = await runtimeCommand(project, { action: 'get_state' });
    return state.variables[1] === 42 && state.message.busy && state;
  });
  assert.equal(state.switches[1], true);
  assert.equal(state.message.text, 'MZ bridge event executed.');
  assert.equal(state.currentEvent.eventId, 1);
  const telemetry = readTelemetry(500).frames;
  assert.ok(telemetry.some((frame) => frame.type === 'interpreter_step' && frame.code === 122));
  assert.ok(
    telemetry.some((frame) => frame.type === 'log' && frame.message === 'MZ_MCP_RUNTIME_SMOKE'),
  );
  await delay(1000);
  screenshot = await runtimeScreenshot(project, { name: 'mz-runtime-smoke' });
  console.log(`Screenshot: ${screenshot.path}`);
  await runtimeCommand(project, { action: 'press_button', button: 'ok', durationMs: 100 });
  await until(
    'Message close',
    async () => !(await runtimeCommand(project, { action: 'get_state' })).message.busy,
  );
  await delay(300);
  const transfer = await runtimeCommand(project, {
    action: 'teleport_player',
    mapId: 1,
    x: 4,
    y: 4,
    direction: 6,
  });
  assert.equal(transfer.type, 'transfer_complete');
  assert.deepEqual((await runtimeCommand(project, { action: 'get_state' })).player, {
    mapId: 1,
    x: 4,
    y: 4,
    direction: 6,
    moving: false,
  });
  const reload = await runtimeCommand(project, { action: 'reload_map' });
  assert.equal(reload.type, 'reload_complete');
  const database = await runtimeCommand(project, { action: 'reload_database', file: 'Items.json' });
  assert.equal(database.file, 'Items.json');
  const finalState = await runtimeCommand(project, { action: 'get_state' });
  assert.equal(finalState.variables[1], 42);
  assert.equal(finalState.switches[1], true);
  assert.equal(readTelemetry(500, ['exception']).count, 0);
  console.log(
    'PASS live MZ authentication, startup, controls, event tracing, state, logs, screenshot, transfer completion, map reload and database reload.',
  );
} finally {
  await stopBridge();
  if (childPid) {
    if (process.platform === 'win32')
      await new Promise((resolve) => {
        const cleanup = spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        cleanup.once('exit', resolve);
        cleanup.once('error', resolve);
      });
    else {
      try {
        process.kill(-childPid, 'SIGTERM');
      } catch {
        /* already closed */
      }
    }
  }
  await writeFile(mapPath, originalMap);
  await writeFile(packagePath, originalPackage);
  if (manifestBeforeHarness !== undefined) {
    await writeFile(manifestPath, manifestBeforeHarness);
    await unlink(focusPluginPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
