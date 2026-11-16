import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActionTone } from '../src/lib/dashboard.js';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const css = read('../src/styles/global.css');
const home = read('../src/components/Home.tsx');

/** Class names that have a rule of their own at the top level of the stylesheet (e.g. `.calm {`). */
function standaloneClasses(sheet: string): Set<string> {
  const out = new Set<string>();
  for (const m of sheet.matchAll(/^\.([a-z][a-z0-9-]*)\s*[{,]/gm)) out.add(m[1]!);
  return out;
}

describe('layout class safety', () => {
  // Regression: the Next best action card added its tone as a bare class. When nothing needed the
  // user the tone was `calm`, which matched the global `.calm` note style (display: flex), so the
  // whole card became one row and its text wrapped one letter per line next to Performance.
  it('Next best action tone classes never match a global class', () => {
    expect(home).toMatch(/className=\{`card next-card area-next nba-\$\{next\?\.tone \?\? 'loading'\}`\}/);
    const global = standaloneClasses(css);
    const tones: (ActionTone | 'loading')[] = ['critical', 'action', 'setup', 'calm', 'loading'];
    for (const t of tones) expect(global.has(`nba-${t}`), `.nba-${t} must not be a global class`).toBe(false);
    expect(css).toMatch(/\.next-card\.nba-critical \{/);
    expect(css).toMatch(/\.next-card\.nba-calm \.next-icon \{/);
    expect(css).not.toMatch(/\.next-card\.(critical|calm|action|setup)\b/);
  });

  it('row lists keep badges pill-sized and boxed rows padded', () => {
    // Rows that start with plain text ("Model gateway: <badge> …") have the badge as first element.
    expect(css).toMatch(/\.row-list > li > \.badge:first-child,[\s\S]*?\{\s*flex: none;/);
    expect(css).toMatch(/\.row-list > li\.row-item \{[^}]*padding: 0\.6rem 0\.8rem/);
    expect(css).toMatch(/\.row-item > \.row > :first-child \{[^}]*flex: 1 1 16rem/);
  });

  it('table row buttons stay reachable: pinned Actions column, wrapping on a phone', () => {
    expect(css).toMatch(/\.table-wrap th\.actions-th,\s*\.table-wrap td\.actions-cell \{[^}]*position: sticky;[^}]*right: 0;/);
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(/\.row\.actions-inline \{\s*flex-wrap: wrap;/);
    expect(read('../src/components/Connections.tsx')).not.toMatch(/flexWrap: 'nowrap'/);
  });

  it('Performance pickers wrap inside the card instead of spilling out', () => {
    const tools = css.match(/\.perf \.card-tools \{([^}]*)\}/)?.[1] ?? '';
    expect(tools).toMatch(/flex-wrap:\s*wrap/);
    expect(tools).toMatch(/max-width:\s*100%/);
  });
});
