import { z } from 'zod';
import type { ToolDefinition } from '../registry.js';
import { loadProjectData } from './validationTools.js';
import {
  commandSources,
  mapGraph,
  idExplanation,
  projectDocuments,
  searchDocuments,
  duplicateCommands,
  STATIC_COVERAGE,
} from '../analysis/projectDiagnostics.js';
import { analyzeBalance } from '../analysis/balanceAnalysis.js';
import { parseEventCommands, astToOutline } from '../analysis/eventOutline.js';
import { checkReferences } from '../validation/references.js';

const shape = {
  view: z
    .enum(['overview', 'graph', 'explain', 'outline', 'balance', 'search', 'duplicates', 'usage'])
    .default('overview')
    .describe('Read-only analysis to perform.'),
  removeMapId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('graph: simulate removal and report downstream static reachability changes.'),
  namespace: z
    .enum(['switch', 'variable', 'common_event'])
    .optional()
    .describe('explain: switch/variable; usage also accepts common_event.'),
  id: z.number().int().positive().optional().describe('explain/usage: identifier to inspect.'),
  target: z
    .enum(['map_event', 'common_event', 'troop_page'])
    .default('map_event')
    .describe('outline: command-list owner.'),
  mapId: z.number().int().positive().optional(),
  eventId: z.number().int().positive().optional(),
  commonEventId: z.number().int().positive().optional(),
  troopId: z.number().int().positive().optional(),
  pageIndex: z.number().int().min(0).default(0),
  category: z
    .enum(['all', 'skills', 'weapons', 'armors', 'enemies'])
    .default('all')
    .describe('balance: database category.'),
  thresholdSd: z
    .number()
    .positive()
    .max(100)
    .default(2)
    .describe('balance: standard-deviation threshold against other entries.'),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('search: lexical token/phrase query across names, dialogue and descriptions.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('search/duplicates: maximum returned results.'),
  minLength: z
    .number()
    .int()
    .min(2)
    .max(50)
    .default(4)
    .describe('duplicates: size of repeated command windows; proposals only.'),
};
const schema = z.object(shape).strict();

/** Fresh project snapshot for every call; analysis never writes or executes project scripts. */
export async function analyzeProject(projectPath: string, raw: Record<string, unknown>) {
  const args = schema.parse(raw);
  if (!projectPath) throw new Error('A project path is required');
  if (
    ['explain', 'usage'].includes(args.view) &&
    (args.id === undefined || args.namespace === undefined)
  )
    throw new Error(`${args.view} requires namespace and id`);
  if (args.view === 'explain' && args.namespace === 'common_event')
    throw new Error('explain supports switch or variable; use usage for common events');
  if (args.view === 'search' && args.query === undefined) throw new Error('search requires query');
  const data = await loadProjectData(projectPath);
  switch (args.view) {
    case 'graph':
      return mapGraph(data, args.removeMapId);
    case 'explain':
    case 'usage':
      return idExplanation(data, args.namespace!, args.id!);
    case 'balance':
      return analyzeBalance(data, args.category, args.thresholdSd);
    case 'search':
      return searchDocuments(projectDocuments(data), args.query!, args.limit);
    case 'duplicates':
      return duplicateCommands(commandSources(data), args.minLength, args.limit);
    case 'outline': {
      const source = commandSources(data).find((source) =>
        args.target === 'common_event'
          ? args.commonEventId !== undefined && source.commonEventId === args.commonEventId
          : args.target === 'troop_page'
            ? args.troopId !== undefined &&
              source.troopId === args.troopId &&
              source.pageIndex === args.pageIndex
            : args.mapId !== undefined &&
              args.eventId !== undefined &&
              source.mapId === args.mapId &&
              source.eventId === args.eventId &&
              source.pageIndex === args.pageIndex,
      );
      if (!source)
        throw new Error(
          'Outline target not found; provide the IDs and pageIndex for the selected target',
        );
      const nodes = parseEventCommands(source.commands);
      return {
        path: source.path,
        nodes,
        outline: astToOutline(nodes),
        coverage: `${STATIC_COVERAGE} Outline is best-effort; malformed indentation may be omitted. Use validate_event for structural diagnostics.`,
      };
    }
    default: {
      const graph = mapGraph(data);
      const references = checkReferences(data);
      return {
        gameTitle: data.system?.gameTitle ?? '',
        counts: {
          maps: data.maps.length,
          commandLists: commandSources(data).length,
          actors: data.actors.filter(Boolean).length,
          skills: data.skills.filter(Boolean).length,
          commonEvents: data.commonEvents.filter(Boolean).length,
        },
        unreachable: graph.unreachable,
        missingMaps: graph.missingMaps,
        referenceWarningCount: references.length,
        referenceWarnings: references.slice(0, 50),
        coverage: STATIC_COVERAGE,
      };
    }
  }
}

export const projectAnalysisToolDefinitions: ToolDefinition[] = [
  {
    name: 'analyze_project',
    description:
      'Read-only project intelligence: overview combines counts, existing reference checks and static map reachability; graph traces direct transfers and called common events, optionally comparing map removal; explain separates static switch/variable readers and writers; usage locates those or common-event references; outline renders map/common/troop event logic including MZ speaker names and plugin commands; balance flags peer outliers with a non-executing formula parser; search ranks project text lexically; duplicates proposes repeated command windows for review. Every result explains limits. Does not execute scripts, simulate play, extract code, rebalance or write files.',
    inputSchema: shape,
    annotations: { readOnlyHint: true },
    handler: (ctx, args) => analyzeProject(ctx.projectPath, args),
  },
];
