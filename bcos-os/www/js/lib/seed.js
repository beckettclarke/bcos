// First run: start empty. The only thing created is one calendar, so there's
// somewhere for new events to go.
//
// Earlier versions filled every app with sample content. `removePlaceholders`
// clears that out of existing installs once, matching each sample item on
// where it lives and what it's called, so anything you made yourself stays.

import { put, remove, all, get, settings, setSettings, DEFAULT_SETTINGS } from './store.js';

const DEFAULT_CALENDAR = { id: 'cal-default', name: 'Calendar', color: '#3b82f6', visible: true, kind: 'local', order: 0 };

export function seed() {
  put('calendars', DEFAULT_CALENDAR);
  put('settings', { ...DEFAULT_SETTINGS, placeholdersCleared: true });
}

// --- the sample content older versions created ----------------------------------

const OLD = {
  calendars: ['cal-personal', 'cal-school', 'cal-health', 'cal-social'],
  lists: ['list-personal', 'list-school', 'list-groceries', 'list-ideas'],
  folders: ['fold-personal', 'fold-school', 'fold-ideas'],
  notes: ['note-welcome', 'note-roadmap'],
  events: ['Morning run', 'Deep work: BCOS', 'Lunch with Sam', 'Study group', 'Physics lecture', 'Dentist', 'Chemistry lab', 'Piano lesson', 'Movie night', 'Weekend trip', 'Mom’s birthday', 'Groceries', 'History essay due'],
  tasks: ['Finish physics problem set', 'Email Ms. Chen about the project topic', 'Read chapter 7 — organic chemistry', 'Outline history presentation', 'Submit history essay', 'Renew library card', 'Book dentist follow-up', 'Plan the weekend trip', 'Water the plants', 'Back up phone photos to the Umbrel', 'Oat milk', 'Eggs', 'Spinach', 'Coffee beans', 'Connect a real mail account (IMAP/SMTP)', 'Two-way sync with iCloud Calendar', 'Home Assistant widget on the home screen', 'Photo memories in the journal'],
  habits: ['💧 Drink water', '📖 Read 20 min', '🏃 Exercise', '🧘 Meditate'],
  noteTitles: ['Physics — chapter 6 summary', 'Weekend trip — Tofino', 'Books to read'],
  journal: ['Long study session with the group', 'Ran the river trail before sunrise', 'Slow day. Submitted the history essay', 'Dinner at home. Started Piranesi'],
  mail: ['hello@bcos.local', 'sam@example.com', 'chen@school.example.com', 'notifications@umbrel.local', 'jordan@example.com', 'appointments@dental.example.com', 'beckett@bcos.local'],
};

export function removePlaceholders() {
  if (settings().placeholdersCleared) return;
  const drop = (name, test) => all(name).filter(test).forEach((x) => remove(name, x.id));

  drop('events', (e) => OLD.calendars.includes(e.calendarId) && OLD.events.includes(e.title));
  drop('tasks', (t) => OLD.lists.includes(t.listId) && OLD.tasks.includes(t.title));
  drop('habits', (h) => OLD.habits.includes(`${h.emoji} ${h.name}`));
  drop('notes', (n) => OLD.notes.includes(n.id) || (OLD.folders.includes(n.folderId) && OLD.noteTitles.includes(n.title)));
  drop('journal', (j) => OLD.journal.some((start) => (j.text || '').startsWith(start)));
  drop('mail', (m) => !m.account && (OLD.mail.includes(m.from?.email) && (m.to || []).every((t) => OLD.mail.includes(t.email))));

  // The sample calendars, lists and folders go too, unless you've put your own things in them.
  const used = (name, key, id) => all(name).some((x) => x[key] === id);
  OLD.calendars.forEach((id) => { if (get('calendars', id) && !used('events', 'calendarId', id)) remove('calendars', id); });
  OLD.lists.forEach((id) => { if (get('lists', id) && !used('tasks', 'listId', id)) remove('lists', id); });
  OLD.folders.forEach((id) => { if (get('folders', id) && !used('notes', 'folderId', id) && !used('folders', 'parentId', id)) remove('folders', id); });
  if (!all('calendars').some((c) => c.kind !== 'feed')) put('calendars', DEFAULT_CALENDAR);

  setSettings({ placeholdersCleared: true });
}
