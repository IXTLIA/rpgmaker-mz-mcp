import { join, basename } from 'path';
import { computeAutotileShape, Neighbors } from '../tiles/autotile.js';
import {
  autotileType,
  decodeTile,
  getAutotileKind,
  isSameKindTile,
  makeAutotileId,
} from '../tiles/tileCodec.js';
import { layeredPassability } from '../tiles/tileFlags.js';
import { fileExists } from '../utils/fileHandler.js';
import { MapData, Tileset } from '../utils/types.js';

export interface TileProfile {
  floorTileId: number;
  wallTileId: number;
  corridorTileId?: number;
}
const sheets = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'];

export function validateTileId(tile: number): void {
  if (
    !Number.isInteger(tile) ||
    tile < 0 ||
    tile >= 8192 ||
    (tile >= 1024 && tile < 1536) ||
    (tile >= 1664 && tile < 2048)
  )
    throw new Error(`Tile ID ${tile} is outside the MZ tileset layout`);
  const decoded = decodeTile(tile);
  if (
    decoded.autotile &&
    ((decoded.autotileType === 'wall' && decoded.shape! > 15) ||
      (decoded.autotileType === 'waterfall' && decoded.shape! > 3))
  )
    throw new Error(`Tile ID ${tile} uses an invalid autotile shape`);
}

/** Requires caller-owned, assigned project sheets; never supplies or copies RTP graphics. */
export async function validateProjectTiles(
  projectPath: string,
  tileset: Tileset,
  ids: Iterable<number>,
): Promise<void> {
  if (!Array.isArray(tileset.flags) || !Array.isArray(tileset.tilesetNames))
    throw new Error('Tileset must contain flags and tilesetNames');
  const checkedSheets = new Set<string>();
  for (const tile of new Set(ids)) {
    validateTileId(tile);
    if (!Number.isInteger(tileset.flags[tile]) || tileset.flags[tile] < 0)
      throw new Error(`Tileset has no valid flags for tile ${tile}`);
    if (tile === 0) continue;
    const decoded = decodeTile(tile);
    const name = tileset.tilesetNames[sheets.indexOf(decoded.sheet!)];
    if (!name || name !== basename(name) || /[\\/:]/.test(name) || name === '.' || name === '..')
      throw new Error(`Tileset sheet ${decoded.sheet} is missing or has an unsafe image name`);
    if (checkedSheets.has(name)) continue;
    checkedSheets.add(name);
    const png = join(projectPath, 'img', 'tilesets', name + '.png');
    if (!(await fileExists(png)) && !(await fileExists(png + '_')))
      throw new Error(`Assigned tileset image ${name}.png is missing from this project`);
  }
}

export async function validateTileProfile(
  projectPath: string,
  tileset: Tileset,
  profile: TileProfile,
): Promise<void> {
  const roles = [
    ['floor', profile.floorTileId, true],
    ['wall', profile.wallTileId, false],
    ['corridor', profile.corridorTileId ?? profile.floorTileId, true],
  ] as const;
  const ids = [0];
  for (const [role, tile, walkable] of roles) {
    validateTileId(tile);
    if (tile === 0) throw new Error(`${role} must select a nonempty tile`);
    const type = autotileType(tile);
    const shapes = type
      ? Array.from({ length: type === 'wall' ? 16 : type === 'waterfall' ? 4 : 48 }, (_, shape) =>
          makeAutotileId(getAutotileKind(tile), shape),
        )
      : [tile];
    for (const variant of shapes) {
      ids.push(variant);
      const flags = [tileset.flags[0], tileset.flags[0], tileset.flags[0], tileset.flags[variant]];
      if (flags.some((flag) => !Number.isInteger(flag) || flag < 0))
        throw new Error(`Missing tile flags for ${role} tile ${variant}`);
      const passage = Object.values(layeredPassability(flags));
      if (walkable ? !passage.every(Boolean) : passage.some(Boolean))
        throw new Error(
          `${role} tile ${variant} must be ${walkable ? 'passable in all four directions' : 'blocked in all four directions'} with this tileset's empty upper layers`,
        );
    }
  }
  await validateProjectTiles(projectPath, tileset, ids);
}

/** Reuse MZ's shape solver, including wrapped neighbors on looping templates. */
export function reshapeLayers(map: MapData, layers: number[]): void {
  const area = map.width * map.height;
  for (const layer of layers) {
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) {
        const index = layer * area + y * map.width + x;
        const tile = map.data[index];
        const type = autotileType(tile);
        if (!type) continue;
        const same = (dx: number, dy: number) => {
          let nx = x + dx,
            ny = y + dy;
          if (map.scrollType === 2 || map.scrollType === 3) nx = (nx + map.width) % map.width;
          if (map.scrollType === 1 || map.scrollType === 3) ny = (ny + map.height) % map.height;
          return (
            nx >= 0 &&
            ny >= 0 &&
            nx < map.width &&
            ny < map.height &&
            isSameKindTile(tile, map.data[layer * area + ny * map.width + nx])
          );
        };
        const neighbors: Neighbors = {
          n: same(0, -1),
          e: same(1, 0),
          s: same(0, 1),
          w: same(-1, 0),
          ne: same(1, -1),
          se: same(1, 1),
          sw: same(-1, 1),
          nw: same(-1, -1),
        };
        map.data[index] = makeAutotileId(
          getAutotileKind(tile),
          computeAutotileShape(type, neighbors),
        );
      }
  }
}
