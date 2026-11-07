// Command Center MCP endpoint — JSON-RPC 2.0 protocol for Agent SDK
// Exposes all command center tools as MCP tools callable by the companion in chat
import { Router } from 'express';
import * as cc from '../services/cc.js';
import { getConfig, setConfig } from '../services/db.js';
import { getBytelightConfig } from '../config.js';
import { today } from '../util/time.js';

const router = Router();

// Tool definitions — what the companion sees when the agent lists tools
const TOOLS = [
  {
    name: 'cc_status',
    description: 'Dashboard overview: tasks, events, care, cycle, pets, countdowns, wins. Call with no arguments for a full summary.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cc_task',
    description: 'Manage tasks. Actions: add, list, complete, update, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'complete', 'update', 'delete'], description: 'Action to perform' },
        id: { type: 'string', description: 'Task ID (for complete/update/delete)' },
        text: { type: 'string', description: 'Task text (for add, or partial match for complete)' },
        project: { type: 'string', description: 'Project name (auto-creates if new)' },
        date: { type: 'string', description: 'Date scope YYYY-MM-DD' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD' },
        priority: { type: 'number', description: '0=normal, 1=high, 2=urgent' },
        status: { type: 'string', description: 'Filter: active, completed, all' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_project',
    description: 'Manage projects. Actions: add, list, update, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'update', 'delete'], description: 'Action' },
        id: { type: 'string', description: 'Project ID (for update/delete)' },
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string' },
        owner: { type: 'string' },
        deadline: { type: 'string', description: 'YYYY-MM-DD' },
        color: { type: 'string', description: 'Hex color' },
        status: { type: 'string', description: 'active, completed, all' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_care',
    description: 'Track wellness: meals, sleep, energy, mood, water, movement, medication.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'get', 'history'], description: 'Action' },
        person: { type: 'string', description: 'Person name' },
        category: { type: 'string', description: 'Category: breakfast, lunch, dinner, snacks, medication, movement, shower, sleep, energy, wellbeing, mood, water' },
        value: { type: 'string', description: 'true/false for toggles, 1-5 for ratings, 0-10 for water' },
        note: { type: 'string', description: 'Optional note (JSON array for stacking)' },
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
        days: { type: 'number', description: 'History lookback days (default: 7)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_event',
    description: 'Manage calendar events. Actions: add, list, update, delete. Supports recurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'update', 'delete'], description: 'Action' },
        id: { type: 'string', description: 'Event ID (for update/delete)' },
        title: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM' },
        end_date: { type: 'string' },
        end_time: { type: 'string' },
        category: { type: 'string', description: 'default, work, personal, health, home' },
        description: { type: 'string' },
        recurrence: { type: 'string', description: 'JSON: {type:"weekly"|"monthly"|"yearly", interval:1}' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_cycle',
    description: 'Cycle tracking: status, predictions, period logging, daily symptom logging.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'history', 'predict', 'start_period', 'end_period', 'log'], description: 'Action' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        flow: { type: 'string', description: 'none, spotting, light, medium, heavy' },
        symptoms: { type: 'string' },
        mood: { type: 'string' },
        energy: { type: 'number', description: '1-5' },
        notes: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_pet',
    description: 'Pet care: profiles, events, medications, upcoming care alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'update', 'log', 'med_add', 'med_given', 'upcoming'], description: 'Action' },
        id: { type: 'string', description: 'Pet ID (for update)' },
        pet_name: { type: 'string' },
        name: { type: 'string', description: 'Pet name (add) or medication name' },
        species: { type: 'string' },
        breed: { type: 'string' },
        birthday: { type: 'string' },
        weight: { type: 'string' },
        notes: { type: 'string' },
        event_type: { type: 'string', description: 'vet, vaccination, grooming, weight_check, note' },
        title: { type: 'string' },
        dosage: { type: 'string' },
        frequency: { type: 'string', description: 'daily, weekly, monthly, quarterly, yearly, as_needed' },
        days: { type: 'number', description: 'Upcoming lookback days (default 7)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_list',
    description: 'Manage lists and items. Actions: create, view, add, check, delete, clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'view', 'list_all', 'add', 'check', 'delete_list', 'delete_item', 'clear'], description: 'Action' },
        list_id: { type: 'string' },
        list_name: { type: 'string', description: 'Alternative to list_id' },
        name: { type: 'string', description: 'New list name (for create)' },
        items: { type: 'array', items: { type: 'string' }, description: 'Items to add' },
        item: { type: 'string', description: 'Single item to add' },
        item_id: { type: 'string', description: 'For check/delete_item' },
        checked: { type: 'boolean', description: 'Toggle state (default true)' },
        all: { type: 'boolean', description: 'Clear all items (default: only checked)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_expense',
    description: 'Track expenses. Actions: add, list, stats.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'stats'], description: 'Action' },
        amount: { type: 'number' },
        category: { type: 'string', description: 'groceries, bills, dining, transport, entertainment, health, home, other' },
        description: { type: 'string' },
        paid_by: { type: 'string' },
        date: { type: 'string' },
        period: { type: 'string', description: 'week, month, year (for stats)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_countdown',
    description: 'Manage countdowns. Actions: add, list, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'delete'], description: 'Action' },
        id: { type: 'string', description: 'Countdown ID (for delete)' },
        title: { type: 'string' },
        target_date: { type: 'string', description: 'YYYY-MM-DD' },
        emoji: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_daily_win',
    description: 'Log the daily win. One per person per day.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What was today\'s win?' },
        who: { type: 'string', description: 'Person (default: configured default person)' },
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'cc_scratchpad',
    description: 'Persistent scratchpad — notes and tasks stay until removed. Actions: status (view all), add_note, add_task, add_event, remove_note, remove_task, clear_notes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'add_note', 'add_task', 'add_event', 'remove_note', 'remove_task', 'clear_notes'], description: 'Action' },
        text: { type: 'string', description: 'Note/task text or event title (for add_note/add_task/add_event)' },
        id: { type: 'string', description: 'Note or task ID (for remove_note/remove_task)' },
        start_date: { type: 'string', description: 'Event date YYYY-MM-DD (for add_event, default: today)' },
        start_time: { type: 'string', description: 'Event time HH:MM (for add_event)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'cc_presence',
    description: 'Get or set availability status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'Action' },
        emoji: { type: 'string', description: 'Status emoji' },
        label: { type: 'string', description: 'Status label' },
      },
      required: ['action'],
    },
  },
];

// --- Tool dispatch ---

function handleTool(name: string, args: any): string {
  const config = getBytelightConfig();
  const currency = config.command_center.currency_symbol;
  const defaultPerson = config.command_center.default_person;

  switch (name) {
    case 'cc_status':
      return cc.getCcStatus();

    case 'cc_task': {
      const a = args.action;
      if (a === 'add') {
        const task = cc.addTask({ text: args.text, project: args.project, date: args.date, due_date: args.due_date, priority: args.priority, created_by: args.created_by });
        return `Task added: ${task.text} (${task.id})`;
      }
      if (a === 'list') {
        const tasks = cc.listTasks({ status: args.status, project: args.project, date: args.date, due_before: args.due_before, carry_forward: !!args.date });
        if (tasks.length === 0) return 'No tasks found.';
        return tasks.map(t => `${t.priority > 0 ? '!' : ' '} [${t.status === 'completed' ? 'x' : ' '}] ${t.text}${t.project_name ? ` (${t.project_name})` : ''}${t.due_date ? ` due ${t.due_date}` : ''}`).join('\n');
      }
      if (a === 'complete') return cc.completeTask(args.id, args.text);
      if (a === 'update') { cc.updateTask(args.id, args); return `Task updated.`; }
      if (a === 'delete') { cc.updateTask(args.id, { status: 'deleted' }); return 'Task deleted.'; }
      return 'Unknown action. Use: add, list, complete, update, delete.';
    }

    case 'cc_project': {
      const a = args.action;
      if (a === 'add') { const p = cc.addProject(args); return `Project created: ${p.name} (${p.id})`; }
      if (a === 'list') {
        const projs = cc.listProjects(args.status);
        if (projs.length === 0) return 'No projects.';
        return projs.map(p => `${p.name} — ${p.active_tasks} active tasks${p.deadline ? `, due ${p.deadline}` : ''}`).join('\n');
      }
      if (a === 'update') { cc.updateProject(args.id, args); return 'Project updated.'; }
      if (a === 'delete') { cc.deleteProject(args.id); return 'Project deleted.'; }
      return 'Unknown action.';
    }

    case 'cc_care': {
      const a = args.action;
      if (a === 'set') {
        const entry = cc.upsertCareEntry({ date: args.date, person: args.person, category: args.category, value: args.value, note: args.note });
        return `Care logged: ${entry.person} ${entry.category} = ${entry.value || ''}${entry.note ? ' (note)' : ''}`;
      }
      if (a === 'get') {
        const entries = cc.getCareEntries(args.date || today(), args.person);
        if (entries.length === 0) return 'No care entries for this day.';
        return entries.map(e => `${e.person} ${e.category}: ${e.value || '-'}${e.note ? ' [has notes]' : ''}`).join('\n');
      }
      if (a === 'history') {
        const entries = cc.getCareHistory(args.person || defaultPerson, args.days || 7);
        if (entries.length === 0) return 'No care history.';
        return entries.map(e => `${e.date} ${e.category}: ${e.value || '-'}`).join('\n');
      }
      return 'Unknown action. Use: set, get, history.';
    }

    case 'cc_event': {
      const a = args.action;
      if (a === 'add') { const e = cc.addEvent(args); return `Event added: ${e.title} on ${e.start_date} (${e.id})`; }
      if (a === 'list') {
        const events = cc.listEvents(args);
        if (events.length === 0) return 'No events found.';
        return events.map(e => `${e.start_date} ${e.start_time || 'all day'} — ${e.title} (${e.category})`).join('\n');
      }
      if (a === 'update') { cc.updateEvent(args.id, args); return 'Event updated.'; }
      if (a === 'delete') { cc.deleteEvent(args.id); return 'Event deleted.'; }
      return 'Unknown action.';
    }

    case 'cc_cycle': {
      const a = args.action;
      if (a === 'status') {
        const s = cc.getCycleStatus();
        if (s.noData) return 'No cycle data yet.';
        return `Day ${s.cycleDay} (${s.phase}). ${s.onPeriod ? 'On period.' : `Next period in ~${s.daysUntilPeriod} days.`}${s.inPMSWindow ? ' PMS window.' : ''}`;
      }
      if (a === 'history') {
        const cycles = cc.getCycleHistory(args.limit || 6);
        return cycles.map(c => `${c.start_date} — ${c.end_date || 'ongoing'}${c.notes ? ': ' + c.notes : ''}`).join('\n') || 'No history.';
      }
      if (a === 'predict') {
        const p = cc.getCyclePredict();
        if (p.error) return p.error;
        return `Next period: ${p.nextPeriod}\nOvulation: ${p.ovulation}\nFertile: ${p.fertileWindow.start} — ${p.fertileWindow.end}\nPMS: ${p.pmsWindow.start} — ${p.pmsWindow.end}`;
      }
      if (a === 'start_period') return cc.startPeriod(args.date, args.notes);
      if (a === 'end_period') return cc.endPeriod(args.date);
      if (a === 'log') return cc.logCycleDaily(args);
      return 'Unknown action.';
    }

    case 'cc_pet': {
      const a = args.action;
      if (a === 'add') { const p = cc.addPet(args); return `Pet added: ${(p as any).name}`; }
      if (a === 'list') {
        const pets = cc.listPets();
        return pets.map((p: any) => `${p.name}${p.species ? ` (${p.species})` : ''}${p.birthday ? `, born ${p.birthday}` : ''}`).join('\n') || 'No pets.';
      }
      if (a === 'update') { cc.updatePet(args.id, args); return 'Pet updated.'; }
      if (a === 'log') return cc.logPetEvent(args);
      if (a === 'med_add') return cc.addPetMedication(args);
      if (a === 'med_given') return cc.markMedGiven(args);
      if (a === 'upcoming') {
        const items = cc.upcomingPetCare(args.days || 7);
        return items.map((i: any) => `${i.pet}: ${i.name} (${i.type}) — ${i.overdue ? 'OVERDUE' : i.isToday ? 'TODAY' : i.due}`).join('\n') || 'No upcoming care.';
      }
      return 'Unknown action.';
    }

    case 'cc_list': {
      const a = args.action;
      if (a === 'create') { const l = cc.createList({ name: args.name, icon: args.icon, color: args.color }); return `List created: ${(l as any).name}`; }
      if (a === 'list_all') {
        const lists = cc.getAllLists();
        return lists.map((l: any) => `${l.name}: ${l.unchecked_count}/${l.item_count} items`).join('\n') || 'No lists.';
      }
      if (a === 'view') {
        const list = cc.getListWithItems(args.list_id, args.list_name);
        if (!list) return 'List not found.';
        const items = (list.items || []).map((i: any) => `${i.checked ? '[x]' : '[ ]'} ${i.text}`).join('\n');
        return `${list.name}\n${items || '(empty)'}`;
      }
      if (a === 'add') {
        const id = args.list_id || (() => { const l = cc.getListWithItems(undefined, args.list_name); return l?.id; })();
        if (!id) return 'List not found.';
        const items = args.items || (args.item ? [args.item] : []);
        const count = cc.addListItems(id, items, args.added_by);
        return `Added ${count} item(s).`;
      }
      if (a === 'check') { cc.checkListItem(args.item_id, args.checked ?? true); return 'Item updated.'; }
      if (a === 'delete_list') { cc.deleteLst(args.list_id); return 'List deleted.'; }
      if (a === 'delete_item') { cc.deleteListItem(args.item_id); return 'Item deleted.'; }
      if (a === 'clear') {
        const id = args.list_id || (() => { const l = cc.getListWithItems(undefined, args.list_name); return l?.id; })();
        if (!id) return 'List not found.';
        const count = cc.clearListItems(id, args.all);
        return `Cleared ${count} item(s).`;
      }
      return 'Unknown action.';
    }

    case 'cc_expense': {
      const a = args.action;
      if (a === 'add') { cc.addExpense(args); return `Expense logged: ${currency}${args.amount} (${args.category || 'other'})`; }
      if (a === 'list') {
        const { expenses, total } = cc.listExpenses(args);
        if (expenses.length === 0) return 'No expenses.';
        return expenses.map((e: any) => `${e.date} ${currency}${e.amount.toFixed(2)} ${e.category} — ${e.description || ''}`).join('\n') + `\nTotal: ${currency}${total.toFixed(2)}`;
      }
      if (a === 'stats') {
        const s = cc.getExpenseStats(args.period);
        return `${s.period}: ${currency}${s.total.toFixed(2)} total, ${currency}${s.dailyAverage.toFixed(2)}/day, ${s.count} entries\n` +
          (s.byCategory || []).map((c: any) => `  ${c.category}: ${currency}${c.total.toFixed(2)}`).join('\n');
      }
      return 'Unknown action.';
    }

    case 'cc_countdown': {
      const a = args.action;
      if (a === 'add') { cc.addCountdown(args); return `Countdown added: ${args.title} (${args.target_date})`; }
      if (a === 'list') {
        const cds = cc.listCountdowns();
        return cds.map((c: any) => `${c.emoji || ''} ${c.title} — ${c.days_until === 0 ? 'TODAY' : c.days_until > 0 ? c.days_until + ' days' : Math.abs(c.days_until) + ' days ago'}`).join('\n') || 'No countdowns.';
      }
      if (a === 'delete') { cc.deleteCountdown(args.id); return 'Countdown deleted.'; }
      return 'Unknown action.';
    }

    case 'cc_daily_win':
      cc.upsertDailyWin({ text: args.text, who: args.who, date: args.date });
      return `Win logged for ${args.who || defaultPerson}: ${args.text}`;

    case 'cc_scratchpad': {
      const a = args.action;
      const companionName = config.identity.companion_name.toLowerCase();
      if (a === 'status') {
        const data = cc.getScratchpad();
        const lines: string[] = ['**Scratchpad**'];
        if (data.events.length > 0) {
          lines.push('**Today\'s events:**');
          data.events.forEach((e: any) => lines.push(`  ${e.start_time || 'all day'} — ${e.title}${e.created_by ? ' (' + e.created_by + ')' : ''}`));
        }
        if (data.tasks.length > 0) {
          lines.push('**Tasks:**');
          data.tasks.forEach((t: any) => lines.push(`  [ ] ${t.text}${t.created_by ? ' (' + t.created_by + ')' : ''}`));
        }
        if (data.notes.length > 0) {
          lines.push('**Notes:**');
          data.notes.forEach((n: any) => lines.push(`  • ${n.text} (${n.created_by})`));
        }
        if (data.counts.events === 0 && data.counts.notes === 0 && data.counts.tasks === 0) {
          lines.push('Nothing on the scratchpad yet.');
        }
        lines.push(`\n${data.counts.events} events today, ${data.counts.tasks} tasks, ${data.counts.notes} notes`);
        return lines.join('\n');
      }
      if (a === 'add_note') {
        if (!args.text) return 'Error: text is required for add_note.';
        const note = cc.addScratchpadNote(args.text, companionName);
        return `Note added: "${note.text}" (${note.id})`;
      }
      if (a === 'add_task') {
        if (!args.text) return 'Error: text is required for add_task.';
        const task = cc.addTask({ text: args.text, created_by: companionName });
        return `Task added to scratchpad: "${task.text}" (${task.id})`;
      }
      if (a === 'add_event') {
        if (!args.text) return 'Error: text is required for add_event.';
        const todayDate = today();
        const event = cc.addEvent({ title: args.text, start_date: args.start_date || todayDate, start_time: args.start_time, created_by: companionName });
        return `Event added: "${event.title}" on ${event.start_date}${event.start_time ? ' at ' + event.start_time : ''} (${event.id})`;
      }
      if (a === 'remove_note') {
        if (!args.id) return 'Error: id is required for remove_note.';
        const ok = cc.deleteScratchpadNote(args.id);
        return ok ? 'Note removed.' : 'Note not found.';
      }
      if (a === 'remove_task') {
        if (!args.id) return 'Error: id is required for remove_task.';
        cc.updateTask(args.id, { status: 'deleted' });
        return 'Task removed.';
      }
      if (a === 'clear_notes') {
        const count = cc.clearScratchpadNotes();
        return `Cleared ${count} note(s).`;
      }
      return 'Unknown action. Use: status, add_note, add_task, remove_note, remove_task, clear_notes.';
    }

    case 'cc_presence': {
      if (args.action === 'get') {
        return JSON.stringify({
          emoji: getConfig('user_status_emoji') || '',
          label: getConfig('user_status_label') || '',
        });
      }
      if (args.action === 'set') {
        if (args.emoji) setConfig('user_status_emoji', args.emoji);
        if (args.label) setConfig('user_status_label', args.label);
        return `Status set: ${args.emoji || ''} ${args.label || ''}`;
      }
      return 'Unknown action. Use: get, set.';
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- MCP JSON-RPC endpoint ---

router.post('/', (req, res) => {
  const { jsonrpc, method, id, params } = req.body;

  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  // A notification (no id) gets 202 and no body, per the streamable HTTP spec.
  // Codex's strict client (rmcp) drops the server if it answers with a JSON-RPC body.
  if (id === undefined) return res.status(202).end();

  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'command-center', version: '1.0.0' },
          },
        });

      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

      case 'tools/call': {
        const { name, arguments: toolArgs } = params || {};
        const result = handleTool(name, toolArgs || {});
        return res.json({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: result }] },
        });
      }

      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err: any) {
    return res.json({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
    });
  }
});

export default router;
