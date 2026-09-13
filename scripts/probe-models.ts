import { MODEL_LIST } from "../src/lib/models";
import { loadAvailableModels } from "../src/lib/model-catalog-api";
import { probeModelCapability, probeAndPersistModelCapability } from "../src/lib/model-capability";

/**
 * Refresh exact model capability evidence for a deployment.
 *
 * Run from a protected scheduler (or `npm run models:probe` by an operator),
 * not from a request path. Each target makes one bounded one-token provider
 * call on the model's OWN transport — native GenerateContent for Gemini,
 * /responses for the Responses line — so a pass means the exact provider model
 * id is callable the way the chat path will call it.
 *
 * WHY IT TAKES FILTERS. It used to probe every selectable chat model, which is
 * now 113 of them: 113 real, billed calls and several minutes, whether you
 * wanted a scheduled sweep or an answer about one id. "Does Gemini 3.8 Flash
 * actually work?" is the question this script is most often opened for, and it
 * should cost one call.
 *
 *   npm run models:probe -- --model=gemini-3.8-flash --dry
 *   npm run models:probe -- --provider=google
 *   npm run models:probe                      # the full sweep, as before
 *
 * `--dry` skips persistence, which is what makes it usable from a laptop with
 * a provider key and no database. Without it the verdict is written to the
 * capability table exactly as a scheduled run would write it.
 *
 * `--model` also reaches models marked `comingSoon`, which the sweep skips by
 * design: naming one explicitly is how you find out whether a lab has opened
 * the API yet, and that is a question worth being able to ask.
 */

interface Args {
  model: string | null;
  provider: string | null;
  dry: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const hit = argv.find((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
    if (!hit) return null;
    const inline = hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : argv[argv.indexOf(hit) + 1];
    return inline && !inline.startsWith("--") ? inline.trim().toLowerCase() : null;
  };
  return { model: value("model"), provider: value("provider"), dry: argv.includes("--dry") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Naming a model explicitly searches the WHOLE registry, not the deployment's
  // available set: "this id is not offered here" and "this id does not answer"
  // are different answers, and the second is the one being asked for.
  const pool = args.model ? MODEL_LIST : await loadAvailableModels();
  const models = pool.filter((model) => {
    if (model.modality !== "chat") return false;
    if (!args.model && model.comingSoon) return false;
    if (args.provider && model.provider !== args.provider) return false;
    if (args.model) {
      const needle = args.model;
      return model.id.toLowerCase().includes(needle) || model.providerModel.toLowerCase().includes(needle);
    }
    return true;
  });

  if (models.length === 0) {
    console.error(
      `No chat model matches${args.model ? ` --model=${args.model}` : ""}${args.provider ? ` --provider=${args.provider}` : ""}.`,
    );
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const model of models) {
    const snapshot = args.dry ? await probeModelCapability(model) : await probeAndPersistModelCapability(model);
    const adapter = (snapshot.evidence as { adapter?: unknown } | null)?.adapter;
    console.log(
      [
        snapshot.status === "passed" ? "PASS" : "FAIL",
        snapshot.modelId,
        model.comingSoon ? "(coming soon)" : "",
        adapter ? `via ${String(adapter)}` : "",
        snapshot.detail ? `— ${snapshot.detail}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (snapshot.status === "failed") failed += 1;
  }
  console.log(
    `Model capability probes: ${models.length - failed}/${models.length} passed${args.dry ? " (dry run — nothing persisted)" : ""}.`,
  );
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error("Model capability probe run failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
