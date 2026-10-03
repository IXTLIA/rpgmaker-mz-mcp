export const HANDSHAKE_FILE = '.mcp-mz-bridge.json';
export const DEFAULT_PORT = 32124;
export const TELEMETRY_LIMIT = 500;
export const COMMANDS = [
  'ping',
  'get_state',
  'capture_screenshot',
  'press_button',
  'interact',
  'teleport_player',
  'reload_map',
  'reload_database',
] as const;
export type CommandAction = (typeof COMMANDS)[number];
export interface RuntimeCommand {
  action: CommandAction;
  requestId?: string;
  button?: string;
  durationMs?: number;
  mapId?: number;
  x?: number;
  y?: number;
  direction?: number;
  file?: string;
}
export interface RuntimeFrame {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}
export const HOT_RELOADABLE: Record<string, string> = {
  'Actors.json': '$dataActors',
  'Classes.json': '$dataClasses',
  'Skills.json': '$dataSkills',
  'Items.json': '$dataItems',
  'Weapons.json': '$dataWeapons',
  'Armors.json': '$dataArmors',
  'Enemies.json': '$dataEnemies',
  'Troops.json': '$dataTroops',
  'States.json': '$dataStates',
  'CommonEvents.json': '$dataCommonEvents',
};
