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
| rating  | number | Day rating out of 5, halves allowed (4.5). Omit if not given. |
| mood    | string or 1–7 | One of: "very unpleasant", "unpleasant", "slightly unpleasant", "neutral", "slightly pleasant", "pleasant", "very pleasant" (1 = very unpleasant … 7 = very pleasant). Omit if not given. |
| people  | string[] | People they spent time with (first names, or Mum/Dad…). Never the writer. |
| tags    | string[] | Lower-case themes that are NOT already captured by a card (trip, regatta, sleepover, test, school…). No "#". |
| body    | Markdown | What happened, as they wrote it: "- " bullets, sub-bullets indented with a tab, "## " for a section heading, **bold** allowed. Remove the "Things that happened" heading, the food section, rating, tags and mood lines — those go in their own fields. Replace hashtags with plain words ("#lyft" → "Lyft", "#rowing/hanlan" → "rowing at Hanlan", "#house/jack" → "Jack's house"). Put each card where it happened with a marker {{card N}} (N = the card's position in "cards", starting at 1) — see "Placing cards". |
| meals   | object | { "breakfast": Food[], "lunch": Food[], "dinner": Food[], "snacks": Food[] }. Use [] for "-" or missing meals. |
| cards   | Card[] | Structured moments — see below. Order them as they happened. |

### Placing cards

Cards appear inline in the day's timeline, so the body must say where each one goes:
- When a bullet IS the card (e.g. "🚣 #race/2x | 16th of 48, 14:01 time"), replace that bullet's text with the marker: "- {{card 2}}". Move its sub-bullets into the card's "note" (short) instead of keeping them as sub-bullets.
- When a bullet mentions the card but says more (e.g. "Called #lyft to airport, got through security quickly"), keep the words and add the marker at the end: "- Lyft to the airport, got through security quickly {{card 3}}".
- Every card must be placed exactly once.

### Food

{ "name": "Coke Zero", "qty": 1, "unit": "", "emoji": "🥤", "kind": "drink", "zero": true, "kcal": 0 }

- Split combined lines: "2 pancakes, 2 eggs and 3 strips of bacon with orange juice" → 4 items.
- name: short, Title Case, keep brands ("Jack Astor's Fries", "Gatorade Zero"). qty defaults to 1.
- unit only for counted portions ("strips", "slice", "bag", "pack").
- emoji: the single best food emoji. kind: "food", "drink" or "sweet".
- zero: true for diet / zero-sugar drinks. kcal: optional realistic estimate for that quantity.

### Cards

Cards replace hashtags with structure. Make a card when the day clearly contains one:

- Flight: {"type":"flight","airline":"American Airlines","number":"AA 4567","from":"PHL","to":"YYZ","depart":"19:45","arrive":"21:20","seat":"","domain":"aa.com","note":""}
- Race: {"type":"race","event":"Schuylkill Navy Regatta","category":"2x","crew":["Jack"],"place":16,"of":48,"time":"14:01","medal":"","note":"Good line, pushed to a 1:41 at the end"}  (medal: gold|silver|bronze when they medalled, else omit)
- Workout: {"type":"workout","activity":"Rowing","where":"Hanlan","duration":"","with":["Jack"],"result":"","note":"2x, two laps to the gap and back"}  (result: test scores and PBs, e.g. "2k 6:58.4 PB", "max watts 612")
- Place: {"type":"place","name":"Jack Astor's","kind":"restaurant","city":"","domain":"jackastors.com","note":""}  (kind: home|friend|school|gym|restaurant|cafe|shop|hotel|venue|outdoors|city|other; domain only for real businesses/chains with a website)
- Ride: {"type":"ride","mode":"lyft","from":"","to":"Airport","with":[],"domain":"","note":""}  (mode: uber|lyft|taxi|transit|train|drive|driven|walk|bike|escooter; "drive" = they drove, a driving lesson is mode drive with the instructor in "with"; transit: set domain, e.g. "ttc.ca")
- Order: {"type":"order","service":"DoorDash","kind":"food","item":"Basta Pasta","domain":"doordash.com","note":"Got two things wrong, they sent a replacement"}  (kind: food|package|groceries — Uber Eats/DoorDash meals, Amazon/Temu/Taobao/AliExpress packages, Walmart/Instacart deliveries)
- Appointment: {"type":"appointment","kind":"orthodontist","with":"","note":"Got the retainer adjusted"}  (kind: dentist|orthodontist|doctor|hospital|surgery|vaccine|haircut|other)
- Event: {"type":"event","title":"Sleepover at Jack's","kind":"sleepover","note":""}
- Watched & played: {"type":"media","title":"Pluribus","kind":"show","detail":"","note":""}  (kind: show|movie|music|book|game|podcast)

Their hashtags, and what each becomes (the writer's own list; N = any name):
- Flights: "#flight | Airline | 7:45-9:20 #phl-yyz", route tags like "#rsw-yyz", "#yyz-bos" → flight card (from/to IATA codes, 24-hour times; evening flights are PM).
- Races: "#race/2x | 16th of 48, 14:01 time" (also race/1x, race/4x, race/4x+) → race card (category "2x", place 16, of 48, time "14:01"). "#regattawin", "#rowing/gold|silver|bronze" → that race's "medal". Sub-bullets become a short note.
- Training: "#rowing", "#rowing/<place>" (hanlan…), "#practice/1x|4x", "#rowing/double", "#rowing/dockout", "#workout", "#workout/weights|steadystate", "#gym", "#run", "#swim", "#biking", "#hike", "#skiing", "#golf" → workout card. "#ergtest", "#2ktest", "#6ktest", "#rowingpb", "#pb", "#maxwatts" → workout card with the score in "result" (add "PB" when it was one).
- Getting around: "#uber", "#lyft", "#taxi/N", "#ttc" (transit, domain "ttc.ca"), "#walk", "#escooter", "#drive"/"#driving" (they drove) → ride card. "#drivinglesson", "#driving/N" → ride card mode "drive" with N in "with". "#drivingtest" → event card.
- Orders: "#ubereats", "#doordash" → order card kind "food" (the restaurant in "item"). "#package", "#package/amazon|temu|taobao|aliexpress|lit", "#temu", "#taobao", "#temupackage" → order card kind "package". "#walmartdelivery" → order kind "groceries".
- Places: "#food/N", "#restaurant/N" → place card kind restaurant/cafe (real name: "jackastors" → "Jack Astor's", "a&w" → "A&W"; set "domain" for chains). "#store/N", "#costco", "#ikea", "#target", "#yorkdale", "#pusateris" → place kind "shop". "#house/N", "#friendshouse" → place kind "friend" ("<N>'s house") and N in people. "#granite", "#graniteWF" → place kind "gym" (Granite Club). "#hotel", "#chalet" → place kind "hotel". "#havergal" etc. → place kind "school". "#beach", "#hike/N", "#camping/N" → place kind "outdoors".
- Health & care: "#dentist", "#orthodontist", "#doctor", "#hospital", "#oralsurgeon", "#surgery", "#vaccine", "#haircut" → appointment card. "#sick", "#injury", "#vomit" → tags.
- School: "#test", "#exam", "#exam/ap", "#quiz", "#SAT", "#examreturn", "#reportcard", "#presentation" → event card (kind "test", title like "Chem test"). "#sub/N", "#sub" (a substitute teacher) → event card kind "sub", title "Sub: <N>". "#firedrill", "#assembly", "#fieldtrip", "#schoolphotos", "#schoolconcert", "#halfday", "#snowday", "#firstday", "#graduation" → event card.
- Watching & playing: "#movie" (and any show/film/game they mention watching or playing) → media card. "#leafsgame", "#wwdc", "#escaperoom", "#wonderland", "#birthdayparty", "#birthday/N", "#play/performance|rehearsal", "#roboticscomp", "#contest" → event card.
- People: "#people/N", "#jack", "#griff", "#andrewg", "#kovacs", "#linda", "#Alannah", "#apollo", etc. → add to "people".
- Trips: "#trip", "#trip/N", "#florida", "#philadelphia", "#vacation", "#camping/N" → tag "trip" (plus place cards for where they went).
- Everything else ("#weather/heat", "#snow", "#interestingdream", "#dream/long", "#important", "#favourite", "#lockedin", "#productive", "#boring", "#shitday", "#controversy", "#memory", "#story", …) → lower-case tags without "#" or "/" (e.g. "weather-heat", "dream").

## Example

{
  "format": "bcos.journal/1",
  "entries": [
    {
      "date": "2026-10-25",
      "icon": "🚣",
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
      "body": "- Woke up 8:00, packed up and met Remo in the lobby\n- {{card 1}}\n- Rowed back, Remo carried our oars to the trailer\n- Lyft to the airport {{card 2}}\n- {{card 3}}\n- Customs was quick, Dad picked me up",
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
          "note": "Decent line and pace, pushed to a 1:41 at the end. Beat the Argos 2x by 37s"
        },
        {
          "type": "ride",
          "mode": "lyft",
          "to": "Airport"
        },
        {
          "type": "flight",
          "airline": "American Airlines",
          "domain": "aa.com",
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
- Every card has exactly one {{card N}} marker in "body".
- No "title" field — days don't have titles.
- Valid JSON: double quotes, no trailing commas, no comments.
- Only the JSON object — nothing before or after it.
