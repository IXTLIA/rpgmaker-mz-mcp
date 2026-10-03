import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommitContext, commitStore } from '../src/utils/commit.js';
import { MapData, Tileset } from '../src/utils/types.js';
import { blankMapData } from '../src/tools/mapTools.js';
import {
  generateDungeonMap,
  generateMapFromTemplate,
  mapGenerationToolDefinitions,
} from '../src/tools/mapGenerationTools.js';
import { mapAnalysisToolDefinitions } from '../src/tools/mapAnalysisTools.js';

const failure = vi.hoisted(() => ({ destination: '' }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (to === failure.destination) {
        failure.destination = '';
        throw new Error('Injected MapInfos replacement failure');
      }
      return actual.rename(from, to);
    },
  };
});
let project: string;
const options = {
  name: 'Cave',
  width: 31,
  height: 25,
  tilesetId: 1,
  seed: 'test-seed',
  tileProfile: { floorTileId: 1536, wallTileId: 1537 },
  roomCount: 5,
  minRoomSize: 4,
  maxRoomSize: 6,
};
async function json<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(project, 'data', name), 'utf8')) as T;
}
async function save(name: string, value: unknown) {
  await writeFile(join(project, 'data', name), JSON.stringify(value));
}
async function snapshot() {
  const names = await readdir(join(project, 'data'));
  return Promise.all(
    names.sort().map(async (name) => [name, await readFile(join(project, 'data', name), 'utf8')]),
  );
}
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'mz-generated-map-'));
  await mkdir(join(project, 'data'));
  await mkdir(join(project, 'img', 'tilesets'), { recursive: true });
  await writeFile(
    join(project, 'img', 'tilesets', 'Synthetic.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const flags = new Array(8192).fill(0);
  flags[0] = 16;
  flags[1537] = 15;
  for (let tile = 4352; tile < 5888; tile++) flags[tile] = 15;
  await save('Tilesets.json', [
    null,
    {
      id: 1,
      name: 'Synthetic',
      mode: 1,
      flags,
      tilesetNames: [
        'Synthetic',
        'Synthetic',
        'Synthetic',
        'Synthetic',
        'Synthetic',
        'Synthetic',
        '',
        '',
        '',
      ],
    },
  ]);
  await save('MapInfos.json', [
    null,
    { id: 1, name: 'Source', parentId: 0, order: 1, expanded: false, scrollX: 0, scrollY: 0 },
  ]);
  const map = blankMapData(5, 4, 1);
  map.data.fill(1536, 0, 20);
  map.note = '<PluginBehavior>';
  map.autoplayBgm = true;
  map.parallaxName = 'Secret';
  await save('Map001.json', map);
});
afterEach(async () => {
  failure.destination = '';
  await rm(project, { recursive: true, force: true });
});

