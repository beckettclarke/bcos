<!-- Generated from IMPORT_GUIDE in www/js/apps/journal-import.js. In BCOS: Journal → Import → “Copy LLM instructions” always gives the current version. -->

# BCOS Journal import — instructions for an AI model

You are converting someone's personal journal into JSON for BCOS, their personal
journal app. Read every document they give you and answer with ONE JSON object in
the format below and nothing else (no prose, no code fences). Be faithful: never
invent events, foods, people or numbers. Keep their voice and wording in "body".

## Output format

{
  "format": "bcos.journal/1",
  "entries": [ Entry, Entry, ... ]   // one per day, oldest first
}

### Entry

| field   | type | notes |
| ------- | ---- | ----- |
| date    | "YYYY-MM-DD" | Required. Diarly exports usually put the date ONLY in the file name (e.g. "2026-10-25.md" or "October 25, 2026.md") — use it. Otherwise take it from a date heading in the document. If one document has several days, make one entry per day. |
| icon    | emoji | One emoji that sums up the day (🚣 regatta, ✈️ travel day, 🏫 normal school day, 🎂 birthday…). |
| title   | string | Short title only if the day had a main event ("Head of the Trent"). Otherwise "". |
| rating  | number | Day rating out of 5, halves allowed (4.5). Omit if not given. |
| mood    | string or 1–7 | One of: "very unpleasant", "unpleasant", "slightly unpleasant", "neutral", "slightly pleasant", "pleasant", "very pleasant" (1 = very unpleasant … 7 = very pleasant). Omit if not given. |
| people  | string[] | People they spent time with (first names, or Mum/Dad…). Never the writer. |
| tags    | string[] | Lower-case themes that are NOT already captured by a card (trip, regatta, sleepover, test, school…). No "#". |
| body    | Markdown | What happened, as they wrote it: "- " bullets, sub-bullets indented with a tab, "## " for a section heading, **bold** allowed. Remove the "Things that happened" heading, the food section, rating, tags and mood lines — those go in their own fields. Replace hashtags with plain words ("#lyft" → "Lyft", "#rowing/hanlan" → "rowing at Hanlan", "#house/jack" → "Jack's house"). |
| meals   | object | { "breakfast": Food[], "lunch": Food[], "dinner": Food[], "snacks": Food[] }. Use [] for "-" or missing meals. |
| cards   | Card[] | Structured moments — see below. Order them as they happened. |

### Food

{ "name": "Coke Zero", "qty": 1, "unit": "", "emoji": "🥤", "kind": "drink", "zero": true, "kcal": 0 }

- Split combined lines: "2 pancakes, 2 eggs and 3 strips of bacon with orange juice" → 4 items.
- name: short, Title Case, keep brands ("Jack Astor's Fries", "Gatorade Zero"). qty defaults to 1.
- unit only for counted portions ("strips", "slice", "bag", "pack").
- emoji: the single best food emoji. kind: "food", "drink" or "sweet".
- zero: true for diet / zero-sugar drinks. kcal: optional realistic estimate for that quantity.

### Cards

Cards replace hashtags with structure. Make a card when the day clearly contains one:

- Flight: {"type":"flight","airline":"American Airlines","number":"AA 4567","from":"PHL","to":"YYZ","depart":"19:45","arrive":"21:20","seat":"","note":""}
- Race: {"type":"race","event":"Schuylkill Navy Regatta","category":"2x","crew":["Jack"],"place":16,"of":48,"time":"14:01","emoji":"👍","note":"Good line, pushed to a 1:41 at the end"}
- Workout: {"type":"workout","activity":"Rowing","where":"Hanlan","duration":"","with":["Jack"],"emoji":"🚣","note":"2x, two laps to the gap and back"}
- Place: {"type":"place","name":"Jack Astor's","kind":"restaurant","city":"","note":""}  (kind: home|friend|school|gym|restaurant|cafe|shop|hotel|venue|outdoors|city|other)
- Ride: {"type":"ride","mode":"lyft","from":"","to":"Airport","note":""}  (mode: uber|lyft|taxi|transit|drive|driven|walk|bike|train|delivery)
- Event: {"type":"event","title":"Sleepover at Jack's","emoji":"🛌","kind":"sleepover","note":""}
- Watched & played: {"type":"media","title":"Pluribus","kind":"show","detail":"","note":""}  (kind: show|movie|music|book|game|podcast)

Common shorthand to convert:
- "#flight | Airline | 7:45-9:20 #phl-yyz" → flight card (from PHL to YYZ, 24-hour times; evening flights are PM).
- "#race/2x | 16th of 48, 14:01 time" → race card (category "2x", place 16, of 48, time "14:01"); sub-bullets become a short note; a leading 👍/🫩 emoji is the "emoji".
- "#rowing/<place>", "#workout" → workout card (activity, where, with).
- "#uber", "#lyft", "#ttc" (transit), "#drive" (they drove), "#doordash" (delivery) → ride card.
- "#restaurant/<name>", "#food/<name>" → place card (kind restaurant or cafe; write the real name, e.g. "jackastors" → "Jack Astor's").
- "#house/<name>" → place card (kind "friend", name "<Name>'s house") and add <Name> to people.
- "#test", "#sleepover", "#regatta" headings → event card if it was a notable event, otherwise a tag.
- Shows, films, music they mention watching/playing → media card.

## Example

{
  "format": "bcos.journal/1",
  "entries": [
    {
      "date": "2026-10-25",
      "icon": "🚣",
      "title": "Schuylkill Navy Regatta",
      "rating": 4.5,
      "mood": "slightly pleasant",
      "people": [
        "Jack",
        "Remo",
        "Dad"
      ],
      "tags": [
        "trip",
        "regatta"
      ],
      "body": "- Woke up 8:00, packed up and met Remo in the lobby\n- Raced the 2x with Jack\n\t- Decent line and a good pace, pushed to a 1:41 at the end\n- Lyft to the airport, flew home, Dad picked me up",
      "meals": {
        "breakfast": [
          {
            "name": "Pancakes",
            "qty": 2,
            "emoji": "🥞",
            "kind": "food"
          },
          {
            "name": "Bacon",
            "qty": 3,
            "unit": "strips",
            "emoji": "🥓",
            "kind": "food"
          },
          {
            "name": "Orange Juice",
            "emoji": "🧃",
            "kind": "drink"
          }
        ],
        "lunch": [],
        "dinner": [
          {
            "name": "Burger",
            "emoji": "🍔",
            "kind": "food"
          },
          {
            "name": "Root Beer",
            "qty": 2,
            "emoji": "🥤",
            "kind": "drink"
          }
        ],
        "snacks": [
          {
            "name": "Gatorade Zero",
            "qty": 2,
            "emoji": "🧃",
            "kind": "drink",
            "zero": true
          }
        ]
      },
      "cards": [
        {
          "type": "race",
          "event": "Schuylkill Navy Regatta",
          "category": "2x",
          "crew": [
            "Jack"
          ],
          "place": 16,
          "of": 48,
          "time": "14:01",
          "emoji": "🚣",
          "note": "Beat the Argos 2x by 37s"
        },
        {
          "type": "ride",
          "mode": "lyft",
          "to": "Airport"
        },
        {
          "type": "flight",
          "airline": "American Airlines",
          "from": "PHL",
          "to": "YYZ",
          "depart": "19:45",
          "arrive": "21:20",
          "note": "Music the whole flight"
        }
      ]
    }
  ]
}

## Checklist before answering
- Every entry has a valid "date".
- Valid JSON: double quotes, no trailing commas, no comments.
- Only the JSON object — nothing before or after it.
