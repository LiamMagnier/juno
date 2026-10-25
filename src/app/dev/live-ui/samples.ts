/**
 * Realistic Live UI replies for the dev gallery: each one is a whole assistant
 * message (prose around one ```live-ui fence), written the way the prompt
 * contract asks a model to write them. The source of truth is
 * contracts/live-ui/samples.json, which the native snapshot tests render too.
 */
import data from "../../../../contracts/live-ui/samples.json";
import legacy from "../../../../contracts/live-ui/legacy-reply.json";

export interface LiveUISample {
  id: string;
  label: string;
  prompt: string;
  reply: string;
}

export const LIVE_UI_SAMPLES: LiveUISample[] = data.samples;


/** A reply saved with the retired `:::` learning blocks, to show history converting. */
export const LEGACY_REPLY: { prompt: string; reply: string } = legacy;

/** Mermaid, which stays for diagrams with branches; drawn in the app's colours, fitted to the column. */
export const MERMAID_REPLY = [
  "A request to the API goes through the edge cache first; only a miss reaches the model.",
  "",
  "```mermaid",
  "flowchart LR",
  "  U[User] --> E{Edge cache}",
  "  E -- hit --> R[Cached reply]",
  "  E -- miss --> A[API server]",
  "  A --> Q[(Queue)] --> W[Worker] --> M[Model]",
  "  M --> A",
  "  A --> R",
  "```",
  "",
  "And the same handshake as a sequence:",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant C as Client",
  "  participant S as Server",
  "  C->>S: ClientHello",
  "  S-->>C: ServerHello, certificate",
  "  C->>S: Key exchange",
  "  S-->>C: Finished",
  "```",
].join("\n");

/**
 * A practice turn on the web: an exercise card the reader answers in (with Run
 * for SQL) and code blocks that run in place, in the browser (SQL, Python) and
 * in the sandbox (C). Web only, so it is not in the shared contract samples.
 */
export const PRACTICE_REPLY = [
  "Voici la requête de l'exemple : clique sur **Run** pour l'exécuter sur l'échantillon HR.",
  "",
  "```sql",
  "SELECT e.employee_id",
  "      ,e.last_name",
  "      ,e.salary",
  "FROM   employees e",
  "WHERE  e.department_id = 90",
  "ORDER BY e.salary DESC;",
  "```",
  "",
  "À toi de jouer :",
  "",
  "```live-ui",
  JSON.stringify({
    title: "Chapitre 1 : pratique",
    ui: [
      {
        type: "exercise",
        title: "Exercice 1 : le département informatique",
        tag: "SQL",
        prompt: "Affiche l'identifiant, le nom, le prénom et le salaire des employés du département informatique (`department_id = 60`), du salaire le plus élevé au plus bas.",
        language: "sql",
        placeholder: "SELECT …",
        hints: ["Toutes les colonnes demandées sont dans la table EMPLOYEES.", "Le tri décroissant s'écrit avec DESC après la colonne."],
      },
      {
        type: "exercise",
        title: "Exercice 2 : réflexion",
        tag: "Réflexion",
        prompt: "**Pourquoi la table EMPLOYEES ne suffit-elle pas à retrouver le département informatique à partir de son nom ?**",
        placeholder: "Je pense qu'il faut…",
        hints: ["Où est stocké le nom d'un département ?"],
      },
    ],
  }),
  "```",
  "",
  "Le même calcul en Python et en C :",
  "",
  "```python",
  "salaires = [9000, 6000, 4800, 4800, 4200]",
  "print(f\"Moyenne IT : {sum(salaires) / len(salaires):.0f}\")",
  "```",
  "",
  "```c",
  "#include <stdio.h>",
  "",
  "int main(void) {",
  "    int salaires[] = {9000, 6000, 4800, 4800, 4200};",
  "    int total = 0;",
  "    for (int i = 0; i < 5; i++) total += salaires[i];",
  "    printf(\"Moyenne IT : %d\\n\", total / 5);",
  "    return 0;",
  "}",
  "```",
].join("\n");

const fence = (view: unknown) => "```live-ui\n" + JSON.stringify(view) + "\n```";

/**
 * The intelligent-UI set (2026-10): views for what people do with an answer.
 * Kept here, not in contracts/live-ui/samples.json, until the native renderers
 * draw these types too (the native snapshot suite renders every contract sample).
 */
