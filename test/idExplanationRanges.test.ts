import { describe, expect, it } from 'vitest';
import { idExplanation } from '../src/analysis/projectDiagnostics.js';
import { scanIdUsage } from '../src/validation/idUsage.js';
import type { ProjectData } from '../src/validation/references.js';
import type { EventCommand } from '../src/utils/types.js';

function fixture(commands: EventCommand[]): ProjectData {
  return {
    maps: [],
    mapInfos: [],
    actors: [],
    classes: [],
    skills: [],
    items: [],
    weapons: [],
    armors: [],
    enemies: [],
    states: [],
    troops: [],
    animations: [],
    system: null,
    commonEvents: [{ id: 1, name: 'Ranges', trigger: 0, switchId: 0, list: commands }],
  };
}
const c = (code: number, parameters: unknown[]): EventCommand => ({ code, indent: 0, parameters });

describe('query-specific ID range explanations', () => {
  it.each([
    ['switch', 121, [1, 2000, 0]],
    ['variable', 122, [1, 2000, 0, 0, 7]],
  ] as const)(
    'finds %s writers beyond the general scanner range cap',
    (namespace, code, parameters) => {
      const data = fixture([c(code, [...parameters])]);
      expect(scanIdUsage(data, namespace).some((ref) => ref.id === 1500)).toBe(false);
      const report = idExplanation(data, namespace, 1500);
      expect(report.writers).toHaveLength(1);
      expect(report.readers).toHaveLength(0);
      expect(report.references[0].role).toBe('write');
      expect(report.coverage).toMatch(/queried ID/);
      expect(idExplanation(data, namespace, 2001).references).toHaveLength(0);
    },
  );
  it('retains operand readers and read-modify-write roles without double counting', () => {
    const data = fixture([
      c(122, [1, 2000, 0, 1, 1500]),
      c(122, [2, 2, 0, 1, 1500]),
      c(122, [1001, 2000, 1, 0, 5]),
    ]);
    const report = idExplanation(data, 'variable', 1500);
    expect(report.references.map((ref) => ref.role)).toEqual(['both', 'read', 'both']);
    expect(report.writers).toHaveLength(2);
    expect(report.readers).toHaveLength(3);
  });
  it('checks huge writer ranges directly without expanding them', () => {
    const data = fixture([c(121, [1, 2_000_000_000, 0])]);
    expect(scanIdUsage(data, 'switch')).toHaveLength(1000);
    expect(idExplanation(data, 'switch', 1_500_000_000).references).toHaveLength(1);
    expect(idExplanation(data, 'switch', 1).references).toHaveLength(1);
  });
  it('keeps unsupported script/plugin references explicitly outside static coverage', () => {
    const report = idExplanation(
      fixture([c(355, ['$gameSwitches.setValue(1500, true)'])]),
      'switch',
      1500,
    );
    expect(report.references).toHaveLength(0);
    expect(report.coverage).toMatch(/curated/);
    expect(report.coverage).toMatch(/Scripts, plugin commands/);
  });
});
