import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { backFor, backLabelFor, isSectionRoute, sectionRoute, sectionTap, transitionFor, type NavState, type Section } from './navStack';

const P = 'p1';
const home = { name: 'index', key: 'index-k', params: { project: P } };
const st = (...routes: { name: string; key?: string; params?: object }[]): NavState => ({ index: routes.length - 1, routes: routes.map((r, i) => ({ key: `${r.name}-${i}`, ...r })) });

describe('the stack rule (D280, T188)', () => {
  it('a section tap resets to Levels → section and keeps the home under it', () => {
    // from the plan opened from Levels
    expect(sectionTap(st(home, { name: 'plan/[levelId]', params: { levelId: 'L' } }), 'Dashboard', P)).toEqual({
      index: 1,
      routes: [home, { name: 'dashboard', params: { project: P } }],
    });
    // from deep: Levels → Dashboard → Rulings → a plan: never a push on top
    const deep = st(home, { name: 'dashboard', params: { project: P } }, { name: 'rulings', params: { project: P, from: 'handoff' } }, { name: 'plan/[levelId]' });
    expect(sectionTap(deep, 'Lint', P)).toEqual({ index: 1, routes: [home, { name: 'lint', params: { project: P } }] });
    // Setup takes [projectId]; Sync and Projects take no project
    expect(sectionTap(st(home), 'Setup', P)?.routes[1]).toEqual({ name: 'setup/[projectId]', params: { projectId: P } });
    expect(sectionTap(st(home), 'Sync', P)?.routes[1]).toEqual({ name: 'sync' });
    expect(sectionTap(st(home), 'Projects', P)?.routes[1]).toEqual({ name: 'projects' });
  });

  it('Levels pops to the home under everything, never a second copy (the rail pushed one before T188)', () => {
    expect(sectionTap(st(home, { name: 'plan/[levelId]' }), 'Levels', P)).toEqual({ index: 0, routes: [home] });
    expect(sectionTap(st(home, { name: 'lint', params: { project: P } }, { name: 'plan/[levelId]' }), 'Levels', P)).toEqual({ index: 0, routes: [home] });
    expect(sectionTap(st(home), 'Levels', P)).toBeNull(); // already there
  });

  it('the home takes the open project; with none under the stack a home is made', () => {
    const other = { ...home, params: { project: 'p0' } };
    expect(sectionTap(st(other, { name: 'plan/[levelId]' }), 'Levels', P)?.routes[0]).toEqual({ ...home, params: { project: P } });
    expect(sectionTap(st({ name: 'plan/[levelId]' }), 'Lint', P)?.routes).toEqual([
      { name: 'index', params: { project: P } },
      { name: 'lint', params: { project: P } },
    ]);
    expect(sectionTap(undefined, 'Projects', null)?.routes).toEqual([{ name: 'index' }, { name: 'projects' }]);
  });

  it('tapping the section already open on Levels does nothing; the same section opened from a link is replaced', () => {
    expect(sectionTap(st(home, { name: 'lint', params: { project: P } }), 'Lint', P)).toBeNull();
    // Rulings opened by Apply as ruling (from: handoff): the rail's Rulings is a fresh Rulings on Levels
    expect(sectionTap(st(home, { name: 'rulings', params: { project: P, from: 'handoff' } }), 'Rulings', P)?.routes[1]).toEqual({ name: 'rulings', params: { project: P } });
  });

  it('with no project open only Sync and Projects open', () => {
    expect(sectionTap(st({ name: 'index', key: 'k' }), 'Lint', null)).toBeNull();
    expect(sectionTap(st({ name: 'index', key: 'k' }), 'Levels', null)).toBeNull();
    expect(sectionTap(st({ name: 'index', key: 'k' }), 'Sync', null)).toEqual({ index: 1, routes: [{ name: 'index', key: 'k' }, { name: 'sync' }] });
  });

  it('back: none on a section on Levels, else the name of the screen under it', () => {
    const onLevels = st(home, { name: 'dashboard', params: { project: P } });
    expect(backFor(onLevels, 0)).toBeNull(); // the home
    expect(backFor(onLevels, 1)).toBeNull(); // a section from the rail
    const linked = st(home, { name: 'dashboard' }, { name: 'rulings', params: { from: 'handoff' } });
    expect(backFor(linked, 2)).toBe('Dashboard'); // Apply as ruling → Rulings: ‹ Dashboard
    expect(backFor(st(home, { name: 'plan/[levelId]' }), 1)).toBe('Levels'); // the plan from Levels
    expect(backFor(st(home, { name: 'projects' }, { name: 'setup/[projectId]' }), 2)).toBe('Projects'); // Setup from Projects
    expect(backFor(st(home, { name: 'projects' }, { name: 'library', params: { scope: 'app' } }, { name: 'review' }), 3)).toBe('Library');
    expect(backFor(st(home, { name: 'projects' }, { name: 'new-project' }, { name: 'rule-defaults' }), 3)).toBe('New project');
    expect(backFor(st({ name: 'plan/[levelId]' }), 0)).toBe('Levels'); // nothing under it: back replaces with the home
    expect(backFor(st({ name: 'lint' }), 0)).toBeNull();
    expect(backFor(st(home), 5)).toBeNull();
  });

  it("the section screens' cross-links (T189): back names the screen the link was on", () => {
    const linked = (from: string, to: string) => backFor(st(home, { name: from, params: { project: P } }, { name: to, params: { project: P } }), 2);
    expect(linked('review', 'lint')).toBe('Needs review'); // Needs review → Open the Lint view
    expect(linked('export', 'lint')).toBe('Export'); // Export → the gate's Lint link
    expect(linked('sync', 'review')).toBe('Sync'); // Sync → Open Needs review
    expect(linked('cables', 'review')).toBe('Cable / riser'); // a cable's review item
    expect(linked('lint', 'rulings')).toBe('Lint'); // Fix all via ruling
    expect(linked('cables', 'rulings')).toBe('Cable / riser'); // Select → Apply as ruling
    // a rail tap from any of them leaves Levels → section: no back again
    const tap = sectionTap(st(home, { name: 'dashboard', params: { project: P } }, { name: 'rulings', params: { project: P } }), 'Lint', P);
    expect(tap?.routes.map((r) => r.name)).toEqual(['index', 'lint']);
    expect(backFor(tap!, 1)).toBeNull();
  });

  it('the app-level screens (T190): Projects and Setup from the sidebar show none, what Projects opens says Projects', () => {
    const projects = { name: 'projects' };
    // the project button and the rail's Setup: sections on Levels, no back
    expect(backFor(st(home, projects), 1)).toBeNull();
    expect(backFor(st(home, { name: 'setup/[projectId]', params: { projectId: P } }), 1)).toBeNull();
    // opened from Projects: ‹ Projects
    for (const r of [{ name: 'new-project' }, { name: 'rule-defaults' }, { name: 'library', params: { scope: 'app' } }, { name: 'setup/[projectId]', params: { projectId: P } }]) {
      expect(backFor(st(home, projects, r), 2)).toBe('Projects');
    }
    // the app library's Needs review: ‹ Library
    expect(backFor(st(home, projects, { name: 'library', params: { scope: 'app' } }, { name: 'review', params: { project: 'library' } }), 3)).toBe('Library');
    // Setup from Needs review (a drafts row): ‹ Needs review
    expect(backFor(st(home, { name: 'review', params: { project: P } }, { name: 'setup/[projectId]', params: { projectId: P, step: 'drafts' } }), 2)).toBe('Needs review');
    // the rail's Levels from any of them (setup.home's job before T190): the home alone
    expect(sectionTap(st(home, projects, { name: 'setup/[projectId]', params: { projectId: P } }), 'Levels', P)).toEqual({ index: 0, routes: [home] });
    // the project button again on Projects does nothing
    expect(sectionTap(st(home, projects), 'Projects', P)).toBeNull();
  });

  it('the back label names the screen under it (moved from plan/toolbar.ts, T177)', () => {
    expect(backLabelFor('index')).toBe('Levels');
    expect(backLabelFor(undefined)).toBe('Levels');
    expect(backLabelFor('review')).toBe('Needs review');
    expect(backLabelFor('lint')).toBe('Lint');
    expect(backLabelFor('dashboard')).toBe('Dashboard');
    expect(backLabelFor('cables')).toBe('Cable / riser');
    expect(backLabelFor('rulings')).toBe('Rulings');
    expect(backLabelFor('export')).toBe('Export');
    expect(backLabelFor('vocabulary')).toBe('Vocabulary');
    expect(backLabelFor('library')).toBe('Library');
    expect(backLabelFor('sync')).toBe('Sync');
    expect(backLabelFor('projects')).toBe('Projects');
    expect(backLabelFor('setup/[projectId]')).toBe('Setup');
    expect(backLabelFor('setup/place')).toBe('Setup');
    expect(backLabelFor('plan/[levelId]')).toBe('Back'); // a far end's jump: the other level's plan
  });

  it('a section on Levels neither slides nor takes the edge swipe; details keep the slide', () => {
    const s = st(home, { name: 'cables', key: 'c' });
    expect(transitionFor(s, 'c')).toEqual({ animation: 'none', gestureEnabled: false });
    expect(transitionFor(s, 'index-k')).toEqual({});
    expect(transitionFor(st(home, { name: 'plan/[levelId]', key: 'pl' }), 'pl')).toEqual({});
    expect(transitionFor(st(home, { name: 'dashboard' }, { name: 'rulings', key: 'r' }), 'r')).toEqual({});
    expect(transitionFor(undefined, 'x')).toEqual({});
  });

  it('every route name the rule reads is a file under app/src/app (a rename cannot go unnoticed)', () => {
    const root = fileURLToPath(new URL('../app', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !f.startsWith('_')) files.push(relative(root, p).replace(/\\/g, '/').replace(/\.tsx?$/, ''));
      }
    };
    walk(root);
    const sections: Section[] = ['Levels', 'Needs review', 'Cable / riser', 'Dashboard', 'Rulings', 'Lint', 'Export', 'Setup', 'Vocabulary', 'Library', 'Sync', 'Projects'];
    for (const s of sections) {
      const name = sectionRoute(s, P).name;
      expect(files, s).toContain(name);
      expect(isSectionRoute(name)).toBe(true);
    }
    for (const name of ['plan/[levelId]', 'new-project', 'rule-defaults']) {
      expect(files).toContain(name);
      expect(isSectionRoute(name)).toBe(false);
    }
  });
});
