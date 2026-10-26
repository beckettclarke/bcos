// The built-in apps. Each one is loaded the first time it's opened.

import { CalendarGlyph, MailGlyph, JournalGlyph, NotesGlyph, TasksGlyph, SettingsGlyph } from '../ui/icons.js';

export const APPS = [
  { id: 'calendar', name: 'Calendar', glyph: CalendarGlyph, load: () => import('../apps/calendar.js') },
  { id: 'tasks', name: 'Tasks', glyph: TasksGlyph, load: () => import('../apps/tasks.js') },
  { id: 'notes', name: 'Notes', glyph: NotesGlyph, load: () => import('../apps/notes.js') },
  { id: 'journal', name: 'Journal', glyph: JournalGlyph, load: () => import('../apps/journal.js') },
  { id: 'mail', name: 'Mail', glyph: MailGlyph, load: () => import('../apps/mail.js') },
  { id: 'settings', name: 'Settings', glyph: SettingsGlyph, load: () => import('../apps/settings.js') },
];

export const appById = (id) => APPS.find((a) => a.id === id);
