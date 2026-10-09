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
