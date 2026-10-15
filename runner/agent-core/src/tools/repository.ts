import type { ToolDefinition } from './types.js';
import { buildRepositoryIndex, repositoryWorkingMap, selectRepositoryTests } from '../repository.js';

export function repositoryTools(): ToolDefinition[] {
  return ['repository_map', 'repository_symbols', 'repository_tests'].map((name): ToolDefinition => ({
    kind: 'read',
    spec: { name,
      description: name === 'repository_map' ? 'Map a JavaScript/TypeScript repository: declarations, imports, reverse dependencies and syntax-resolved calls. Bounded; partial coverage is explicit. Does not execute project code. Read actual files before editing.'
        : name === 'repository_symbols' ? 'Find named declarations and their callers in a bounded JavaScript/TypeScript syntax index. Dynamic dispatch and external calls stay unresolved.'
        : 'Select tests affected by changed repository paths through reverse imports, with a named-file fallback. Read the project test script before choosing its command. Partial indexing is not proof no tests exist.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: 40 } }, additionalProperties: false },
    },
    summarize: () => `Read repository ${name === 'repository_tests' ? 'test dependencies' : 'symbols and dependencies'}`,
    async execute(input, ctx) {
      const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string').slice(0, 40) : [];
      if (paths.some((p) => p.length > 512 || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..'))) return { output: 'Paths must be relative to the current workspace and at most 512 characters.', isError: true };
      const query = typeof input.query === 'string' ? input.query.slice(0, 300) : '';
      const index = await buildRepositoryIndex(ctx.cwd, { focus: paths, signal: ctx.signal });
      const map = repositoryWorkingMap(index, paths, query);
      ctx.recordRepositoryMap?.(map);
      const common = { coverage: { files: index.files.length, partial: index.partial, omitted: index.omitted }, fingerprint: index.fingerprint };
      if (name === 'repository_tests') return { output: JSON.stringify({ ...common, tests: selectRepositoryTests(index, paths), note: 'Selection is guidance, not test execution. Run the owning package checks through the existing command tool.' }) };
      const words = query.toLowerCase().split(/\W+/).filter(Boolean);
      const symbols = index.files.flatMap((f) => f.symbols).filter((s) => (!paths.length || paths.includes(s.path)) && (!words.length || words.every((word) => s.name.toLowerCase().includes(word) || s.path.toLowerCase().includes(word)))).slice(0, 60);
      const ids = new Set(symbols.map((s) => s.id));
      const calls = index.files.flatMap((file) => file.calls.map((call) => ({ path: file.path, ...call }))).filter((call) => ids.has(call.from ?? '') || ids.has(call.target ?? '')).slice(0, 80);
      const result = { ...common, map, symbols, calls, outputTruncated: false, note: 'Syntax references only; unresolved calls are not proof of absence. Source files are not marked read by this index.' };
      while (JSON.stringify(result).length > 48000 && (calls.length || symbols.length)) {
        result.outputTruncated = true;
        if (calls.length) calls.pop();
        else symbols.pop();
      }
      return { output: JSON.stringify(result) };
    },
  }));
}
