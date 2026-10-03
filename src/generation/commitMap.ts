import { randomUUID } from 'crypto';
import { link, readFile, rename, unlink, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { commitChange, commitStore, diffJson, CommitResult } from '../utils/commit.js';
import { fileExists, getDataPath, getMapPath } from '../utils/fileHandler.js';
import { MapData, MapInfo } from '../utils/types.js';

const queues = new Map<string, Promise<void>>();

/** Serialize generated-map allocations per project while keeping commit contexts request-local. */
export async function commitGeneratedMap(
  projectPath: string,
  map: MapData,
  name: string,
  parentId = 0,
) {
  const key = resolve(projectPath);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => pending);
  queues.set(key, tail);
  await previous;
  try {
    return await commitPreparedMap(projectPath, map, name, parentId);
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function commitPreparedMap(
  projectPath: string,
  map: MapData,
  name: string,
  parentId: number,
) {
  const infosPath = getDataPath(projectPath, 'MapInfos.json');
  const original = await readFile(infosPath, 'utf8');
  const infos = JSON.parse(original) as (MapInfo | null)[];
  if (!Array.isArray(infos) || (infos.length && infos[0] !== null))
    throw new Error('MapInfos must be a one-indexed array');
  for (let i = 1; i < infos.length; i++)
    if (infos[i] && infos[i]!.id !== i) throw new Error('MapInfos IDs must match their indexes');
  if (parentId !== 0 && !infos[parentId]) throw new Error(`parentId ${parentId} does not exist`);
  const mapId = infos.reduce((max, info) => (info ? Math.max(max, info.id) : max), 0) + 1;
  const mapPath = getMapPath(projectPath, mapId);
  if (await fileExists(mapPath))
    throw new Error(`Refusing to overwrite existing map file ${mapId}`);
  const mapInfo: MapInfo = {
    id: mapId,
    name,
    parentId,
    order: infos.reduce((max, info) => (info ? Math.max(max, info.order) : max), 0) + 1,
    expanded: false,
    scrollX: 0,
    scrollY: 0,
  };
  infos[mapId] = mapInfo;
  const context = commitStore.getStore();
  if (context?.dryRun) {
    await commitChange(mapPath, map);
    await commitChange(infosPath, infos);
    return { mapId, mapInfo, dryRun: true };
  }
  const suffix = `.mcp-stage-${randomUUID()}`;
  const mapStage = mapPath + suffix,
    infosStage = infosPath + suffix;
  let createdMap = false;
  try {
    // Stage both complete files before publishing either. The new map's exclusive
    // hard link refuses collisions; MapInfos is replaced last by atomic rename.
    await writeFile(mapStage, JSON.stringify(map), { encoding: 'utf8', flag: 'wx' });
    await writeFile(infosStage, JSON.stringify(infos), { encoding: 'utf8', flag: 'wx' });
    if ((await readFile(infosPath, 'utf8')) !== original)
      throw new Error('MapInfos changed during generation; retry after the other edit finishes');
    await link(mapStage, mapPath);
    createdMap = true;
    await rename(infosStage, infosPath);
  } catch (error) {
    if (createdMap) await unlink(mapPath);
    throw error;
  } finally {
    await Promise.all(
      [mapStage, infosStage].map((path) =>
        unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }),
      ),
    );
  }
  const commits: CommitResult[] = [
    { path: mapPath, changed: true, dryRun: false, diff: diffJson(undefined, map) },
    { path: infosPath, changed: true, dryRun: false, diff: diffJson(JSON.parse(original), infos) },
  ];
  context?.commits.push(...commits);
  return { mapId, mapInfo, dryRun: false };
}
