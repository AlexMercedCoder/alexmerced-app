import { beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '../../lib/portable';
import { APP_ID, createEntry, createProject, isRunning, type Entry, type Project } from './model';
import { applyImport, buildExport, clearAll, loadSettings, loadWorkspace, saveEntry, saveProject, saveSettings } from './store';

const NOW = new Date(2026, 5, 15, 14, 0, 0);
const at = (hour: number) => new Date(2026, 5, 15, hour).toISOString();

beforeEach(async () => { await clearAll(); localStorage.clear(); });

describe('first run', () => {
  it('seeds a couple of projects so the picker is not empty', async () => {
    const workspace = await loadWorkspace(NOW);
    expect(workspace.projects.length).toBeGreaterThanOrEqual(2);
  });

  it('does not seed twice', async () => {
    const first = await loadWorkspace(NOW);
    expect((await loadWorkspace(NOW)).projects).toHaveLength(first.projects.length);
  });
});

describe('persistence', () => {
  it('round trips projects and entries', async () => {
    await clearAll();
    const project = { ...createProject('Work', 'blue', NOW), id: 'p1' };
    await saveProject(project);
    await saveEntry({ ...createEntry('p1', 'a task', NOW), id: 'e1', start: at(9), end: at(10) });

    const workspace = await loadWorkspace(NOW);
    expect(workspace.projects.map((p) => p.name)).toContain('Work');
    expect(workspace.entries.map((e) => e.description)).toContain('a task');
  });

  it('unassigns an entry whose project is gone', async () => {
    await clearAll();
    await saveProject({ ...createProject('Kept', 'blue', NOW), id: 'kept' });
    await saveEntry({ ...createEntry('vanished', 'orphan', NOW), id: 'e1', start: at(9), end: at(10) });
    const workspace = await loadWorkspace(NOW);
    expect(workspace.entries[0].projectId).toBeNull();
  });

  it('stops extra timers on load', async () => {
    await clearAll();
    await saveProject({ ...createProject('P', 'blue', NOW), id: 'p1' });
    await saveEntry({ ...createEntry('p1', 'old', NOW), id: 'a', start: at(9), end: null });
    await saveEntry({ ...createEntry('p1', 'new', NOW), id: 'b', start: at(13), end: null });

    const workspace = await loadWorkspace(NOW);
    expect(workspace.entries.filter(isRunning)).toHaveLength(1);
    expect(workspace.entries.find(isRunning)?.description).toBe('new');
  });
});

describe('settings', () => {
  it('starts from the defaults', () => {
    expect(loadSettings().increment).toBe(0);
  });

  it('round trips and repairs', () => {
    saveSettings({ increment: 15, mode: 'up', currency: 'EUR', weekStart: 0 });
    expect(loadSettings()).toEqual({ increment: 15, mode: 'up', currency: 'EUR', weekStart: 0 });
    saveSettings({ increment: 7 as 15, mode: 'up', currency: 'EUR', weekStart: 0 });
    expect(loadSettings().increment).toBe(0);
  });
});

describe('export and import', () => {
  const file = (projects: Project[], entries: Entry[]) =>
    JSON.stringify(createEnvelope(APP_ID, 1, { projects, entries, settings: loadSettings() }, { projects: projects.length, entries: entries.length }));

  it('exports with counts', async () => {
    const workspace = await loadWorkspace(NOW);
    const envelope = await buildExport(NOW);
    expect(envelope.counts.projects).toBe(workspace.projects.length);
  });

  it('replaces everything on replace', async () => {
    await loadWorkspace(NOW);
    const project = { ...createProject('Imported', 'red', NOW), id: 'i1' };
    const result = await applyImport(file([project], [{ ...createEntry('i1', 'from file', NOW), id: 'e1', start: at(9), end: at(10) }]), 'replace');
    expect(result.projects).toBe(1);
    expect((await loadWorkspace(NOW)).projects.map((p) => p.name)).toEqual(['Imported']);
  });

  it('merges alongside what is there', async () => {
    const before = await loadWorkspace(NOW);
    const result = await applyImport(file([{ ...createProject('Extra', 'red', NOW), id: 'x' }], []), 'merge');
    expect(result.projects).toBe(before.projects.length + 1);
  });

  it('refuses an empty export', async () => {
    await expect(applyImport(file([], []), 'replace')).rejects.toThrow(/no readable/);
  });

  it('refuses a file from another app', async () => {
    await expect(applyImport(JSON.stringify(createEnvelope('rote', 1, { decks: [] }, {})), 'merge')).rejects.toThrow(/came from "rote"/);
  });
});
