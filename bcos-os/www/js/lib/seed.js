// First-run content, laid out around today so every app has something to show.
// Delete any of it freely; it's ordinary data.

import { putMany, put, DEFAULT_SETTINGS } from './store.js';
import { uid } from './util.js';
import { startOfDay, addDays, dayKey, HOUR, MINUTE, DAY } from './date.js';

export function seed() {
  const today = startOfDay(new Date());
  const at = (dayOffset, h, m = 0) => addDays(today, dayOffset).getTime() + h * HOUR + m * MINUTE;
  const key = (offset) => dayKey(addDays(today, offset));

  // --- calendar ------------------------------------------------------------
  const cal = { personal: 'cal-personal', school: 'cal-school', health: 'cal-health', social: 'cal-social' };
  putMany('calendars', [
    { id: cal.personal, name: 'Personal', color: '#3b82f6', visible: true, kind: 'local', order: 0 },
    { id: cal.school, name: 'School', color: '#a855f7', visible: true, kind: 'local', order: 1 },
    { id: cal.health, name: 'Health', color: '#22c55e', visible: true, kind: 'local', order: 2 },
    { id: cal.social, name: 'Social', color: '#ec4899', visible: true, kind: 'local', order: 3 },
  ]);

  const wd = today.getDay();
  putMany('events', [
    { id: uid('e'), calendarId: cal.health, title: 'Morning run', start: at(0, 7), end: at(0, 7, 45), location: 'River trail', recurrence: { freq: 'week', interval: 1, days: [1, 3, 5].includes(wd) ? [1, 3, 5] : [wd, (wd + 2) % 7, (wd + 4) % 7].sort() } },
    { id: uid('e'), calendarId: cal.personal, title: 'Deep work: BCOS', start: at(0, 10), end: at(0, 12), notes: 'Calendar drag-and-drop, then widgets.' },
    { id: uid('e'), calendarId: cal.social, title: 'Lunch with Sam', start: at(0, 12, 30), end: at(0, 13, 30), location: 'Café Lumière' },
    { id: uid('e'), calendarId: cal.school, title: 'Study group', start: at(0, 16), end: at(0, 17, 30), location: 'Library, room 204' },
    { id: uid('e'), calendarId: cal.school, title: 'Physics lecture', start: at(1, 9), end: at(1, 10, 30), location: 'Hall B', recurrence: { freq: 'week', interval: 1, days: [(wd + 1) % 7] } },
    { id: uid('e'), calendarId: cal.health, title: 'Dentist', start: at(1, 14), end: at(1, 14, 45), location: 'Northside Dental' },
    { id: uid('e'), calendarId: cal.school, title: 'Chemistry lab', start: at(2, 13), end: at(2, 15) },
    { id: uid('e'), calendarId: cal.personal, title: 'Piano lesson', start: at(3, 17), end: at(3, 18), recurrence: { freq: 'week', interval: 1, days: [(wd + 3) % 7] } },
    { id: uid('e'), calendarId: cal.social, title: 'Movie night', start: at(3, 19, 30), end: at(3, 22), location: 'Jordan’s place' },
    { id: uid('e'), calendarId: cal.personal, title: 'Weekend trip', start: at(5, 0), end: at(7, 0), allDay: true, location: 'Tofino' },
    { id: uid('e'), calendarId: cal.personal, title: 'Mom’s birthday', start: at(9, 0), end: at(10, 0), allDay: true, recurrence: { freq: 'year', interval: 1 } },
    { id: uid('e'), calendarId: cal.personal, title: 'Groceries', start: at(-1, 11), end: at(-1, 11, 45) },
    { id: uid('e'), calendarId: cal.school, title: 'History essay due', start: at(-2, 0), end: at(-1, 0), allDay: true },
  ]);

  // --- tasks ----------------------------------------------------------------
  const list = { personal: 'list-personal', school: 'list-school', groceries: 'list-groceries', ideas: 'list-ideas' };
  putMany('lists', [
    { id: list.personal, name: 'Personal', color: '#f2783c', icon: 'home', view: 'list', sort: 'manual', order: 0 },
    { id: list.school, name: 'School', color: '#8b5cf6', icon: 'graduation', view: 'board', sort: 'manual', order: 1 },
    { id: list.groceries, name: 'Groceries', color: '#22c55e', icon: 'cart', view: 'list', sort: 'manual', order: 2 },
    { id: list.ideas, name: 'BCOS ideas', color: '#3b82f6', icon: 'sparkle', view: 'list', sort: 'priority', order: 3 },
  ]);

  let order = 0;
  const t = (listId, title, extra = {}) => ({
    id: uid('t'), listId, title, notes: '', due: null, dueTime: null, priority: 0, status: 'todo', done: false,
    subtasks: [], tags: [], repeat: null, order: order++, ...extra,
  });
  const sub = (title, done = false) => ({ id: uid('s'), title, done });
  putMany('tasks', [
    t(list.school, 'Finish physics problem set', { due: key(0), priority: 3, status: 'doing', notes: 'Chapter 6, questions 1–12. Show working for 9–12.', subtasks: [sub('Questions 1–4', true), sub('Questions 5–8', true), sub('Questions 9–12')] }),
    t(list.school, 'Email Ms. Chen about the project topic', { due: key(0), priority: 1 }),
    t(list.school, 'Read chapter 7 — organic chemistry', { due: key(1), priority: 2 }),
    t(list.school, 'Outline history presentation', { due: key(4), priority: 2, subtasks: [sub('Pick three sources'), sub('Draft slide order'), sub('Practice run')] }),
    t(list.school, 'Submit history essay', { due: key(-2), priority: 3, done: true, status: 'done', doneAt: at(-2, 21) }),
    t(list.personal, 'Renew library card', { due: key(-1), priority: 1 }),
    t(list.personal, 'Book dentist follow-up', { due: key(3) }),
    t(list.personal, 'Plan the weekend trip', { due: key(4), priority: 2, subtasks: [sub('Check ferry times', true), sub('Pack list'), sub('Book campsite')] }),
    t(list.personal, 'Water the plants', { due: key(0), repeat: 'weekly' }),
    t(list.personal, 'Back up phone photos to the Umbrel', {}),
    t(list.groceries, 'Oat milk'), t(list.groceries, 'Eggs'), t(list.groceries, 'Spinach'),
    t(list.groceries, 'Coffee beans', { done: true, status: 'done', doneAt: at(-1, 18) }),
    t(list.ideas, 'Connect a real mail account (IMAP/SMTP)', { priority: 3 }),
    t(list.ideas, 'Two-way sync with iCloud Calendar', { priority: 2 }),
    t(list.ideas, 'Home Assistant widget on the home screen', { priority: 2 }),
    t(list.ideas, 'Photo memories in the journal', { priority: 1 }),
  ]);

  const log = (pattern) => {
    const out = {};
    for (let i = 1; i <= 21; i++) if (pattern(i)) out[key(-i)] = 1;
    return out;
  };
  putMany('habits', [
    { id: uid('h'), name: 'Drink water', emoji: '💧', color: '#3b82f6', freq: 'daily', order: 0, log: { ...log((i) => i % 6 !== 0), [key(0)]: 1 } },
    { id: uid('h'), name: 'Read 20 min', emoji: '📖', color: '#f2783c', freq: 'daily', order: 1, log: log((i) => i < 6 || i % 3 === 0) },
    { id: uid('h'), name: 'Exercise', emoji: '🏃', color: '#22c55e', freq: 'weekly', target: 3, order: 2, log: log((i) => i % 2 === 1) },
    { id: uid('h'), name: 'Meditate', emoji: '🧘', color: '#a855f7', freq: 'daily', order: 3, log: log((i) => i % 4 === 1 || i === 2) },
  ]);

  // --- notes ----------------------------------------------------------------
  const folders = { personal: 'fold-personal', school: 'fold-school', ideas: 'fold-ideas' };
  putMany('folders', [
    { id: folders.personal, name: 'Personal', color: '#f2783c', order: 0 },
    { id: folders.school, name: 'School', color: '#8b5cf6', order: 1 },
    { id: folders.ideas, name: 'Ideas', color: '#3b82f6', order: 2 },
  ]);
  const welcomeId = 'note-welcome';
  const note = (id, folderId, title, html, extra = {}) => ({
    id, folderId, title, html, text: html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(),
    tags: [...new Set([...html.replace(/<[^>]+>/g, ' ').matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase()))],
    pinned: false, trashed: false, ...extra,
  });
  putMany('notes', [
    note(welcomeId, null, 'Welcome to Notes', `
<p>Notes is a proper writing tool. Everything here is live — try it.</p>
<h2>Write the way you think</h2>
<ul><li>Type <code>/</code> at the start of a line for headings, lists, quotes, code and more.</li><li>Markdown works as you type: <code>#</code> for a heading, <code>-</code> for a list, <code>[]</code> for a checklist, <code>&gt;</code> for a quote.</li><li>Select text for <strong>bold</strong>, <em>italic</em>, <mark>highlight</mark>, <s>strike</s>, <code>code</code> and links.</li></ul>
<h2>Checklists</h2>
<ul class="checklist"><li data-checked="true">Click a box to tick it off</li><li data-checked="false">Press Enter for the next item</li><li data-checked="false">Press Enter on an empty item to finish the list</li></ul>
<h2>Connect your thinking</h2>
<p>Type <code>[[</code> to link another note — like <a data-note="note-roadmap" href="#">BCOS roadmap</a>. Links show up at the bottom of the note they point to. Add #tags anywhere and they appear in the sidebar.</p>
<blockquote>Paste or drop an image straight into a note. Long notes get a contents outline on the right.</blockquote>
<h3>Shortcuts</h3>
<pre><code>⌘B bold     ⌘I italic     ⌘U underline
⌘K link     ⌘⇧H highlight ⌘E code
⌘⇧7 numbered list         ⌘⇧8 bullet list
⌘⇧9 checklist             ⌥⌘1–3 headings</code></pre>`, { pinned: true }),
    note('note-roadmap', folders.ideas, 'BCOS roadmap', `
<p>Where this OS is going next. #bcos</p>
<h2>Now</h2>
<ul class="checklist"><li data-checked="true">Home screen, dock and search</li><li data-checked="true">Calendar, Tasks, Notes, Journal, Mail</li><li data-checked="false">Real mail accounts over IMAP</li></ul>
<h2>Later</h2>
<ol><li>iCloud calendar sync</li><li>Home Assistant controls as a widget</li><li>Photo memories in the journal</li></ol>
<p>See <a data-note="${welcomeId}" href="#">Welcome to Notes</a> for how linking works.</p>`),
    note(uid('n'), folders.school, 'Physics — chapter 6 summary', `
<p>Work, energy and power. #physics #exam</p>
<h2>Key ideas</h2>
<ul><li><strong>Work</strong> is force times displacement in the direction of the force.</li><li><strong>Kinetic energy</strong> grows with the square of speed.</li><li>Energy is conserved when only conservative forces act.</li></ul>
<pre><code>W  = F · d · cos θ
KE = ½ m v²
PE = m g h
P  = W / t</code></pre>
<blockquote>Check units first. Most marks lost last test were unit mistakes.</blockquote>`),
    note(uid('n'), folders.personal, 'Weekend trip — Tofino', `
<p>Leaving Saturday morning. #travel</p>
<h2>Pack</h2>
<ul class="checklist"><li data-checked="true">Rain jacket</li><li data-checked="false">Camera + spare battery</li><li data-checked="false">Snacks for the ferry</li><li data-checked="false">Sleeping bag</li></ul>
<h2>Ideas</h2>
<ul><li>Sunrise at Chesterman Beach</li><li>Rainforest trail loop</li><li>Tacos at the surf shop</li></ul>`),
    note(uid('n'), folders.personal, 'Books to read', `
<p>#reading</p>
<ol><li><em>Project Hail Mary</em> — Andy Weir</li><li><em>The Design of Everyday Things</em> — Don Norman</li><li><em>Piranesi</em> — Susanna Clarke</li></ol>`),
  ].map((n, i) => ({ ...n, createdAt: Date.now() - (i + 1) * 5 * HOUR, updatedAt: Date.now() - i * 5 * HOUR - 4 * MINUTE })), { touch: false });

  // --- journal ----------------------------------------------------------------
  putMany('journal', [
    { id: key(-1), mood: 4, activities: ['study', 'friends', 'music'], text: 'Long study session with the group, then pizza. Finally understood the energy problems — drawing the diagrams first made all the difference.\n\nWant to get to bed earlier this week.' },
    { id: key(-2), mood: 5, activities: ['exercise', 'outside', 'creative'], text: 'Ran the river trail before sunrise. The fog was sitting in the valley like a lake. Spent the afternoon building the BCOS home screen and it already feels like mine.' },
    { id: key(-3), mood: 3, activities: ['work', 'rest'], text: 'Slow day. Submitted the history essay and mostly recovered after.' },
    { id: key(-5), mood: 4, activities: ['family', 'reading'], text: 'Dinner at home. Started Piranesi — strange and beautiful so far.' },
  ].map((e) => ({ ...e, date: e.id })));

  // --- mail -------------------------------------------------------------------
  const me = { name: 'Beckett Clarke', email: 'beckett@bcos.local' };
  putMany('mail', [
    { id: uid('m'), mailbox: 'inbox', read: false, starred: false, date: Date.now() - 20 * MINUTE, from: { name: 'BCOS', email: 'hello@bcos.local' }, to: [me],
      subject: 'Welcome to your new OS',
      body: `Hi Beckett,\n\nBCOS is up and running on your Umbrel. A few things worth knowing:\n\n• Press ⌘K anywhere to search everything, or just start typing on the home screen.\n• Pull an app down by its top edge to close it, or press Esc.\n• Your data lives on the Umbrel, so it's the same on your phone and your laptop.\n• Settings lets you pick a wallpaper, accent colour and which widgets you see.\n\nThis mailbox is local for now — connecting a real account is on the roadmap.\n\n— BCOS` },
    { id: uid('m'), mailbox: 'inbox', read: false, starred: false, date: Date.now() - 2 * HOUR, from: { name: 'Sam Rivera', email: 'sam@example.com' }, to: [me],
      subject: 'Lunch today?', body: 'Still on for 12:30 at Café Lumière? I can grab a table if I get there first.\n\nAlso — did you finish the physics set? Question 9 is wrecking me.\n\nSam' },
    { id: uid('m'), mailbox: 'inbox', read: true, starred: true, date: Date.now() - DAY - 3 * HOUR, from: { name: 'Ms. Chen', email: 'chen@school.example.com' }, to: [me],
      subject: 'Project rubric and topic deadline', body: 'Hi everyone,\n\nThe rubric for the final project is now posted. Please send me your proposed topic by Friday so I can approve it before the long weekend.\n\nRemember: one primary source minimum.\n\nBest,\nMs. Chen' },
    { id: uid('m'), mailbox: 'inbox', read: true, starred: false, date: Date.now() - 2 * DAY, from: { name: 'Umbrel', email: 'notifications@umbrel.local' }, to: [me],
      subject: 'Your Umbrel is up to date', body: 'umbrelOS is running the latest version. All apps are healthy.\n\nUptime: 10 days\nStorage: 102 GB of 972 GB used' },
    { id: uid('m'), mailbox: 'inbox', read: true, starred: false, date: Date.now() - 4 * DAY, from: { name: 'Jordan Lee', email: 'jordan@example.com' }, to: [me],
      subject: 'Movie night this week', body: 'Thinking Thursday, my place, 7:30. You pick the movie this time — no more three-hour documentaries.\n\nJ' },
    { id: uid('m'), mailbox: 'sent', read: true, starred: false, date: Date.now() - 4 * DAY + 2 * HOUR, from: me, to: [{ name: 'Jordan Lee', email: 'jordan@example.com' }],
      subject: 'Re: Movie night this week', body: 'Thursday works. I’m picking something with at least one explosion.\n\nB' },
    { id: uid('m'), mailbox: 'archive', read: true, starred: false, date: Date.now() - 12 * DAY, from: { name: 'Northside Dental', email: 'appointments@dental.example.com' }, to: [me],
      subject: 'Appointment confirmed', body: 'Your appointment is confirmed. Reply to this email if you need to reschedule.' },
  ]);

  put('settings', { ...DEFAULT_SETTINGS });
}
