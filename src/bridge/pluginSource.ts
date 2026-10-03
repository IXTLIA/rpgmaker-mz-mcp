import { HOT_RELOADABLE } from './protocol.js';

export const PLUGIN_NAME = 'McpMzBridge';

/** Dedicated MZ hooks; no event-script evaluation or changes to message rendering. */
export function buildRuntimePlugin(): string {
  return String.raw`/*:
 * @target MZ
 * @plugindesc Local authenticated MCP playtest bridge. Inactive in deployed games.
 * @author RPG Maker MZ MCP contributors
 * @help Install with install_runtime_bridge. Start the bridge before playtesting.
 * Local NW.js test mode only. Does not expose arbitrary JavaScript evaluation.
 */
(() => {
  'use strict';
  if (typeof Utils === 'undefined' || Utils.RPGMAKER_NAME !== 'MZ' || !Utils.isNwjs()) return;
  const test = Utils.isOptionValid('test') || (typeof nw !== 'undefined' && nw.App.argv.some(arg => String(arg).split('&').includes('test')));
  if (!test) return;
  const fs = require('fs');
  const path = require('path');
  let root = process.cwd();
  if (location.protocol === 'file:') {
    let filename = decodeURIComponent(location.pathname);
    if (filename.charAt(0) === '/' && /^[A-Za-z]:/.test(filename.slice(1))) filename = filename.slice(1);
    root = path.dirname(filename);
  }
  const databaseFiles = ${JSON.stringify(HOT_RELOADABLE)};
  let socket = null;
  let authenticated = false;
  let transferRequest = null;
  let currentEvent = null;
  let frame = 0;
  const heldButtons = new Set();
  const bufferedFrames = [];
  const send = payload => {
    if (socket && socket.bufferedAmount > 1048576 && ['interpreter_step', 'player_state'].includes(payload.type)) return;
    let text = JSON.stringify(payload);
    if (text.length > 65536 && payload.type !== 'screenshot_result') {
      if (!payload.requestId) return;
      text = JSON.stringify({ type: 'error', requestId: payload.requestId, message: 'Runtime reply exceeds 64KiB.' });
    }
    if (socket && socket.readyState === WebSocket.OPEN && authenticated) socket.send(text);
    else { bufferedFrames.push(text); if (bufferedFrames.length > 32) bufferedFrames.shift(); }
  };
  const reply = (msg, fields) => send({ requestId: msg.requestId, ...fields });
  const sceneName = () => SceneManager._scene ? SceneManager._scene.constructor.name : 'None';
  const playerState = () => window.$gamePlayer && window.$gameMap ? {
    mapId: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y,
    direction: $gamePlayer.direction(), moving: $gamePlayer.isMoving()
  } : null;
  const mapReady = () => {
    if (!window.$gamePlayer || !window.$gameMap || !(SceneManager._scene instanceof Scene_Map)) throw new Error('Start or load a game on a map first.');
    if ($gamePlayer.isTransferring() || transferRequest) throw new Error('A map transfer is already pending.');
  };
  const command = msg => {
    switch (msg.action) {
      case 'ping': reply(msg, { type: 'pong', engine: 'MZ', version: Utils.RPGMAKER_VERSION }); break;
      case 'get_state': {
        const windowMessage = SceneManager._scene && SceneManager._scene._messageWindow;
        reply(msg, { type: 'state_dump', scene: sceneName(), player: playerState(), currentEvent,
          frameCount: Graphics.frameCount, gameActive: SceneManager.isGameActive(),
          sceneStarted: !!(SceneManager._scene && SceneManager._scene.isStarted()),
          switches: window.$gameSwitches ? $gameSwitches._data : [],
          variables: window.$gameVariables ? $gameVariables._data : [],
          message: { text: window.$gameMessage ? $gameMessage.allText() : '',
            busy: !!(window.$gameMessage && $gameMessage.isBusy()),
            visible: !!(windowMessage && windowMessage.visible), paused: !!(windowMessage && windowMessage.pause) }
        }); break;
      }
      case 'capture_screenshot': {
        const bitmap = SceneManager.snap();
        try {
          const url = bitmap.canvas.toDataURL('image/png');
          reply(msg, { type: 'screenshot_result', mimeType: 'image/png', base64: url.slice(url.indexOf(',') + 1) });
        } finally { if (bitmap && bitmap.destroy) bitmap.destroy(); }
        break;
      }
      case 'press_button': {
        if (!['ok','cancel','menu','up','down','left','right'].includes(msg.button)) throw new Error('Unsupported button.');
        const duration = Number(msg.durationMs === undefined ? 80 : msg.durationMs);
        if (!Number.isInteger(duration) || duration < 30 || duration > 1000) throw new Error('Invalid button duration.');
        if (heldButtons.has(msg.button)) throw new Error('That button is already held.');
        heldButtons.add(msg.button);
        Input._currentState[msg.button] = true;
        setTimeout(() => {
          Input._currentState[msg.button] = false;
          heldButtons.delete(msg.button);
          reply(msg, { type: 'input_complete', button: msg.button });
        }, duration);
        break;
      }
      case 'interact': {
        mapReady();
        if ($gameMap.isEventRunning()) throw new Error('An event is already running.');
        $gamePlayer.checkEventTriggerHere([0]);
        if (!$gameMap.setupStartingEvent()) { $gamePlayer.checkEventTriggerThere([0,1,2]); $gameMap.setupStartingEvent(); }
        reply(msg, { type: 'interaction_checked' }); break;
      }
      case 'teleport_player':
      case 'reload_map': {
        mapReady();
        if ($gameMap.isEventRunning()) throw new Error('Wait for the current event to finish before transferring or reloading.');
        const reload = msg.action === 'reload_map';
        const mapId = reload ? $gameMap.mapId() : (msg.mapId || $gameMap.mapId());
        const x = reload ? $gamePlayer.x : msg.x;
        const y = reload ? $gamePlayer.y : msg.y;
        const direction = reload ? $gamePlayer.direction() : (msg.direction || $gamePlayer.direction());
        if (!Number.isInteger(mapId) || mapId < 1 || !Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 0 || ![2,4,6,8].includes(direction)) throw new Error('Invalid transfer coordinates.');
        const destination = JSON.parse(fs.readFileSync(path.join(root, 'data', 'Map' + String(mapId).padStart(3,'0') + '.json'), 'utf8'));
        if (x >= destination.width || y >= destination.height) throw new Error('Transfer destination is outside the map.');
        transferRequest = { requestId: msg.requestId, type: reload ? 'reload_complete' : 'transfer_complete', mapId };
        $gamePlayer.reserveTransfer(mapId, x, y, direction, 2);
        // Even same-map transfers must enter the map-loading lifecycle to acknowledge completion.
        $gamePlayer.requestMapReload();
        break;
      }
      case 'reload_database': {
        const globalName = databaseFiles[msg.file];
        if (!Object.prototype.hasOwnProperty.call(databaseFiles, msg.file)) throw new Error('Unsupported database file. System/Tilesets need a fresh playtest.');
        const data = JSON.parse(fs.readFileSync(path.join(root, 'data', msg.file), 'utf8'));
        if (!Array.isArray(data)) throw new Error('Database file must contain an array.');
        DataManager.onLoad(data);
        window[globalName] = data;
        reply(msg, { type: 'reload_complete', file: msg.file, note: 'Existing game object instances are not recreated.' }); break;
      }
      default: throw new Error('Unsupported runtime command.');
    }
  };
  const connect = () => {
    let handshake;
    try { handshake = JSON.parse(fs.readFileSync(path.join(root, '.mcp-mz-bridge.json'), 'utf8')); }
    catch { setTimeout(connect, 3000); return; }
    if (!Number.isInteger(handshake.port) || handshake.port < 1 || handshake.port > 65535 || typeof handshake.token !== 'string') return;
    socket = new WebSocket('ws://127.0.0.1:' + handshake.port);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: handshake.token, projectPath: fs.realpathSync(root) }));
    socket.onmessage = event => {
      let msg;
      try {
        msg = JSON.parse(event.data);
        if (msg.requestId === 'authenticated' && msg.action === 'ping') {
          authenticated = true;
          send({ type: 'ready', engine: 'MZ', version: Utils.RPGMAKER_VERSION, scene: sceneName() });
          for (const frame of bufferedFrames.splice(0)) socket.send(frame);
        }
        if (authenticated) command(msg);
      } catch (error) { if (msg) reply(msg, { type: 'error', message: String(error.message || error) }); }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      authenticated = false;
      for (const button of heldButtons) Input._currentState[button] = false;
      heldButtons.clear(); transferRequest = null;
      setTimeout(connect, 3000);
    };
  };
  window.addEventListener('error', event => send({ type: 'exception', message: event.message,
    filename: event.filename, line: event.lineno, stack: event.error && event.error.stack }));
  window.addEventListener('unhandledrejection', event => send({ type: 'exception',
    message: String(event.reason && event.reason.message || event.reason), stack: event.reason && event.reason.stack }));
  for (const level of ['warn','error']) {
    const original = console[level];
    console[level] = function(...args) { original.apply(this,args); send({ type:'log',level,message:args.map(String).join(' ') }); };
  }
  const goto = SceneManager.goto;
  SceneManager.goto = function(sceneClass) {
    const from = sceneName(); goto.call(this, sceneClass);
    send({ type: 'scene_change', from, to: sceneClass ? sceneClass.name : 'None' });
  };
  const onMapLoaded = Scene_Map.prototype.onMapLoaded;
  Scene_Map.prototype.onMapLoaded = function() {
    onMapLoaded.call(this);
    if (transferRequest) { send(transferRequest); transferRequest = null; }
  };
  const updateMap = Scene_Map.prototype.update;
  Scene_Map.prototype.update = function() {
    updateMap.call(this);
    if (++frame % 30 === 0) send({ type: 'player_state', ...playerState() });
  };
  const execute = Game_Interpreter.prototype.executeCommand;
  Game_Interpreter.prototype.executeCommand = function() {
    const eventCommand = this.currentCommand();
    if (eventCommand) {
      currentEvent = { mapId: this._mapId, eventId: this._eventId, depth: this._depth,
        index: this._index, code: eventCommand.code, indent: eventCommand.indent };
      send({ type:'interpreter_step', ...currentEvent });
    }
    return execute.call(this);
  };
  const terminate = Game_Interpreter.prototype.terminate;
  Game_Interpreter.prototype.terminate = function() {
    terminate.call(this);
    if (currentEvent && currentEvent.mapId === this._mapId && currentEvent.eventId === this._eventId && currentEvent.depth === this._depth) currentEvent = null;
  };
  connect();
})();
`;
}
