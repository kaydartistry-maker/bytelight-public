import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Plus, X, Pencil, Check } from 'lucide-react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';
import { todayYmd, parseYmd, addDays, mondayOf } from '../../lib/local-date';

const CC_API = '/api/cc';

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface Task {
  id: string;
  text: string;
  project_name: string | null;
  due_date: string | null;
  priority: number;
  status: string;
  sort_order: number;
}

interface Project {
  id: string;
  name: string;
  color: string | null;
  deadline: string | null;
}

interface CcEvent {
  id: string;
  title: string;
  start_time: string | null;
  category: string;
}

function todayStr(): string {
  return todayYmd();
}

function computeWeek(dateStr: string): string[] {
  const monday = mondayOf(dateStr);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function dayLabel(date: string): { name: string; num: number } {
  const d = parseYmd(date);
  return { name: d.toLocaleDateString('en-GB', { weekday: 'short' }), num: d.getDate() };
}

export function CcPlanner({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [weekDates, setWeekDates] = useState<string[]>(() => computeWeek(todayStr()));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [events, setEvents] = useState<CcEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newTaskText, setNewTaskText] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState(0);
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const [showNewProject, setShowNewProject] = useState(false);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [projName, setProjName] = useState('');
  const [projDeadline, setProjDeadline] = useState('');

  async function loadDay(date: string) {
    setLoading(true);
    try {
      const [t, e, p] = await Promise.all([
        apiFetch(`${CC_API}/tasks?status=active`).then((r) => r.json()),
        apiFetch(`${CC_API}/events?start_date=${date}&end_date=${date}`).then((r) => r.json()),
        apiFetch(`${CC_API}/projects?status=active`).then((r) => r.json()),
      ]);
      setTasks(t.tasks || []);
      setEvents(e.events || []);
      setProjects(p.projects || []);
    } catch {
      /* empty */
    }
    setLoading(false);
  }

  useEffect(() => {
    loadDay(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => {
    const groups = new Map<string, { project: Project | null; tasks: Task[] }>();
    for (const t of tasks) {
      const key = t.project_name || '__ungrouped__';
      if (!groups.has(key)) {
        groups.set(key, { project: projects.find((p) => p.name === t.project_name) || null, tasks: [] });
      }
      groups.get(key)!.tasks.push(t);
    }
    for (const g of groups.values()) g.tasks.sort((a, b) => a.sort_order - b.sort_order);
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === '__ungrouped__') return 1;
      if (b[0] === '__ungrouped__') return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [tasks, projects]);

  function selectDate(date: string) {
    setSelectedDate(date);
    loadDay(date);
  }

  function shiftWeek(delta: number) {
    const next = computeWeek(addDays(weekDates[0], delta * 7));
    setWeekDates(next);
    selectDate(next[0]);
  }

  async function addTask(projectKey: string) {
    if (!newTaskText.trim()) return;
    await apiFetch(`${CC_API}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: newTaskText.trim(),
        project: projectKey === '__ungrouped__' ? undefined : projectKey,
        priority: newTaskPriority,
      }),
    });
    setNewTaskText('');
    setNewTaskPriority(0);
    setAddingTo(null);
    await loadDay(selectedDate);
  }

  async function toggleComplete(task: Task) {
    if (task.status === 'active') {
      await apiFetch(`${CC_API}/tasks/${task.id}/complete`, { method: 'PUT' });
    } else {
      await apiFetch(`${CC_API}/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
    }
    await loadDay(selectedDate);
  }

  async function patchTask(id: string, body: Record<string, unknown>) {
    await apiFetch(`${CC_API}/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadDay(selectedDate);
  }

  async function deleteTask(id: string) {
    await apiFetch(`${CC_API}/tasks/${id}`, { method: 'DELETE' });
    await loadDay(selectedDate);
  }

  // Touch-friendly reorder — moves a task within its group and rewrites
  // sort_order for the whole group.
  async function moveTask(tasks: Task[], idx: number, dir: -1 | 1) {
    const to = idx + dir;
    if (to < 0 || to >= tasks.length) return;
    const items = [...tasks];
    const [m] = items.splice(idx, 1);
    items.splice(to, 0, m);
    await Promise.all(
      items.map((t, i) =>
        apiFetch(`${CC_API}/tasks/${t.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sort_order: i }),
        }),
      ),
    );
    await loadDay(selectedDate);
  }

  async function createProject() {
    if (!projName.trim()) return;
    await apiFetch(`${CC_API}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projName.trim(), deadline: projDeadline || undefined }),
    });
    setProjName('');
    setProjDeadline('');
    setShowNewProject(false);
    await loadDay(selectedDate);
  }

  async function saveProjectEdit() {
    if (!editingProject || !projName.trim()) return;
    await apiFetch(`${CC_API}/projects/${editingProject}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projName.trim(), deadline: projDeadline || undefined }),
    });
    setEditingProject(null);
    await loadDay(selectedDate);
  }

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const priorityColor = (p: number) => (p >= 2 ? colors.accent : p >= 1 ? colors.accent : colors.textMuted);
  const priorityLabel = (p: number) => (p >= 2 ? '!!' : p >= 1 ? '!' : '·');
  const input = cn('rounded-lg border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);

  return (
    <>
      {/* Week bar */}
      <div className={cn('rounded-2xl border p-3 mb-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center gap-1">
          <button onClick={() => shiftWeek(-1)} className={cn('p-1 shrink-0', colors.textMuted)}>
            <ChevronLeft size={16} />
          </button>
          <div className="flex flex-1 justify-around">
            {weekDates.map((date) => {
              const dl = dayLabel(date);
              const sel = date === selectedDate;
              return (
                <button
                  key={date}
                  onClick={() => selectDate(date)}
                  className="flex flex-col items-center gap-0.5 rounded-lg border px-1.5 py-1.5"
                  style={{
                    borderColor: sel ? colors.accent : 'transparent',
                    background: sel ? (themeMode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') : 'transparent',
                  }}
                >
                  <span className={cn('text-[9px] uppercase', colors.textMuted)}>{dl.name}</span>
                  <span
                    className="text-sm"
                    style={{ color: date === todayStr() ? colors.accent : colors.textMain, fontWeight: date === todayStr() ? 700 : 500 }}
                  >
                    {dl.num}
                  </span>
                </button>
              );
            })}
          </div>
          <button onClick={() => shiftWeek(1)} className={cn('p-1 shrink-0', colors.textMuted)}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
      ) : (
        <>
          {events.length > 0 && (
            <div className={cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder)} style={{ borderColor: colors.accent }}>
              <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-1', colors.textMuted)}>Schedule</div>
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-2 py-1">
                  <span className={cn('text-xs w-16 shrink-0', colors.textMuted)}>{ev.start_time || 'All day'}</span>
                  <span className={cn('flex-1 text-sm truncate', colors.textMain)}>{ev.title}</span>
                </div>
              ))}
            </div>
          )}

          {grouped.length === 0 && (
            <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center mb-3', colors.panelBg, colors.panelBorder, colors.textMuted)}>No tasks yet.</div>
          )}

          {grouped.map(([key, group]) => {
            const isCollapsed = collapsed.has(key);
            return (
              <div key={key} className={cn('rounded-2xl border mb-3 overflow-hidden', colors.panelBorder)}>
                <div className={cn('flex items-center justify-between px-3 py-2.5', colors.panelBg)}>
                  <div className="flex items-center gap-2 min-w-0">
                    {group.project?.color && (
                      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: group.project.color }} />
                    )}
                    <span className={cn('text-sm font-semibold truncate', colors.textMain)}>
                      {key === '__ungrouped__' ? 'Ungrouped' : key}
                    </span>
                    {group.project?.deadline && (
                      <span className={cn('text-[10px]', colors.textMuted)}>due {group.project.deadline}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {group.project && (
                      <button
                        onClick={() => {
                          setEditingProject(group.project!.id);
                          setProjName(group.project!.name);
                          setProjDeadline(group.project!.deadline || '');
                        }}
                        className={cn('p-1', colors.textMuted)}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    <button onClick={() => toggleCollapse(key)} className={cn('p-1', colors.textMuted)}>
                      <ChevronDown size={14} className={cn(isCollapsed && '-rotate-90')} />
                    </button>
                  </div>
                </div>

                {editingProject === group.project?.id && (
                  <div className="flex gap-2 p-2">
                    <input className={cn(input, 'flex-1')} value={projName} onChange={(e) => setProjName(e.target.value)} />
                    <input className={input} type="date" value={projDeadline} onChange={(e) => setProjDeadline(e.target.value)} />
                    <button onClick={saveProjectEdit} className="rounded-lg px-3 text-xs font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                      Save
                    </button>
                  </div>
                )}

                {!isCollapsed && (
                  <>
                    {group.tasks.map((task, idx) => {
                      const done = task.status === 'completed';
                      return (
                        <div key={task.id} className={cn('flex items-center gap-2 px-3 py-2 border-t', colors.panelBorder)}>
                          <button
                            onClick={() => toggleComplete(task)}
                            className="h-5 w-5 shrink-0 rounded border flex items-center justify-center"
                            style={{
                              borderColor: done ? colors.accent : 'rgba(127,127,127,0.5)',
                              background: done ? colors.accent : 'transparent',
                            }}
                          >
                            {done && <Check size={12} className="bytelight-on-accent" />}
                          </button>
                          <div className="flex-1 min-w-0">
                            {editingTask === task.id ? (
                              <input
                                autoFocus
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                onBlur={() => { if (editText.trim()) patchTask(task.id, { text: editText.trim() }); setEditingTask(null); }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { if (editText.trim()) patchTask(task.id, { text: editText.trim() }); setEditingTask(null); }
                                  if (e.key === 'Escape') setEditingTask(null);
                                }}
                                className={cn('w-full rounded-md border px-2 py-1 text-sm bg-transparent', colors.panelBorder, colors.textMain)}
                              />
                            ) : (
                              <button
                                onClick={() => { setEditingTask(task.id); setEditText(task.text); }}
                                className={cn('text-sm text-left truncate w-full', colors.textMain)}
                                style={{ opacity: done ? 0.5 : 1, textDecoration: done ? 'line-through' : 'none' }}
                              >
                                {task.text}
                              </button>
                            )}
                            {task.due_date && (
                              <div className="text-[10px]" style={{ color: task.due_date < todayStr() ? colors.accent : colors.textMuted, opacity: task.due_date < todayStr() ? 0.9 : 1 }}>
                                due {task.due_date}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col shrink-0">
                            <button
                              onClick={() => moveTask(group.tasks, idx, -1)}
                              disabled={idx === 0}
                              className={cn('disabled:opacity-25', colors.textMuted)}
                            >
                              <ChevronUp size={13} />
                            </button>
                            <button
                              onClick={() => moveTask(group.tasks, idx, 1)}
                              disabled={idx === group.tasks.length - 1}
                              className={cn('disabled:opacity-25', colors.textMuted)}
                            >
                              <ChevronDown size={13} />
                            </button>
                          </div>
                          <button
                            onClick={() => patchTask(task.id, { priority: task.priority >= 2 ? 0 : task.priority + 1 })}
                            className="h-6 w-6 shrink-0 text-sm font-bold"
                            style={{ color: priorityColor(task.priority) }}
                          >
                            {priorityLabel(task.priority)}
                          </button>
                          <button onClick={() => deleteTask(task.id)} className={cn('p-1 shrink-0', colors.textMuted)}>
                            <X size={13} />
                          </button>
                        </div>
                      );
                    })}

                    {addingTo === key ? (
                      <div className={cn('flex gap-2 p-2 border-t', colors.panelBorder)}>
                        <input
                          autoFocus
                          className={cn(input, 'flex-1')}
                          placeholder="New task…"
                          value={newTaskText}
                          onChange={(e) => setNewTaskText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addTask(key)}
                        />
                        <select
                          className={input}
                          value={newTaskPriority}
                          onChange={(e) => setNewTaskPriority(parseInt(e.target.value, 10))}
                        >
                          <option value={0}>Normal</option>
                          <option value={1}>High</option>
                          <option value={2}>Urgent</option>
                        </select>
                        <button onClick={() => addTask(key)} className="rounded-lg px-3 text-xs font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                          Add
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setAddingTo(key); setNewTaskText(''); }}
                        className={cn('flex items-center gap-1.5 px-3 py-2 text-xs border-t w-full', colors.panelBorder, colors.textMuted)}
                      >
                        <Plus size={14} /> Add task
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            {showNewProject ? (
              <div className="flex gap-2">
                <input className={cn(input, 'flex-1')} placeholder="Project name" value={projName} onChange={(e) => setProjName(e.target.value)} />
                <input className={input} type="date" value={projDeadline} onChange={(e) => setProjDeadline(e.target.value)} />
                <button onClick={createProject} className="rounded-lg px-3 text-xs font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                  Create
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setShowNewProject(true); setProjName(''); setProjDeadline(''); }}
                className={cn('flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-3 text-xs', colors.panelBorder, colors.textMuted)}
              >
                <Plus size={14} /> New Project
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
