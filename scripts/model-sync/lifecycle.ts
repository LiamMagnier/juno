import type { ModelInfo } from "../../src/lib/models";

/**
 * The lifecycle fields of one catalogue row (`status`, `deprecationNote`,
 * `retiresOn`, `replacedBy`) checked as one statement. `validate:models` fails
 * on any of these; `models:sync` reports the row as needs-review and leaves its
 * retirement to a person, so one bad row never holds back the rest of a run.
 *
 * `replacedBy` is where stored ids migrate ON `retiresOn`, so it only means
 * something with a date. A lab that deprecates a model without announcing a
 * shutdown date (Google's "No shutdown date announced") is written as
 * `status: "deprecated"` with a `deprecationNote` naming the successor and no
 * `retiresOn` / `replacedBy`; models:sync writes both together the day the lab
 * publishes a date. A date is never inferred.
 *
 * `all` is the set a `replacedBy` may point into: the rows still served.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function lifecycleProblems(m: ModelInfo, all: readonly ModelInfo[]): string[] {
  const out: string[] = [];
  if (m.status === "deprecated" && !m.deprecationNote) out.push("deprecated without a deprecationNote");
  const spelled = m.deprecationNote?.match(/^Retires (\w{3}) (\d{1,2}), (\d{4})/);

  if (m.retiresOn !== undefined) {
    // Shape first: the date is compared as a plain string against a UTC
    // YYYY-MM-DD, so a malformed one does not throw — it silently never matches
    // and the model never retires.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.retiresOn)) out.push(`retiresOn "${m.retiresOn}" is not YYYY-MM-DD`);
    // A retirement with nowhere to go is the dangerous half: the model leaves
    // MODEL_LIST on the day, and without a replacement every stored id pointing
    // at it resolves to a fabricated "current" model on a dead provider id.
    if (!m.replacedBy) {
      out.push("retiresOn without replacedBy — stored ids would have nowhere to migrate");
    } else {
      const heir = all.find((x) => x.id === m.replacedBy);
      if (!heir) out.push(`replacedBy ${m.replacedBy} is not a registered model`);
      else if (heir.status !== "current") out.push(`replacedBy ${m.replacedBy} is ${heir.status}, not current`);
      else if (heir.modality !== m.modality) out.push(`replacedBy ${m.replacedBy} is a ${heir.modality} model, not ${m.modality}`);
      else if (heir.retiresOn) out.push(`replacedBy ${m.replacedBy} is itself retiring on ${heir.retiresOn}`);
    }
    // The date and the sentence are two statements of one fact; drift between
    // them is how the UI ends up promising a day the catalog does not honour.
    if (spelled) {
      const month = String(MONTHS.indexOf(spelled[1]) + 1).padStart(2, "0");
      const fromNote = `${spelled[3]}-${month}-${spelled[2].padStart(2, "0")}`;
      if (fromNote !== m.retiresOn) out.push(`deprecationNote says ${fromNote} but retiresOn is ${m.retiresOn}`);
    }
  } else {
    if (m.replacedBy) {
      out.push("replacedBy without retiresOn — a replacement takes effect on a retirement date; with no official date, keep status deprecated and the note, and drop replacedBy");
    }
    if (spelled) out.push(`deprecationNote promises a retirement ("${spelled[0]}") but there is no retiresOn`);
  }
  return out;
}

/** Past its last day and still a curated row: models:sync --apply moves it into RETIRED_MODELS. */
export function isOverdue(m: Pick<ModelInfo, "retiresOn">, today: string): boolean {
  return m.retiresOn != null && /^\d{4}-\d{2}-\d{2}$/.test(m.retiresOn) && m.retiresOn < today;
}