export const INTELLIGENT_SAMPLES: LiveUISample[] = [
  {
    id: "recipe",
    label: "Recipe · rescales for the guests, timers on each step",
    prompt: "Sunday roast chicken for 6, what do I need and how do I time it?",
    reply: [
      "A 1.8 kg chicken feeds six with leftovers. Start the potatoes as the bird goes in, and rest the chicken while they crisp.",
      "",
      fence({
        title: "Roast chicken with crispy potatoes",
        ui: [
          {
            type: "recipe",
            servings: 6,
            yieldLabel: "people",
            ingredients: [
              { name: "whole chicken", qty: 1.8, unit: "kg" },
              { name: "floury potatoes", qty: 1200, unit: "g", note: "peeled, halved" },
              { name: "butter", qty: 60, unit: "g", note: "softened" },
              { name: "garlic", qty: 1, unit: "head" },
              { name: "lemon", qty: 1 },
              { name: "olive oil", qty: 3, unit: "tbsp" },
              { name: "thyme", qty: 0.5, unit: "bunch" },
              { name: "flaky salt", note: "to taste" },
            ],
            steps: [
              { text: "Heat the oven to 220 °C. Rub the butter under the skin, season well, and put the lemon and garlic inside." },
              { text: "Parboil the potatoes in salted water, then drain and rough them up in the pan.", minutes: 10 },
              { text: "Roast the chicken; after 20 minutes add the potatoes with the oil around it.", minutes: 70 },
              { text: "Rest the chicken under foil while the potatoes finish crisping.", minutes: 15 },
            ],
          },
        ],
      }),
      "",
      "If the juices at the thigh run pink, give it ten more minutes.",
    ].join("\n"),
  },
  {
    id: "choices",
    label: "Choices · a follow-up question answered with a tap",
    prompt: "Help me plan a week of running.",
    reply: [
      "Happy to. One thing changes the whole plan, so let me ask it first.",
      "",
      fence({
        title: "Where are you starting from?",
        ui: [
          {
            type: "choices",
            question: "How much do you run right now?",
            options: [
              { label: "Not at all", detail: "Starting from zero", prompt: "I don't run at all yet." },
              { label: "Once or twice a week", detail: "Up to 5 km at a time", prompt: "I run once or twice a week, up to 5 km." },
              { label: "Three or more times", detail: "Comfortable at 10 km", prompt: "I run three or more times a week and 10 km is comfortable." },
              { label: "Training for a race", detail: "I'll tell you which", prompt: "I'm training for a race." },
            ],
          },
        ],
      }),
    ].join("\n"),
  },
  {
    id: "compare",
    label: "Compare · options side by side, pick one",
    prompt: "Which phone plan should I take? I use about 15 GB a month and travel in the EU.",
    reply: [
      "At 15 GB with EU roaming, the middle plan is the best value; the unlimited one only pays off above about 40 GB.",
      "",
      fence({
        title: "Three plans for 15 GB a month",
        ui: [
          {
            type: "compare",
            recommend: 1,
            options: [
              { name: "Basic", price: "€9.99/mo", tagline: "Cheapest, if you stay on Wi-Fi.", pros: ["Lowest price", "No contract"], cons: ["10 GB: you'd run out", "No EU roaming"], facts: [{ label: "Data", value: "10 GB" }, { label: "Roaming", value: "None" }], prompt: "Let's go with Basic." },
              { name: "Plus", price: "€14.99/mo", tagline: "Covers your usage with room to spare.", pros: ["25 GB", "EU roaming included", "5G"], cons: ["12-month term"], facts: [{ label: "Data", value: "25 GB" }, { label: "Roaming", value: "EU, 20 GB" }], prompt: "Let's go with Plus." },
              { name: "Unlimited", price: "€24.99/mo", tagline: "Only worth it if you stream on mobile.", pros: ["Unlimited data", "Worldwide roaming"], cons: ["€120 a year more than Plus"], facts: [{ label: "Data", value: "Unlimited" }, { label: "Roaming", value: "Worldwide" }], prompt: "Let's go with Unlimited." },
            ],
          },
        ],
      }),
    ].join("\n"),
  },
  {
    id: "cards",
    label: "Cards · places to pick from, each opens a follow-up",
    prompt: "Good places for dinner near Bairro Alto tonight?",
    reply: [
      "Four that take walk-ins on a Saturday if you go before 20:00.",
      "",
      fence({
        title: "Dinner near Bairro Alto",
        ui: [
          {
            type: "cards",
            items: [
              { title: "Taberna da Rua das Flores", subtitle: "Portuguese petiscos", meta: "€€", rating: 4.6, tags: ["Walk-in", "Small plates"], prompt: "Tell me more about Taberna da Rua das Flores." },
              { title: "Cervejaria Trindade", subtitle: "Seafood in an old monastery", meta: "€€", rating: 4.3, tags: ["Groups", "Historic"], prompt: "Tell me more about Cervejaria Trindade." },
              { title: "Pharmacia", subtitle: "Terrace with a view", meta: "€€€", rating: 4.4, tags: ["Terrace"], prompt: "Tell me more about Pharmacia." },
              { title: "A Cevicheria", subtitle: "Peruvian, tiny room", meta: "€€€", rating: 4.5, tags: ["Queue early"], prompt: "Tell me more about A Cevicheria." },
            ],
          },
        ],
      }),
    ].join("\n"),
  },
  {
    id: "tabs-flashcards",
    label: "Tabs and flashcards · revise a topic",
    prompt: "Help me revise the French Revolution for my exam.",
    reply: [
      "Here are the essentials by theme, then cards to test yourself.",
      "",
      fence({
        title: "The French Revolution",
        ui: [
          {
            type: "tabs",
            tabs: [
              { label: "Causes", children: [{ type: "callout", tone: "insight", text: "Debt from wars, a frozen tax system and bread prices that doubled in 1788." }] },
              { label: "Timeline", children: [{ type: "timeline", items: [{ time: "1789", label: "Estates-General; storming of the Bastille" }, { time: "1792", label: "Monarchy abolished" }, { time: "1793–94", label: "The Terror" }, { time: "1799", label: "Napoleon's coup" }] }] },
              { label: "Key people", children: [{ type: "text", text: "**Robespierre** led the Terror; **Danton** opposed it; **Louis XVI** was executed in 1793." }] },
            ],
          },
          {
            type: "flashcards",
            title: "Test yourself",
            cards: [
              { front: "When was the Bastille stormed?", back: "14 July 1789." },
              { front: "What was the Terror?", back: "1793–94: the Committee of Public Safety executed some 17,000 people as enemies of the Revolution." },
              { front: "Who ended the Revolution in 1799?", back: "Napoleon Bonaparte, in the coup of 18 Brumaire." },
            ],
          },
        ],
      }),
    ].join("\n"),
  },
];
