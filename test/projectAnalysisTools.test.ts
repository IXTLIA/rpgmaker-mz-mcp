import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeProject,
  projectAnalysisToolDefinitions,
} from '../src/tools/projectAnalysisTools.js';
import { evaluateFormula } from '../src/analysis/formulaEval.js';
import type {
  mapGraph,
  idExplanation,
  searchDocuments,
  duplicateCommands,
} from '../src/analysis/projectDiagnostics.js';
import type { analyzeBalance } from '../src/analysis/balanceAnalysis.js';

const c = (code: number, parameters: unknown[] = [], indent = 0) => ({ code, parameters, indent });
const end = c(0);
const page = (list: ReturnType<typeof c>[], conditions = {}) => ({
  list: [...list, end],
  conditions,
});
describe('read-only project analysis', () => {
  let root: string;
  async function save(name: string, data: unknown) {
    await writeFile(join(root, 'data', name), JSON.stringify(data));
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mz-analysis-'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'game.rmmzproject'), 'RPGMZ 1.0.0');
    await save('System.json', {
      gameTitle: 'Analysis fixture',
      startMapId: 1,
      switches: ['', 'Door', 'Read only'],
      variables: ['', 'Score'],
    });
    await save('MapInfos.json', [
      null,
      { id: 1, name: 'Village' },
      { id: 2, name: 'Bridge' },
      { id: 3, name: 'Forest' },
      { id: 4, name: 'Island' },
      { id: 5, name: 'Missing' },
    ]);
    const shared = [
      c(101, ['', 0, 0, 2, 'Smith']),
      c(401, ['The blacksmith knows the forest.']),
      c(121, [1, 1, 0]),
      c(230, [10]),
    ];
    await save('Map001.json', {
      events: [
        null,
        {
          id: 1,
          name: 'Blacksmith',
          note: 'Quest',
          pages: [
            page(
              [
                ...shared,
                c(117, [1]),
                c(357, ['Weather', 'Start', 'Start rain', { intensity: '2' }]),
                c(122, [1, 1, 1, 1, 1]),
                c(111, [0, 2, 0]),
                c(0, [], 1),
                c(412),
              ],
              { switch1Valid: true, switch1Id: 1 },
            ),
          ],
        },
      ],
    });
    await save('Map002.json', {
      events: [
        null,
        { id: 1, name: 'Bridge keeper', pages: [page([...shared, c(201, [0, 3, 1, 1, 0, 0])])] },
      ],
    });
    await save('Map003.json', { events: [null] });
    await save('Map004.json', { events: [null] });
    await save('CommonEvents.json', [
      null,
      {
        id: 1,
        name: 'Travel',
        trigger: 0,
        switchId: 0,
        list: [c(201, [0, 2, 1, 1, 0, 0]), c(117, [1]), end],
      },
    ]);
    await save('Troops.json', [
      null,
      { id: 1, name: 'Slimes', pages: [page([c(357, ['Battle', 'Roar', 'Roar', {}])])] },
    ]);
    const skills = [
      null,
      ...[10, 11, 12, 13, 1000].map((damage, i) => ({
        id: i + 1,
        name: `Hit ${i}`,
        mpCost: 2,
        tpCost: 0,
        damage: { type: 1, formula: String(damage) },
      })),
      {
        id: 6,
        name: 'Script skill',
        mpCost: 2,
        damage: { type: 1, formula: 'globalThis.analysisInjected = true' },
      },
    ];
    await save('Skills.json', skills);
    await save('Items.json', [
      null,
      { id: 1, name: 'Forest key', description: 'Ask the blacksmith', note: '' },
    ]);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds static transfer paths through common events and handles cycles/removal impact', async () => {
    const report = (await analyzeProject(root, { view: 'graph', removeMapId: 2 })) as ReturnType<
      typeof mapGraph
    >;
    expect(report.reachable).toEqual([1, 2, 3]);
    expect(report.unreachable.map((m) => m.id)).toEqual([4]);
    expect(report.missingMaps.map((m) => m.id)).toEqual([5]);
    expect(report.removal!.newlyUnreachable.map((m) => m.id)).toEqual([3]);
    expect(
      report.edges.some((e) => e.from === 1 && e.to === 2 && e.path.includes('common event 1')),
    ).toBe(true);
    expect(report.coverage).toMatch(/static/i);
  });

  it('separates static readers/writers including read-modify-write and page conditions', async () => {
    const sw = (await analyzeProject(root, {
      view: 'explain',
      namespace: 'switch',
      id: 1,
    })) as ReturnType<typeof idExplanation>;
    expect(sw.writers.length).toBe(2);
    expect(sw.readers.some((r) => r.via.includes('page condition'))).toBe(true);
    const variable = (await analyzeProject(root, {
      view: 'explain',
      namespace: 'variable',
      id: 1,
    })) as ReturnType<typeof idExplanation>;
    expect(variable.references[0].role).toBe('both');
    const readOnly = (await analyzeProject(root, {
      view: 'explain',
      namespace: 'switch',
      id: 2,
    })) as ReturnType<typeof idExplanation>;
    expect(readOnly.diagnosis).toMatch(/no static writer/i);
    expect(readOnly.diagnosis).not.toMatch(/never trigger|never runs/i);
    expect(readOnly.coverage).toMatch(/plugin/i);
  });

  it('bounds common-event expansion when branches share cyclic call chains', async () => {
    await save('CommonEvents.json', [
      null,
      ...Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: 'Chain',
        trigger: 0,
        switchId: 0,
        list:
          index < 99
            ? [c(117, [index + 2]), c(117, [index + 2]), end]
            : [c(201, [0, 2, 1, 1, 0, 0]), c(117, [1]), end],
      })),
    ]);
    const report = (await analyzeProject(root, { view: 'graph' })) as ReturnType<typeof mapGraph>;
    expect(report.reachable).toEqual([1, 2, 3]);
    expect(report.edges.filter((edge) => edge.from === 1 && edge.to === 2)).toHaveLength(1);
  });

  it('searches event notes and rejects unsupported or unsafe formulas', async () => {
    const search = (await analyzeProject(root, { view: 'search', query: 'quest' })) as ReturnType<
      typeof searchDocuments
    >;
    expect(search.hits[0].path).toContain('map 1 / event 1');
    expect(evaluateFormula('a.constructor.constructor("return process")()').ok).toBe(false);
    expect(evaluateFormula('1 / 0').ok).toBe(false);
  });

  it('outlines MZ speaker names, plugin commands and troop/common targets', async () => {
    const event = (await analyzeProject(root, { view: 'outline', mapId: 1, eventId: 1 })) as {
      outline: string;
    };
    expect(event.outline).toContain('Smith');
    expect(event.outline).toContain('Weather');
    expect(event.outline).toContain('Start');
    const troop = (await analyzeProject(root, {
      view: 'outline',
      target: 'troop_page',
      troopId: 1,
    })) as { outline: string };
    expect(troop.outline).toContain('Battle');
    const common = (await analyzeProject(root, {
      view: 'outline',
      target: 'common_event',
      commonEventId: 1,
    })) as { outline: string };
    expect(common.outline).toContain('Map 2');
  });

  it('finds lexical dialogue/item matches with source paths and bounds results', async () => {
    const result = (await analyzeProject(root, {
      view: 'search',
      query: 'blacksmith',
      limit: 2,
    })) as ReturnType<typeof searchDocuments>;
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].path).toContain('map 1 / event 1');
    expect(result.hits[0].snippet.toLowerCase()).toContain('blacksmith');
    expect(result.coverage).toMatch(/lexical/i);
  });

  it('suggests duplicate blocks with relative indentation and no automatic extraction', async () => {
    const result = (await analyzeProject(root, { view: 'duplicates', minLength: 4 })) as ReturnType<
      typeof duplicateCommands
    >;
    expect(result.blocks.some((b) => b.occurrences.length >= 2 && b.codes.includes(101))).toBe(
      true,
    );
    expect(result.coverage).toMatch(/review|context/i);
  });

  it('reports advisory balance outliers and excludes unsupported formulas without executing code', async () => {
    const report = (await analyzeProject(root, {
      view: 'balance',
      category: 'skills',
    })) as ReturnType<typeof analyzeBalance>;
    expect(report.categories[0].outliers.some((o) => o.id === 5)).toBe(true);
    expect(report.unreadableFormulas[0].id).toBe(6);
    expect(Reflect.get(globalThis, 'analysisInjected')).toBeUndefined();
    expect(report.coverage).toMatch(/advisory/i);
    expect(evaluateFormula('Math.max(a.atk * 4 - b.def * 2, 0)')).toEqual({ ok: true, value: 60 });
  });

  it('detects an extreme value even when all other peers are identical', async () => {
    await save('Weapons.json', [
      null,
      ...[10, 10, 10, 1000].map((price, i) => ({
        id: i + 1,
        name: `Sword ${i}`,
        price,
        params: [0, 0, 1, 0, 0],
      })),
    ]);
    const result = (await analyzeProject(root, {
      view: 'balance',
      category: 'weapons',
    })) as ReturnType<typeof analyzeBalance>;
    const outlier = result.categories[0].outliers.find((o) => o.id === 4);
    expect(outlier).toBeDefined();
    expect(outlier!.deviations).toBeNull();
  });

  it('reflects disk changes on the next call, and performs no writes across all views', async () => {
    const beforeNames = await readdir(join(root, 'data'));
    const before = await Promise.all(
      beforeNames.map((name) => readFile(join(root, 'data', name), 'utf8')),
    );
    for (const args of [
      {},
      { view: 'graph' },
      { view: 'usage', namespace: 'common_event', id: 1 },
      { view: 'search', query: 'forest' },
      { view: 'duplicates' },
      { view: 'balance' },
    ]) {
      await analyzeProject(root, args);
    }
    expect(await readdir(join(root, 'data'))).toEqual(beforeNames);
    expect(
      await Promise.all(beforeNames.map((name) => readFile(join(root, 'data', name), 'utf8'))),
    ).toEqual(before);
    expect(await readdir(root)).toEqual(['data', 'game.rmmzproject']);
    await save('Map004.json', {
      events: [null, { id: 1, name: 'Newly added phrase', pages: [page([])] }],
    });
    const refreshed = (await analyzeProject(root, {
      view: 'search',
      query: 'newly added',
    })) as ReturnType<typeof searchDocuments>;
    expect(refreshed.hits[0].path).toContain('map 4');
    expect(projectAnalysisToolDefinitions[0].mutates).toBeUndefined();
  });

  it.each([
    { view: 'outline' },
    { view: 'outline', mapId: 1, eventId: 9 },
    { view: 'explain', namespace: 'switch' },
    { view: 'explain', namespace: 'common_event', id: 1 },
    { view: 'search', query: '' },
    { view: 'balance', thresholdSd: 0 },
    { view: 'duplicates', minLength: 1 },
    { view: 'graph', removeMapId: -1 },
  ])('rejects invalid arguments %j', async (args) => {
    await expect(analyzeProject(root, args)).rejects.toThrow();
  });
});
