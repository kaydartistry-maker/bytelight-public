// Command Center — household management tools
// Ported into resonant-v1
import crypto from 'crypto';
import { getDb } from './db.js';
import { getBytelightConfig } from '../config.js';
import { today } from '../util/time.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function resolvePetId(petId?: string, petName?: string): string | null {
  if (petId) return petId;
  if (!petName) return null;
  const row = getDb().prepare('SELECT id FROM pets WHERE LOWER(name) = LOWER(?)').get(petName) as { id: string } | undefined;
  return row?.id || null;
}

function resolveListId(listId?: string, listName?: string): string | null {
  if (listId) return listId;
  if (!listName) return null;
  const row = getDb().prepare('SELECT id FROM lists WHERE LOWER(name) = LOWER(?)').get(listName) as { id: string } | undefined;
  return row?.id || null;
}

function calculateNextDue(fromDate: string, frequency: string): string | null {
  const d = new Date(fromDate);
  switch (frequency) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    case 'as_needed': return null;
    default: return null;
  }
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Care Entries (unified model — replaces routines + moods)
// ---------------------------------------------------------------------------

export interface CareEntry {
  id: string;
  date: string;
  person: string;
  category: string;
  value: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertCareEntry(params: {
  id?: string;
  date?: string;
  person?: string;
  category: string;
  value?: string;
  note?: string;
}): CareEntry {
  const db = getDb();
  const id = params.id || uuid();
  const date = params.date || today();
  const person = params.person || getBytelightConfig().command_center.default_person;

  db.prepare(`
    INSERT INTO care_entries (id, date, person, category, value, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, person, category) DO UPDATE SET
      value = COALESCE(excluded.value, value),
      note = COALESCE(excluded.note, note),
      updated_at = datetime('now')
  `).run(id, date, person, params.category, params.value || null, params.note || null);

  return db.prepare('SELECT * FROM care_entries WHERE date = ? AND person = ? AND category = ?').get(date, person, params.category) as CareEntry;
}

export function getCareEntries(date: string, person?: string): CareEntry[] {
  const db = getDb();
  if (person) {
    return db.prepare('SELECT * FROM care_entries WHERE date = ? AND person = ? ORDER BY category').all(date, person) as CareEntry[];
  }
  return db.prepare('SELECT * FROM care_entries WHERE date = ? ORDER BY person, category').all(date) as CareEntry[];
}

export function getCareHistory(person: string, days = 7): CareEntry[] {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];
  return db.prepare('SELECT * FROM care_entries WHERE person = ? AND date >= ? ORDER BY date DESC, category').all(person, sinceStr) as CareEntry[];
}