describe('seeded and project-derived generation', () => {
  it('generates connected geometry deterministically with metadata-only design markers', async () => {
    const first = await generateDungeonMap(project, options);
    const second = await generateDungeonMap(project, { ...options, name: 'Second' });
    expect(first.layout.componentCount).toBe(1);
    expect(first.layout.unreachablePassableCells).toBe(0);
    expect(first.markers.map((marker) => marker.role)).toEqual([
      'entrance',
      'key',
      'door',
      'boss',
      'exit',
    ]);
    expect(first.markers.every((marker) => marker.metadataOnly)).toBe(true);
    const mapA = await json<MapData>('Map002.json'),
      mapB = await json<MapData>('Map003.json');
    expect(mapA.data).toEqual(mapB.data);
    expect(mapA.note).toEqual(mapB.note);
    expect(mapA.events).toEqual([null]);
    expect(second.mapId).toBe(3);
  });
  it('different seeds change geometry', async () => {
    await generateDungeonMap(project, options);
    await generateDungeonMap(project, { ...options, seed: 'another-seed' });
    expect((await json<MapData>('Map002.json')).data).not.toEqual(
      (await json<MapData>('Map003.json')).data,
    );
  });
  it('keeps all five metadata markers distinct in a single minimum-size room', async () => {
    const result = await generateDungeonMap(project, {
      ...options,
      width: 9,
      height: 9,
      roomCount: 1,
      minRoomSize: 3,
      maxRoomSize: 3,
    });
    expect(new Set(result.markers.map((marker) => `${marker.x},${marker.y}`)).size).toBe(5);
  });
  it('previews both files with no new files or changes', async () => {
    const before = await snapshot();
    const context: CommitContext = { dryRun: true, commits: [] };
    const result = await commitStore.run(context, () => generateDungeonMap(project, options));
    expect(result.dryRun).toBe(true);
    expect(context.commits).toHaveLength(2);
    expect(context.commits.map((commit) => commit.path)).toEqual([
      join(project, 'data', 'Map002.json'),
      join(project, 'data', 'MapInfos.json'),
    ]);
    expect(await snapshot()).toEqual(before);
  });
  it.each([
    { width: 0 },
    { tilesetId: 2 },
    { parentId: 999 },
    { tileProfile: { floorTileId: 1537, wallTileId: 1536 } },
    { tileProfile: { floorTileId: 1024, wallTileId: 1537 } },
    { tileProfile: { floorTileId: 1664, wallTileId: 1537 } },
    { minRoomSize: 8, maxRoomSize: 4 },
    { width: 9, minRoomSize: 8 },
  ])('rejects invalid options/profile/reference before writes %j', async (changes) => {
    const before = await snapshot();
    await expect(generateDungeonMap(project, { ...options, ...changes })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('rejects missing assigned sheets and invalid autotile flags', async () => {
    await rm(join(project, 'img', 'tilesets', 'Synthetic.png'));
    const before = await snapshot();
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/missing/);
    expect(await snapshot()).toEqual(before);
  });
  it('uses autotile shape solver and verifies all profile shape flags', async () => {
    const result = await generateDungeonMap(project, {
      ...options,
      tileProfile: { floorTileId: 2816, wallTileId: 4352 },
    });
    expect(result.layout.componentCount).toBe(1);
    const map = await json<MapData>('Map002.json');
    expect(new Set(map.data.slice(0, map.width * map.height)).size).toBeGreaterThan(2);
    const tilesets = await json<(Tileset | null)[]>('Tilesets.json');
    tilesets[1]!.flags[2817] = 15;
    await save('Tilesets.json', tilesets);
    await expect(
      generateDungeonMap(project, {
        ...options,
        tileProfile: { floorTileId: 2816, wallTileId: 4352 },
      }),
    ).rejects.toThrow(/passable/);
  });
  it('refuses orphan map-file collisions', async () => {
    await save('Map002.json', { preserve: true });
    const before = await snapshot();
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/overwrite/);
    expect(await snapshot()).toEqual(before);
  });
  it('serializes simultaneous creations so map IDs and tree entries remain distinct', async () => {
    const results = await Promise.all([
      generateDungeonMap(project, options),
      generateDungeonMap(project, { ...options, name: 'Other' }),
    ]);
    expect(results.map((result) => result.mapId).sort()).toEqual([2, 3]);
    expect((await json<unknown[]>('MapInfos.json')).filter(Boolean)).toHaveLength(3);
  });
  it('rolls back the new map if publishing MapInfos fails', async () => {
    const before = await snapshot();
    failure.destination = join(project, 'data', 'MapInfos.json');
    await expect(generateDungeonMap(project, options)).rejects.toThrow(/Injected/);
    expect(await snapshot()).toEqual(before);
  });
  it('copies/remaps only layout fields, leaving source bytes unchanged', async () => {
    const source = await readFile(join(project, 'data', 'Map001.json'), 'utf8');
    const result = await generateMapFromTemplate(project, {
      name: 'Remap',
      sourceMapId: 1,
      tileRemap: [{ from: 1536, to: 1538 }],
    });
    const map = await json<MapData>('Map002.json');
    expect(result.remappedCells).toBe(20);
    expect(map.data.slice(0, 20)).toEqual(new Array(20).fill(1538));
    expect(map.events).toEqual([null]);
    expect(map.encounterList).toEqual([]);
    expect(map.note).not.toContain('PluginBehavior');
    expect(map.autoplayBgm).toBe(false);
    expect(map.parallaxName).toBe('');
    expect(await readFile(join(project, 'data', 'Map001.json'), 'utf8')).toBe(source);
  });
  it('rejects duplicate template remaps without writes and previews valid copies', async () => {
    const before = await snapshot();
    await expect(
      generateMapFromTemplate(project, {
        name: 'Bad',
        sourceMapId: 1,
        tileRemap: [
          { from: 1536, to: 1538 },
          { from: 1536, to: 1539 },
        ],
      }),
    ).rejects.toThrow(/Duplicate/);
    expect(await snapshot()).toEqual(before);
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, () =>
      generateMapFromTemplate(project, { name: 'Preview', sourceMapId: 1 }),
    );
    expect(context.commits).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
  });
  it('exports discoverable mutation and read-only tool definitions', async () => {
    expect(mapGenerationToolDefinitions.every((def) => def.mutates)).toBe(true);
    const result = await mapAnalysisToolDefinitions[0].handler(
      { projectPath: project },
      { mapId: 1 },
    );
    expect(result).toMatchObject({ mapId: 1, passableCells: 20, componentCount: 1 });
  });
});