export function deleteCareEntry(id: string): boolean {
  const result = getDb().prepare('DELETE FROM care_entries WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  text: string;
  project_id: string | null;
  project_name?: string;
  date: string | null;
  due_date: string | null;
  person: string;
  priority: number;
  status: string;
  sort_order: number;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function addTask(params: {
  text: string;
  project?: string;
  date?: string;
  due_date?: string;
  person?: string;
  priority?: number;
  created_by?: string;
}): Task {
  const db = getDb();
  const id = uuid();
  let projectId: string | null = null;

  // Auto-create project if name provided
  if (params.project) {
    const existing = db.prepare('SELECT id FROM projects WHERE LOWER(name) = LOWER(?)').get(params.project) as { id: string } | undefined;
    if (existing) {
      projectId = existing.id;
    } else {
      projectId = uuid();
      db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(projectId, params.project, 'active');
    }
  }

  db.prepare(`
    INSERT INTO tasks (id, text, project_id, date, due_date, person, priority, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, params.text, projectId, params.date || null, params.due_date || null, params.person || getBytelightConfig().command_center.default_person, params.priority || 0, params.created_by || null);

  return db.prepare(`
    SELECT t.*, p.name as project_name FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?
  `).get(id) as Task;
}

export function listTasks(params: {
  status?: string;
  project?: string;
  date?: string;
  person?: string;
  due_before?: string;
  carry_forward?: boolean;
}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.status && params.status !== 'all') {
    conditions.push('t.status = ?');
    values.push(params.status);
  } else if (!params.status) {
    conditions.push("t.status = 'active'");
  }

  if (params.project) {
    conditions.push('LOWER(p.name) = LOWER(?)');
    values.push(params.project);
  }

  if (params.person) {
    conditions.push('t.person = ?');
    values.push(params.person);
  }

  if (params.due_before) {
    conditions.push('t.due_date <= ?');
    values.push(params.due_before);
  }

  // Date-scoped with 3-day carry-forward
  if (params.date) {
    if (params.carry_forward) {
      const d = new Date(params.date);
      d.setDate(d.getDate() - 3);
      const carryDate = d.toISOString().split('T')[0];
      conditions.push('(t.date = ? OR (t.date >= ? AND t.date < ? AND t.status = ?))');
      values.push(params.date, carryDate, params.date, 'active');
    } else {
      conditions.push('t.date = ?');
      values.push(params.date);
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT t.*, p.name as project_name FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    ${where}
    ORDER BY t.priority DESC, t.due_date, t.sort_order
  `).all(...values) as Task[];

  // Deduplicate carried-forward tasks by title
  if (params.carry_forward && params.date) {
    const seen = new Set<string>();
    return rows.filter(t => {
      const key = t.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return rows;
}

export function completeTask(id?: string, text?: string): string {
  const db = getDb();
  if (id) {
    const result = db.prepare("UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
    if (result.changes === 0) return 'Task not found';
    const task = db.prepare('SELECT text FROM tasks WHERE id = ?').get(id) as { text: string };
    return `Completed: ${task.text}`;
  }
  if (text) {
    const task = db.prepare("SELECT id, text FROM tasks WHERE text LIKE ? AND status = 'active' LIMIT 1").get(`%${text}%`) as { id: string; text: string } | undefined;
    if (!task) return 'No matching active task found';
    db.prepare("UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(task.id);
    return `Completed: ${task.text}`;
  }
  return 'Provide task id or text to complete';
}

export function updateTask(id: string, updates: Partial<{
  text: string;
  project: string;
  date: string;
  due_date: string;
  person: string;
  priority: number;
  status: string;
  sort_order: number;
}>): boolean {
  const db = getDb();
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const values: any[] = [];

  if (updates.text !== undefined) { sets.push('text = ?'); values.push(updates.text); }
  if (updates.date !== undefined) { sets.push('date = ?'); values.push(updates.date); }
  if (updates.due_date !== undefined) { sets.push('due_date = ?'); values.push(updates.due_date); }
  if (updates.person !== undefined) { sets.push('person = ?'); values.push(updates.person); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); values.push(updates.priority); }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(updates.sort_order); }

  if (updates.project !== undefined) {
    const existing = db.prepare('SELECT id FROM projects WHERE LOWER(name) = LOWER(?)').get(updates.project) as { id: string } | undefined;
    if (existing) {
      sets.push('project_id = ?');
      values.push(existing.id);
    } else {
      const pid = uuid();
      db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(pid, updates.project, 'active');
      sets.push('project_id = ?');
      values.push(pid);
    }
  }

  values.push(id);
  const result = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Projects (rich model with sort_order)
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  deadline: string | null;
  status: string;
  color: string | null;
  sort_order: number;
  active_tasks?: number;
  created_at: string;
  updated_at: string;
}

export function addProject(params: {
  name: string;
  description?: string;
  owner?: string;
  deadline?: string;
  color?: string;
}): Project {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO projects (id, name, description, owner, deadline, color, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(id, params.name, params.description || null, params.owner || 'us', params.deadline || null, params.color || null);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
}

export function listProjects(status?: string): Project[] {
  const db = getDb();
  let sql = `
    SELECT p.*, COUNT(CASE WHEN t.status = 'active' THEN 1 END) as active_tasks
    FROM projects p
    LEFT JOIN tasks t ON p.id = t.project_id
  `;
  const values: any[] = [];
  if (status && status !== 'all') {
    sql += ' WHERE p.status = ?';
    values.push(status);
  } else if (!status) {
    sql += " WHERE p.status = 'active'";
  }
  sql += ' GROUP BY p.id ORDER BY p.sort_order, p.name';
  return db.prepare(sql).all(...values) as Project[];
}

export function updateProject(id: string, updates: Partial<{
  name: string;
  description: string;
  owner: string;
  deadline: string;
  status: string;
  color: string;
  sort_order: number;
}>): boolean {
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const values: any[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.owner !== undefined) { sets.push('owner = ?'); values.push(updates.owner); }
  if (updates.deadline !== undefined) { sets.push('deadline = ?'); values.push(updates.deadline); }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.color !== undefined) { sets.push('color = ?'); values.push(updates.color); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(updates.sort_order); }

  values.push(id);
  const result = getDb().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteProject(id: string): boolean {
  const result = getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Events (full model — recurrence, categories, reminders)
// ---------------------------------------------------------------------------

export interface CcEvent {
  id: string;
  title: string;
  description: string | null;
  start_date: string;
  start_time: string | null;
  end_date: string | null;
  end_time: string | null;
  all_day: number;
  category: string;
  color: string | null;
  recurrence: string | null;
  reminder_minutes: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function addEvent(params: {
  title: string;
  start_date: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  all_day?: boolean;
  description?: string;
  category?: string;
  color?: string;
  recurrence?: string;
  reminder_minutes?: number;
  created_by?: string;
}): CcEvent {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO events (id, title, description, start_date, start_time, end_date, end_time, all_day, category, color, recurrence, reminder_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.title, params.description || null, params.start_date, params.start_time || null,
    params.end_date || null, params.end_time || null, params.all_day ? 1 : 0,
    params.category || 'default', params.color || null, params.recurrence || null,
    params.reminder_minutes ?? null, params.created_by || null);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as CcEvent;
}

export function listEvents(params: {
  start_date?: string;
  end_date?: string;
  category?: string;
}): CcEvent[] {
  const db = getDb();
  const start = params.start_date || today();
  const end = params.end_date || (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]; })();
  const conditions = ['start_date >= ? AND start_date <= ?'];
  const values: any[] = [start, end];
  if (params.category) {
    conditions.push('category = ?');
    values.push(params.category);
  }
  return db.prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY start_date, start_time`).all(...values) as CcEvent[];
}

export function updateEvent(id: string, updates: Partial<{
  title: string;
  description: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  all_day: boolean;
  category: string;
  color: string;
  recurrence: string;
  reminder_minutes: number;
}>): boolean {
  const sets: string[] = ['updated_at = datetime(\'now\')'];
  const values: any[] = [];

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.start_date !== undefined) { sets.push('start_date = ?'); values.push(updates.start_date); }
  if (updates.start_time !== undefined) { sets.push('start_time = ?'); values.push(updates.start_time); }
  if (updates.end_date !== undefined) { sets.push('end_date = ?'); values.push(updates.end_date); }
  if (updates.end_time !== undefined) { sets.push('end_time = ?'); values.push(updates.end_time); }
  if (updates.all_day !== undefined) { sets.push('all_day = ?'); values.push(updates.all_day ? 1 : 0); }
  if (updates.category !== undefined) { sets.push('category = ?'); values.push(updates.category); }
  if (updates.color !== undefined) { sets.push('color = ?'); values.push(updates.color); }
  if (updates.recurrence !== undefined) { sets.push('recurrence = ?'); values.push(updates.recurrence); }
  if (updates.reminder_minutes !== undefined) { sets.push('reminder_minutes = ?'); values.push(updates.reminder_minutes); }

  values.push(id);
  const result = getDb().prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteEvent(id: string): boolean {
  const result = getDb().prepare('DELETE FROM events WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Cycle tracking
// ---------------------------------------------------------------------------

export function getCycleSettings(): { average_cycle_length: number; average_period_length: number } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM cycle_settings LIMIT 1').get() as any;
  if (!row) {
    db.prepare("INSERT INTO cycle_settings (id, average_cycle_length, average_period_length) VALUES ('1', 28, 5)").run();
    return { average_cycle_length: 28, average_period_length: 5 };
  }
  return { average_cycle_length: row.average_cycle_length, average_period_length: row.average_period_length };
}

export function updateCycleAverages(): void {
  const db = getDb();
  const cycles = db.prepare('SELECT * FROM cycles ORDER BY start_date DESC LIMIT 12').all() as any[];
  if (cycles.length < 2) return;

  const completeCycles = cycles.filter(c => c.end_date);
  const cycleLengths: number[] = [];
  const periodLengths: number[] = [];

  for (let i = 0; i < completeCycles.length - 1; i++) {
    const curr = new Date(completeCycles[i].start_date);
    const prev = new Date(completeCycles[i + 1].start_date);
    const len = Math.round((curr.getTime() - prev.getTime()) / 86400000);
    if (len > 0 && len < 60) cycleLengths.push(len);
  }

  for (const c of completeCycles) {
    if (c.end_date) {
      const len = Math.round((new Date(c.end_date).getTime() - new Date(c.start_date).getTime()) / 86400000) + 1;
      if (len > 0 && len < 15) periodLengths.push(len);
    }
  }

  const avgCycle = cycleLengths.length > 0 ? Math.round(cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length) : 28;
  const avgPeriod = periodLengths.length > 0 ? Math.round(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length) : 5;

  db.prepare("INSERT INTO cycle_settings (id, average_cycle_length, average_period_length) VALUES ('1', ?, ?) ON CONFLICT(id) DO UPDATE SET average_cycle_length = excluded.average_cycle_length, average_period_length = excluded.average_period_length, updated_at = datetime('now')").run(avgCycle, avgPeriod);
}

export function startPeriod(date?: string, notes?: string): string {
  const db = getDb();
  const d = date || today();
  // End any open cycle (set end_date to yesterday)
  const yesterday = new Date(d);
  yesterday.setDate(yesterday.getDate() - 1);
  db.prepare('UPDATE cycles SET end_date = ?, updated_at = datetime(\'now\') WHERE end_date IS NULL').run(yesterday.toISOString().split('T')[0]);
  // Start new cycle
  const id = uuid();
  db.prepare('INSERT INTO cycles (id, start_date, notes) VALUES (?, ?, ?)').run(id, d, notes || null);
  updateCycleAverages();
  return `Period started on ${d}`;
}

export function endPeriod(date?: string): string {
  const db = getDb();
  const d = date || today();
  const result = db.prepare("UPDATE cycles SET end_date = ?, updated_at = datetime('now') WHERE end_date IS NULL").run(d);
  if (result.changes === 0) return 'No open period to end';
  updateCycleAverages();
  return `Period ended on ${d}`;
}

export function logCycleDaily(params: {
  date?: string;
  flow?: string;
  symptoms?: string;
  mood?: string;
  energy?: number;
  notes?: string;
}): string {
  const db = getDb();
  const d = params.date || today();
  const id = uuid();
  db.prepare(`
    INSERT INTO cycle_daily_logs (id, date, flow, symptoms, mood, energy, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      flow = COALESCE(excluded.flow, flow),
      symptoms = COALESCE(excluded.symptoms, symptoms),
      mood = COALESCE(excluded.mood, mood),
      energy = COALESCE(excluded.energy, energy),
      notes = COALESCE(excluded.notes, notes),
      updated_at = datetime('now')
  `).run(id, d, params.flow || null, params.symptoms || null, params.mood || null, params.energy ?? null, params.notes || null);
  return `Logged cycle data for ${d}`;
}

export function getCycleStatus(): Record<string, any> {
  const db = getDb();
  const settings = getCycleSettings();
  const current = db.prepare('SELECT * FROM cycles WHERE end_date IS NULL ORDER BY start_date DESC LIMIT 1').get() as any;
  const lastComplete = db.prepare('SELECT * FROM cycles WHERE end_date IS NOT NULL ORDER BY start_date DESC LIMIT 1').get() as any;
  const recentLogs = db.prepare('SELECT * FROM cycle_daily_logs ORDER BY date DESC LIMIT 5').all() as any[];

  const lastStart = current?.start_date || lastComplete?.start_date;
  if (!lastStart) return { noData: true, settings, recentLogs };

  const todayDate = new Date(today());
  const startDate = new Date(lastStart);
  const cycleDay = Math.round((todayDate.getTime() - startDate.getTime()) / 86400000) + 1;

  let phase: string;
  if (current && !current.end_date && cycleDay <= settings.average_period_length) {
    phase = 'menstrual';
  } else if (cycleDay <= 13) {
    phase = 'follicular';
  } else if (cycleDay <= 16) {
    phase = 'ovulation';
  } else {
    phase = 'luteal';
  }

  const nextPeriod = new Date(startDate);
  nextPeriod.setDate(nextPeriod.getDate() + settings.average_cycle_length);
  const daysUntilPeriod = Math.round((nextPeriod.getTime() - todayDate.getTime()) / 86400000);

  const pmsStart = new Date(nextPeriod);
  pmsStart.setDate(pmsStart.getDate() - 10);
  const inPMSWindow = todayDate >= pmsStart && todayDate < nextPeriod;

  return {
    onPeriod: !!current && !current.end_date,
    periodStarted: current?.start_date || null,
    phase,
    cycleDay,
    cycleLength: settings.average_cycle_length,
    nextPeriodPredicted: nextPeriod.toISOString().split('T')[0],
    daysUntilPeriod,
    inPMSWindow,
    lastPeriodStart: lastStart,
    lastPeriodEnd: lastComplete?.end_date || current?.end_date || null,
    settings,
    recentLogs,
  };
}

export function getCycleHistory(limit = 6): any[] {
  return getDb().prepare('SELECT * FROM cycles ORDER BY start_date DESC LIMIT ?').all(limit) as any[];
}

export function getCyclePredict(): Record<string, any> {
  const settings = getCycleSettings();
  const status = getCycleStatus();
  if (status.noData) return { error: 'No cycle data available' };

  const lastStart = new Date(status.lastPeriodStart);
  const avgCycle = settings.average_cycle_length;

  const nextPeriod = new Date(lastStart);
  nextPeriod.setDate(nextPeriod.getDate() + avgCycle);

  const ovulation = new Date(lastStart);
  ovulation.setDate(ovulation.getDate() + Math.round(avgCycle / 2) - 1);

  const fertileStart = new Date(ovulation);
  fertileStart.setDate(fertileStart.getDate() - 5);

  const pmsStart = new Date(nextPeriod);
  pmsStart.setDate(pmsStart.getDate() - 10);

  const todayDate = new Date(today());

  return {
    nextPeriod: nextPeriod.toISOString().split('T')[0],
    ovulation: ovulation.toISOString().split('T')[0],
    fertileWindow: {
      start: fertileStart.toISOString().split('T')[0],
      end: ovulation.toISOString().split('T')[0],
    },
    pmsWindow: {
      start: pmsStart.toISOString().split('T')[0],
      end: new Date(nextPeriod.getTime() - 86400000).toISOString().split('T')[0],
    },
    inFertileWindow: todayDate >= fertileStart && todayDate <= ovulation,
    inPMSWindow: todayDate >= pmsStart && todayDate < nextPeriod,
  };
}

// ---------------------------------------------------------------------------
// Pets
// ---------------------------------------------------------------------------

export function addPet(params: {
  name: string;
  species?: string;
  breed?: string;
  birthday?: string;
  weight?: string;
  notes?: string;
}): any {
  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO pets (id, name, species, breed, birthday, weight, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, params.name, params.species || null, params.breed || null, params.birthday || null, params.weight || null, params.notes || null);
  return db.prepare('SELECT * FROM pets WHERE id = ?').get(id);
}

export function listPets(): any[] {
  return getDb().prepare('SELECT * FROM pets ORDER BY name').all();
}

export function logPetEvent(params: {
  pet_id?: string;
  pet_name?: string;
  event_type: string;
  title: string;
  notes?: string;
  date?: string;
  next_due?: string;
}): string {
  const petId = resolvePetId(params.pet_id, params.pet_name);
  if (!petId) return 'Pet not found';
  const id = uuid();
  getDb().prepare('INSERT INTO pet_events (id, pet_id, event_type, title, notes, date, next_due) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, petId, params.event_type, params.title, params.notes || null, params.date || today(), params.next_due || null);
  return `Logged ${params.event_type}: ${params.title}`;
}

export function addPetMedication(params: {
  pet_id?: string;
  pet_name?: string;
  name: string;
  dosage?: string;
  frequency?: string;
  next_due?: string;
  notes?: string;
}): string {
  const petId = resolvePetId(params.pet_id, params.pet_name);
  if (!petId) return 'Pet not found';
  const id = uuid();
  getDb().prepare('INSERT INTO pet_medications (id, pet_id, name, dosage, frequency, next_due, notes) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, petId, params.name, params.dosage || null, params.frequency || 'daily', params.next_due || null, params.notes || null);
  return `Added medication: ${params.name}`;
}

export function markMedGiven(params: {
  med_id?: string;
  med_name?: string;
  pet_id?: string;
  pet_name?: string;
}): string {
  const db = getDb();
  let med: any;
  if (params.med_id) {
    med = db.prepare('SELECT m.*, p.name as pet_name FROM pet_medications m JOIN pets p ON m.pet_id = p.id WHERE m.id = ?').get(params.med_id);
  } else if (params.med_name) {
    const petId = resolvePetId(params.pet_id, params.pet_name);
    if (!petId) return 'Pet not found';
    med = db.prepare('SELECT m.*, p.name as pet_name FROM pet_medications m JOIN pets p ON m.pet_id = p.id WHERE m.pet_id = ? AND LOWER(m.name) = LOWER(?)').get(petId, params.med_name);
  }
  if (!med) return 'Medication not found';

  const newNextDue = calculateNextDue(today(), med.frequency);
  if (newNextDue) {
    db.prepare('UPDATE pet_medications SET next_due = ? WHERE id = ?').run(newNextDue, med.id);
  }
  // Log the event
  const eventId = uuid();
  db.prepare('INSERT INTO pet_events (id, pet_id, event_type, title, notes, date) VALUES (?, ?, ?, ?, ?, ?)').run(
    eventId, med.pet_id, 'medication', `${med.name} given`, med.dosage ? `Dosage: ${med.dosage}` : null, today());
  return `${med.name} given to ${med.pet_name}${newNextDue ? `. Next due: ${newNextDue}` : ''}`;
}

export function upcomingPetCare(days = 7): any[] {
  const db = getDb();
  const untilDate = new Date();
  untilDate.setDate(untilDate.getDate() + days);
  const untilStr = untilDate.toISOString().split('T')[0];
  const todayStr = today();

  const meds = db.prepare(`
    SELECT m.*, p.name as pet_name FROM pet_medications m
    JOIN pets p ON m.pet_id = p.id
    WHERE m.active = 1 AND m.next_due IS NOT NULL AND m.next_due <= ?
    ORDER BY m.next_due
  `).all(untilStr) as any[];

  const events = db.prepare(`
    SELECT e.*, p.name as pet_name FROM pet_events e
    JOIN pets p ON e.pet_id = p.id
    WHERE e.next_due IS NOT NULL AND e.next_due <= ?
    ORDER BY e.next_due
  `).all(untilStr) as any[];

  return [...meds.map(m => ({
    type: 'medication',
    pet: m.pet_name,
    name: m.name,
    frequency: m.frequency,
    due: m.next_due,
    overdue: m.next_due < todayStr,
    isToday: m.next_due === todayStr,
  })), ...events.map(e => ({
    type: 'event',
    pet: e.pet_name,
    name: e.title,
    event_type: e.event_type,
    due: e.next_due,
    overdue: e.next_due < todayStr,
    isToday: e.next_due === todayStr,
  }))].sort((a, b) => a.due.localeCompare(b.due));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function createList(params: { name: string; icon?: string; color?: string }): any {
  const db = getDb();
  const id = uuid();
  const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM lists').get() as any)?.m || 0;
  db.prepare('INSERT INTO lists (id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    id, params.name, params.icon || null, params.color || null, maxOrder + 1);
  return db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
}

export function deleteLst(id: string): boolean {
  const db = getDb();
  // Delete items first, then the list
  db.prepare('DELETE FROM list_items WHERE list_id = ?').run(id);
  const result = db.prepare('DELETE FROM lists WHERE id = ?').run(id);
  return result.changes > 0;
}

export function addListItems(listId: string, items: string[], addedBy?: string): number {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO list_items (id, list_id, text, added_by) VALUES (?, ?, ?, ?)');
  let count = 0;
  for (const item of items) {
    stmt.run(uuid(), listId, item, addedBy || null);
    count++;
  }
  return count;
}

export function checkListItem(itemId: string, checked = true): boolean {
  const result = getDb().prepare('UPDATE list_items SET checked = ? WHERE id = ?').run(checked ? 1 : 0, itemId);
  return result.changes > 0;
}

export function getListWithItems(listId?: string, listName?: string): any {
  const id = resolveListId(listId, listName);
  if (!id) return null;
  const db = getDb();
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  const items = db.prepare('SELECT * FROM list_items WHERE list_id = ? ORDER BY checked ASC, created_at').all(id);
  return { ...list as any, items };
}

export function getAllLists(): any[] {
  const db = getDb();
  const lists = db.prepare('SELECT * FROM lists ORDER BY sort_order').all() as any[];
  for (const list of lists) {
    list.item_count = (db.prepare('SELECT COUNT(*) as c FROM list_items WHERE list_id = ?').get(list.id) as any).c;
    list.unchecked_count = (db.prepare('SELECT COUNT(*) as c FROM list_items WHERE list_id = ? AND checked = 0').get(list.id) as any).c;
  }
  return lists;
}

export function clearListItems(listId: string, all = false): number {
  const db = getDb();
  if (all) {
    const result = db.prepare('DELETE FROM list_items WHERE list_id = ?').run(listId);
    return result.changes;
  }
  const result = db.prepare('DELETE FROM list_items WHERE list_id = ? AND checked = 1').run(listId);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export function addExpense(params: {
  amount: number;
  category?: string;
  description?: string;
  paid_by?: string;
  date?: string;
}): any {
  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO expenses (id, amount, category, description, paid_by, date) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, params.amount, params.category || 'other', params.description || null, params.paid_by || null, params.date || today());
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
}

export function listExpenses(params: {
  start_date?: string;
  end_date?: string;
  category?: string;
  paid_by?: string;
  limit?: number;
}): { expenses: any[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.start_date) { conditions.push('date >= ?'); values.push(params.start_date); }
  if (params.end_date) { conditions.push('date <= ?'); values.push(params.end_date); }
  if (params.category) { conditions.push('category = ?'); values.push(params.category); }
  if (params.paid_by) { conditions.push('paid_by = ?'); values.push(params.paid_by); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = params.limit || 50;

  const expenses = db.prepare(`SELECT * FROM expenses ${where} ORDER BY date DESC LIMIT ?`).all(...values, limit) as any[];
  const totalRow = db.prepare(`SELECT SUM(amount) as total FROM expenses ${where}`).get(...values) as any;
  return { expenses, total: totalRow?.total || 0 };
}

export function getExpenseStats(period: string = 'month'): any {
  const db = getDb();
  const now = new Date();
  let startDate: string;

  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay());
    startDate = d.toISOString().split('T')[0];
  } else if (period === 'year') {
    startDate = `${now.getFullYear()}-01-01`;
  } else {
    startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  const byCategory = db.prepare('SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE date >= ? GROUP BY category ORDER BY total DESC').all(startDate) as any[];
  const byPerson = db.prepare('SELECT paid_by, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE date >= ? GROUP BY paid_by ORDER BY total DESC').all(startDate) as any[];
  const totalRow = db.prepare('SELECT SUM(amount) as total, COUNT(*) as count FROM expenses WHERE date >= ?').get(startDate) as any;

  const daysSince = Math.max(1, Math.round((now.getTime() - new Date(startDate).getTime()) / 86400000));

  return {
    period,
    startDate,
    total: totalRow?.total || 0,
    count: totalRow?.count || 0,
    dailyAverage: totalRow?.total ? Math.round((totalRow.total / daysSince) * 100) / 100 : 0,
    byCategory,
    byPerson,
  };
}

// ---------------------------------------------------------------------------
// Countdowns
// ---------------------------------------------------------------------------

export function addCountdown(params: { title: string; target_date: string; emoji?: string; color?: string }): any {
  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO countdowns (id, title, target_date, emoji, color) VALUES (?, ?, ?, ?, ?)').run(
    id, params.title, params.target_date, params.emoji || null, params.color || null);
  return db.prepare('SELECT * FROM countdowns WHERE id = ?').get(id);
}

export function listCountdowns(): any[] {
  const rows = getDb().prepare('SELECT * FROM countdowns ORDER BY target_date').all() as any[];
  const todayDate = new Date(today());
  return rows.map(r => ({
    ...r,
    days_until: Math.round((new Date(r.target_date).getTime() - todayDate.getTime()) / 86400000),
  }));
}

export function deleteCountdown(id: string): boolean {
  const result = getDb().prepare('DELETE FROM countdowns WHERE id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Daily Wins
// ---------------------------------------------------------------------------

export function upsertDailyWin(params: { text: string; who?: string; date?: string }): any {
  const db = getDb();
  const d = params.date || today();
  const who = (params.who || getBytelightConfig().command_center.default_person).toLowerCase();
  const id = uuid();
  db.prepare(`
    INSERT INTO daily_wins (id, date, who, text)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, who) DO UPDATE SET text = excluded.text
  `).run(id, d, who, params.text);
  return db.prepare('SELECT * FROM daily_wins WHERE date = ? AND who = ?').get(d, who);
}

export function getDailyWins(date?: string): any[] {
  return getDb().prepare('SELECT * FROM daily_wins WHERE date = ?').all(date || today()) as any[];
}

// ---------------------------------------------------------------------------
// Status aggregator (pulls from everything)
// ---------------------------------------------------------------------------

export function getCcStatus(): string {
  const db = getDb();
  const todayStr = today();
  const lines: string[] = [];

  // Moods (from care_entries with category 'mood')
  const moods = db.prepare("SELECT * FROM care_entries WHERE date = ? AND category = 'mood'").all(todayStr) as any[];
  if (moods.length > 0) {
    lines.push('**Moods:** ' + moods.map(m => `${m.person}: ${m.value || ''}${m.note ? ' ' + m.note : ''}`).join(', '));
  }

  // Care summary — dynamic grouping by person field
  const care = db.prepare('SELECT * FROM care_entries WHERE date = ?').all(todayStr) as any[];
  if (care.length > 0) {
    // Group care entries by person
    const byPerson = new Map<string, any[]>();
    for (const entry of care) {
      const person = entry.person;
      if (!byPerson.has(person)) byPerson.set(person, []);
      byPerson.get(person)!.push(entry);
    }

    const summarizeCare = (entries: any[], label: string) => {
      const toggles = entries.filter(c => c.value === 'true').map(c => c.category);
      const ratings = entries.filter(c => c.value && !isNaN(Number(c.value)) && c.category !== 'water' && c.category !== 'mood');
      const water = entries.find(c => c.category === 'water');
      const notes = entries.filter(c => c.note).map(c => {
        try { const n = JSON.parse(c.note); return `${c.category}: ${n.map((x: any) => x.text).join('; ')}`; }
        catch { return `${c.category}: ${c.note}`; }
      });
      const parts: string[] = [];
      if (toggles.length > 0) parts.push(`Done: ${toggles.join(', ')}`);
      if (ratings.length > 0) parts.push(ratings.map(r => `${r.category}: ${r.value}/5`).join(', '));
      if (water) parts.push(`Water: ${water.value}/10`);
      let line = `**${label} care:** ` + (parts.length > 0 ? parts.join(' | ') : 'nothing logged yet');
      if (notes.length > 0) line += ` | Notes: ${notes.join(', ')}`;
      return line;
    };

    for (const [person, entries] of byPerson) {
      const label = person.charAt(0).toUpperCase() + person.slice(1);
      lines.push(summarizeCare(entries, label));
    }
  }

  // Today's events
  const events = db.prepare('SELECT * FROM events WHERE start_date = ? ORDER BY start_time').all(todayStr) as any[];
  if (events.length > 0) {
    lines.push('**Today\'s events:** ' + events.map(e => `${e.start_time || 'all day'} ${e.title} (${e.category})`).join(', '));
  }

  // Upcoming events
  const upcoming = db.prepare('SELECT * FROM events WHERE start_date > ? ORDER BY start_date, start_time LIMIT 5').all(todayStr) as any[];
  if (upcoming.length > 0) {
    lines.push('**Upcoming:** ' + upcoming.map(e => `${e.start_date} ${e.title}`).join(', '));
  }

  // Active tasks
  const tasks = db.prepare("SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.status = 'active' ORDER BY t.priority DESC, t.due_date").all() as any[];
  if (tasks.length > 0) {
    const byProject = new Map<string, any[]>();
    for (const t of tasks) {
      const key = t.project_name || 'No project';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(t);
    }
    const taskLines: string[] = [];
    for (const [proj, projTasks] of byProject) {
      taskLines.push(`${proj}: ${projTasks.map(t => `${t.priority > 0 ? '!' : ''}${t.text}${t.due_date ? ' (due ' + t.due_date + ')' : ''}`).join(', ')}`);
    }
    lines.push('**Tasks:** ' + taskLines.join(' | '));
  }

  // Cycle status
  try {
    const cycle = getCycleStatus();
    if (!cycle.noData) {
      lines.push(`**Cycle:** Day ${cycle.cycleDay} (${cycle.phase})${cycle.inPMSWindow ? ' ⚠️ PMS window' : ''}${cycle.onPeriod ? ' 🔴 on period' : ''}`);
    }
  } catch { /* no cycle data */ }

  // Countdowns
  const countdowns = listCountdowns().filter(c => c.days_until >= 0).slice(0, 5);
  if (countdowns.length > 0) {
    lines.push('**Countdowns:** ' + countdowns.map(c => `${c.emoji || ''} ${c.title} (${c.days_until}d)`).join(', '));
  }

  // Daily wins
  const wins = getDailyWins(todayStr);
  if (wins.length > 0) {
    lines.push('**Wins:** ' + wins.map(w => `${w.who}: ${w.text}`).join(', '));
  }

  // Pet care upcoming
  const petCare = upcomingPetCare(2);
  if (petCare.length > 0) {
    lines.push('**Pet care:** ' + petCare.map(p => `${p.pet}: ${p.name}${p.overdue ? ' OVERDUE' : p.isToday ? ' TODAY' : ' due ' + p.due}`).join(', '));
  }

  return lines.length > 0 ? lines.join('\n') : 'No data for today yet.';
}

// ---------------------------------------------------------------------------
// Missing CRUD: updatePet, updateListItem, deleteListItem
// ---------------------------------------------------------------------------

export function updatePet(id: string, updates: Partial<{
  name: string; species: string; breed: string; birthday: string; weight: string; notes: string;
}>): boolean {
  const sets: string[] = [];
  const values: any[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.species !== undefined) { sets.push('species = ?'); values.push(updates.species); }
  if (updates.breed !== undefined) { sets.push('breed = ?'); values.push(updates.breed); }
  if (updates.birthday !== undefined) { sets.push('birthday = ?'); values.push(updates.birthday); }
  if (updates.weight !== undefined) { sets.push('weight = ?'); values.push(updates.weight); }
  if (updates.notes !== undefined) { sets.push('notes = ?'); values.push(updates.notes); }
  if (sets.length === 0) return false;
  values.push(id);
  const result = getDb().prepare(`UPDATE pets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function updateListItem(itemId: string, updates: { text?: string; checked?: boolean }): boolean {
  const sets: string[] = [];
  const values: any[] = [];
  if (updates.text !== undefined) { sets.push('text = ?'); values.push(updates.text); }
  if (updates.checked !== undefined) { sets.push('checked = ?'); values.push(updates.checked ? 1 : 0); }
  if (sets.length === 0) return false;
  values.push(itemId);
  const result = getDb().prepare(`UPDATE list_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteListItem(itemId: string): boolean {
  const result = getDb().prepare('DELETE FROM list_items WHERE id = ?').run(itemId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Stats functions
// ---------------------------------------------------------------------------

export function getTaskStats(days = 14): any {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const active = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'active'").get() as any).c;
  const overdue = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'active' AND due_date IS NOT NULL AND due_date < ?").get(today()) as any).c;
  const completed = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'completed' AND completed_at >= ?").get(sinceStr) as any).c;

  const completedPerDay = db.prepare(`
    SELECT date(completed_at) as date, COUNT(*) as count
    FROM tasks WHERE status = 'completed' AND completed_at >= ?
    GROUP BY date(completed_at) ORDER BY date
  `).all(sinceStr) as any[];

  const byProject = db.prepare(`
    SELECT COALESCE(p.name, 'Ungrouped') as name,
      COUNT(CASE WHEN t.status = 'completed' AND t.completed_at >= ? THEN 1 END) as completed,
      COUNT(CASE WHEN t.status = 'active' THEN 1 END) as active
    FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status IN ('active', 'completed')
    GROUP BY COALESCE(p.name, 'Ungrouped')
    ORDER BY active DESC
  `).all(sinceStr) as any[];

  return { active, overdue, completed, completedPerDay, byProject };
}

export function getCareStats(person: string, days = 14): any {
  const db = getDb();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  const since = dates[dates.length - 1];

  const entries = db.prepare('SELECT * FROM care_entries WHERE person = ? AND date >= ? ORDER BY date').all(person, since) as any[];

  const dailyAverages: any[] = [];
  for (const date of dates.reverse()) {
    const dayEntries = entries.filter(e => e.date === date);
    const get = (cat: string) => {
      const e = dayEntries.find(d => d.category === cat);
      return e?.value ? parseFloat(e.value) : null;
    };
    dailyAverages.push({ date, sleep: get('sleep'), energy: get('energy'), wellbeing: get('wellbeing'), mood: get('mood'), water: get('water') });
  }

  const mealCats = ['breakfast', 'lunch', 'dinner'];
  let mealDays = 0;
  let movementDays = 0;
  for (const date of dates) {
    const dayEntries = entries.filter(e => e.date === date);
    const meals = mealCats.filter(cat => dayEntries.find(d => d.category === cat && d.value === 'true'));
    if (meals.length >= 2) mealDays++;
    if (dayEntries.find(d => d.category === 'movement' && d.value === 'true')) movementDays++;
  }

  return { dailyAverages, mealDays, movementDays, totalDays: days };
}

export function getCycleStats(): any {
  const status = getCycleStatus();
  const settings = getCycleSettings();
  if (status.noData) return { noData: true };

  const db = getDb();
  // Energy by cycle day (from cycle_daily_logs)
  const logs = db.prepare('SELECT * FROM cycle_daily_logs WHERE energy IS NOT NULL ORDER BY date DESC LIMIT 90').all() as any[];

  const energyByDay: Record<number, number[]> = {};
  const cycles = db.prepare('SELECT * FROM cycles ORDER BY start_date DESC LIMIT 12').all() as any[];

  for (const log of logs) {
    // Find which cycle this log belongs to
    for (const cycle of cycles) {
      if (log.date >= cycle.start_date && (!cycle.end_date || log.date <= cycle.end_date)) {
        const cycleDay = Math.round((new Date(log.date).getTime() - new Date(cycle.start_date).getTime()) / 86400000) + 1;
        if (cycleDay > 0 && cycleDay <= 35) {
          if (!energyByDay[cycleDay]) energyByDay[cycleDay] = [];
          energyByDay[cycleDay].push(log.energy);
        }
        break;
      }
    }
  }

  const energyAvgByDay = Object.entries(energyByDay).map(([day, vals]) => ({
    cycleDay: parseInt(day),
    avgEnergy: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
  })).sort((a, b) => a.cycleDay - b.cycleDay);

  return {
    avgCycleLength: settings.average_cycle_length,
    avgPeriodLength: settings.average_period_length,
    currentPhase: status.phase,
    cycleDay: status.cycleDay,
    energyByDay: energyAvgByDay,
  };
}

// ---------------------------------------------------------------------------
// Scratchpad — persistent scratch pad (no date scope, manual clear)
// ---------------------------------------------------------------------------

export function addScratchpadNote(text: string, created_by?: string): any {
  const db = getDb();
  const id = uuid();
  const by = created_by || getBytelightConfig().command_center.default_person;
  db.prepare('INSERT INTO scratchpad_notes (id, text, date, created_by) VALUES (?, ?, ?, ?)').run(id, text, today(), by);
  return db.prepare('SELECT * FROM scratchpad_notes WHERE id = ?').get(id);
}

export function updateScratchpadNote(id: string, text: string): any {
  const db = getDb();
  const result = db.prepare("UPDATE scratchpad_notes SET text = ?, updated_at = datetime('now') WHERE id = ?").run(text, id);
  if (result.changes === 0) throw new Error('Note not found');
  return db.prepare('SELECT * FROM scratchpad_notes WHERE id = ?').get(id);
}

export function deleteScratchpadNote(id: string): boolean {
  return getDb().prepare('DELETE FROM scratchpad_notes WHERE id = ?').run(id).changes > 0;
}

export function clearScratchpadNotes(): number {
  return getDb().prepare('DELETE FROM scratchpad_notes').run().changes;
}

export function getScratchpad(): any {
  const db = getDb();
  const todayDate = today();
  const notes = db.prepare('SELECT * FROM scratchpad_notes ORDER BY created_at ASC').all() as any[];
  const tasks = db.prepare(
    "SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.status = 'active' AND t.project_id IS NULL AND t.date IS NULL ORDER BY t.sort_order ASC, t.created_at ASC"
  ).all() as any[];
  const events = db.prepare('SELECT * FROM events WHERE start_date = ? ORDER BY all_day DESC, start_time ASC').all(todayDate) as any[];
  return {
    notes,
    tasks,
    events,
    counts: { notes: notes.length, tasks: tasks.length, events: events.length },
  };
}
