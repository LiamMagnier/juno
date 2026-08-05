/**
 * What a task needs, read out of the task itself.
 *
 * The composer used to ask. Two chips sat above the field — where this should
 * run, and what it is allowed to need — and between them they made the user
 * answer a question about Juno's architecture before they were allowed to
 * describe their own work. The chips are gone; this file is what replaces them.
 *
 * It is deliberately a pure function over the goal text and nothing else, in
 * the same spirit as `selectTarget`: the browser runs it to say, before the
 * button is pressed, what this task looks like it will need, and the dispatch
 * route runs the same function on the same text so the sentence the user read
 * is the sentence the server acted on. A capability list produced by a model
 * would be a better list and a worse contract — it could not be previewed
 * without a round trip, and two runs of the same goal could disagree.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports, for the reason
 * `domain.ts` gives: the route handlers, the composer and the tests all need
 * this, and only one of the three can import a Prisma client.
 *
 * ## The asymmetry that shapes every rule below
 *
 * Inferring a **cloud** capability that the task did not really need costs
 * nothing: the cloud offers all five of them, so a spurious `web_research`
 * changes no decision. Inferring a **local** capability that the task did not
 * need is expensive and visible — `selectTarget` will route the task to a Mac,
 * or, with no Mac awake, refuse to start it at all. A user who asked Juno to
 * draft an email and was told "no Mac is switched on for Juno Work" has been
 * blocked by a guess.
 *
 * So the local rules demand possessive, first-person evidence about the user's
 * own machine — "my Downloads folder", "on my Mac", "~/Projects" — and the
 * cloud rules are content to match a topic. Under-claiming local work is
 * recoverable: the run starts in the cloud, discovers it cannot reach a file,
 * and says so. Over-claiming it is not.
 */

import {
  LOCAL_ONLY_CAPABILITIES,
  WORK_CAPABILITIES,
  describeCapability,
  selectTarget,
  type HostCapabilityView,
  type TargetSelection,
  type WorkCapability,
  type WorkTarget,
} from "@/lib/work/domain";

/** One capability, and the words in the goal that argued for it. */
export interface CapabilityEvidence {
  capability: WorkCapability;
  /** The matched phrase, verbatim from the goal, for the "why" line. */
  phrase: string;
}

export interface CapabilityInference {
  /** Deduplicated, in `WORK_CAPABILITIES` order so two equal inferences are equal arrays. */
  capabilities: WorkCapability[];
  evidence: CapabilityEvidence[];
}

/**
 * A rule is a capability plus the patterns that imply it.
 *
 * Written as explicit `RegExp`s rather than a keyword list because almost every
 * interesting rule is about *possession*, not vocabulary: "the spreadsheet"
 * says nothing, "my spreadsheet" says the file is on this person's disk. A bare
 * `includes("spreadsheet")` cannot express that difference, and the difference
 * is the whole design.
 *
 * `\b` on both ends throughout: "email" must not fire on "emailed" is wrong —
 * it should — but "mac" firing inside "machine" is a real misread, and the
 * cheapest defence that survives every other word is a word boundary.
 */
interface InferenceRule {
  capability: WorkCapability;
  patterns: readonly RegExp[];
}

/** The user's own machine, named as theirs. */
const POSSESSIVE_MAC = String.raw`(?:my|this) (?:mac|macbook|laptop|computer|imac|desktop machine)`;

const RULES: readonly InferenceRule[] = [
  // ---------------------------------------------------------------- local ---
  {
    capability: "local_files",
    patterns: [
      // A path is the least ambiguous evidence there is.
      /(?:^|\s)~\//,
      /(?:^|\s)\/(?:Users|Volumes|Applications)\//,
      // "my Downloads folder", "the folder on my Mac", "files on my computer".
      new RegExp(String.raw`\b(?:my|our)\s+(?:\w+\s+){0,2}(?:folder|directory|files?|documents?|downloads|desktop)\b`, "i"),
      new RegExp(String.raw`\b(?:folder|directory|files?|documents?)\b[^.!?]{0,40}\bon ${POSSESSIVE_MAC}\b`, "i"),
      new RegExp(String.raw`\bin (?:my|the) (?:downloads|documents|desktop)\b`, "i"),
    ],
  },
  {
    capability: "local_apps",
    patterns: [
      new RegExp(String.raw`\b(?:open|use|drive|control)\b[^.!?]{0,30}\b(?:app|application)\b[^.!?]{0,20}\bon ${POSSESSIVE_MAC}\b`, "i"),
      // Capitalised, and not the everyday words. "in preview", "in pages" and
      // "in photos" are ordinary English — "check the numbers in pages 3-4" is
      // not a request to drive Pages — so only the app names that cannot be
      // mistaken for a common noun are matched case-sensitively.
      /\bin (?:Finder|Keynote|Xcode|Mail\.app)\b/,
      /\bin the (?:Numbers|Pages|Preview|Photos) app\b/i,
    ],
  },
  {
    capability: "local_browser",
    patterns: [
      new RegExp(String.raw`\b(?:my|the) (?:signed[- ]in|logged[- ]in) browser\b`, "i"),
      /\b(?:while|because|since) I(?:'m| am) (?:already )?(?:signed|logged) in\b/i,
      /\b(?:use|with) my (?:browser|chrome|safari|firefox) (?:session|profile|login)\b/i,
    ],
  },
  {
    capability: "local_computer_use",
    patterns: [
      new RegExp(String.raw`\b(?:click|type|drag)\b[^.!?]{0,40}\bon ${POSSESSIVE_MAC}\b`, "i"),
      /\b(?:control|take over|drive) (?:my|the) screen\b/i,
      /\bscreenshot (?:my|the) (?:screen|display|desktop)\b/i,
    ],
  },
  {
    capability: "local_shell",
    patterns: [
      // Possessive, like every other local rule. "Run the tests" is something a
      // cloud checkout does too; "run the tests in my repo" is not.
      new RegExp(String.raw`\b(?:run|execute)\b[^.!?]{0,40}\b(?:on|in) ${POSSESSIVE_MAC}\b`, "i"),
      new RegExp(String.raw`\bin (?:the |my )?(?:terminal|shell|command line)\b`, "i"),
      // A command line, not an English sentence. The verbs `make` and `git` are
      // deliberately absent: "Make a plan for the offsite" and "git" inside a
      // sentence about version control are ordinary prose, and inferring a shell
      // from them is how a cloud-only reader was told their task needs a Mac.
      // `npm`/`pnpm`/`cargo` keep their place because no English sentence
      // contains them, and each is anchored to a subcommand.
      /\b(?:npm|pnpm|yarn|cargo|pytest|xcodebuild) (?:run |install |test|build|add |exec )/i,
    ],
  },
  // ---------------------------------------------------------------- cloud ---
  {
    capability: "web_research",
    patterns: [
      /\b(?:research|look up|find out|search (?:for|the web)|read up on)\b/i,
      /\b(?:latest|current|recent|today's)\b[^.!?]{0,30}\b(?:news|price|prices|rates?|results?|release|version)\b/i,
      /\b(?:compare|survey|round[- ]?up)\b[^.!?]{0,30}\b(?:options|vendors|tools|competitors|products)\b/i,
      /\bwith (?:sources|citations)\b/i,
    ],
  },
  {
    capability: "connectors",
    patterns: [
      /\b(?:my |our )?(?:inbox|gmail|email|e-mail|mailbox)\b/i,
      /\b(?:my |our )?calendar\b/i,
      /\b(?:slack|notion|linear|jira|asana|hubspot|salesforce|google drive|dropbox|github issues)\b/i,
      /\b(?:send|draft|reply to)\b[^.!?]{0,20}\b(?:email|message|invite)\b/i,
    ],
  },
  {
    capability: "cloud_files",
    patterns: [
      /\b(?:the )?(?:attached|uploaded)\b/i,
      /\b(?:file|document|spreadsheet|deck|pdf) I (?:attached|uploaded|added)\b/i,
      /\bin (?:my )?(?:juno )?library\b/i,
    ],
  },
  {
    capability: "deliverables",
    patterns: [
      /\b(?:write|draft|produce|prepare|put together|generate|build)\b[^.!?]{0,30}\b(?:doc|document|report|memo|brief|summary|spreadsheet|workbook|deck|presentation|slides?|pdf|site|page|plan)\b/i,
      /\b(?:as|into) an? (?:xlsx|docx|pptx|pdf|spreadsheet|document|deck)\b/i,
      /\b(?:reconcile|tidy up|clean up)\b[^.!?]{0,30}\b(?:spreadsheet|workbook|sheet|csv)\b/i,
    ],
  },
  {
    capability: "background_continuation",
    patterns: [
      /\b(?:every (?:day|morning|week|monday|hour)|each (?:day|morning|week))\b/i,
      /\b(?:overnight|while I(?:'m| am) (?:away|asleep|out)|when I(?:'m| am) offline|in the background)\b/i,
      /\b(?:keep (?:going|running)|carry on) (?:until|while|even)\b/i,
    ],
  },
];

/** Rule order is presentation order; `WORK_CAPABILITIES` order is wire order. */
const CAPABILITY_ORDER = new Map<WorkCapability, number>(
  WORK_CAPABILITIES.map((capability, index) => [capability, index])
);

/**
 * Reads a goal and says what it will need.
 *
 * Returns an empty list for a goal that names nothing in particular, and that
 * is the right answer rather than a failure to find one: `selectTarget` with no
 * requirements routes to the cloud, which is exactly where "summarise this idea
 * for me" belongs.
 *
 * The 10-capability cap mirrors `startRunSchema`'s `.max(10)` — there are only
 * ten capabilities, so the cap can only ever be reached by a goal that matched
 * every rule, but the wire schema is the authority on what it will accept and
 * this function must not be able to produce something it would reject.
 */
export function inferCapabilities(goal: string): CapabilityInference {
  const text = goal.trim();
  if (text.length === 0) return { capabilities: [], evidence: [] };

  const evidence: CapabilityEvidence[] = [];
  const found = new Set<WorkCapability>();

  for (const rule of RULES) {
    if (found.has(rule.capability)) continue;
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match === null) continue;
      found.add(rule.capability);
      evidence.push({ capability: rule.capability, phrase: match[0].trim() });
      break;
    }
  }

  const capabilities = [...found].sort(
    (a, b) => (CAPABILITY_ORDER.get(a) ?? 0) - (CAPABILITY_ORDER.get(b) ?? 0)
  );
  return { capabilities, evidence };
}

const LOCAL_ONLY = new Set<string>(LOCAL_ONLY_CAPABILITIES);

/**
 * Chooses a target from *inferred* requirements, under one extra rule: a guess
 * is never allowed to refuse.
 *
 * `selectTarget` is right to return `target: null` when a task genuinely needs a
 * Mac and no Mac can take it — the alternative is a queued task nobody will
 * ever run. But that logic assumes the requirement came from the reader. Here it
 * came from the regexes above, and the consequences of the two are not
 * symmetrical: a wrong guess that refuses is a person staring at a disabled
 * button, told their note about "my downloads folder" needs a computer they were
 * never asked about. That is the exact failure the file's opening asymmetry
 * exists to prevent, and stopping at inference alone did not prevent it.
 *
 * So when the only thing standing between a reader and a running task is a
 * guess, the guess yields: the local requirements are dropped, the task runs on
 * what the cloud can serve, and the degradation says plainly which parts will
 * not happen. The reader keeps the button and the truth.
 *
 * This holds even when the local guess was the *only* thing read out of the
 * task, and that is the deliberate half. Refusing there assumes the reading was
 * right; running assumes it might have been wrong. The docstring at the top of
 * this file already committed to which of those to assume — "under-claiming
 * local work is recoverable: the run starts in the cloud, discovers it cannot
 * reach a file, and says so" — and a dead-ended button is not recoverable by
 * anything the reader can do, because the chip that used to let them override
 * the target is gone.
 *
 * The one thing that still refuses is a cloud that is not accepting work: there
 * is no reading to yield, and nowhere left to run.
 *
 * Explicit requirements do not come through here. `selectTarget` remains the
 * function for those, and it still refuses, because "run this on my Mac" is a
 * request rather than a reading.
 */
export function selectForInferred(input: {
  requested: WorkTarget;
  inferred: readonly WorkCapability[];
  hosts: readonly HostCapabilityView[];
  cloudAvailable: boolean;
}): TargetSelection {
  const first = selectTarget({
    requested: input.requested,
    required: input.inferred,
    hosts: input.hosts,
    cloudAvailable: input.cloudAvailable,
  });
  if (first.target !== null) return first;

  const guessedLocal = input.inferred.filter((capability) => LOCAL_ONLY.has(capability));
  const rest = input.inferred.filter((capability) => !LOCAL_ONLY.has(capability));
  if (guessedLocal.length === 0) return first;

  const without = selectTarget({
    requested: input.requested,
    required: rest,
    hosts: input.hosts,
    cloudAvailable: input.cloudAvailable,
  });
  if (without.target === null) return first;

  return {
    ...without,
    missing: [...without.missing, ...guessedLocal],
    degradation: [
      ...without.degradation,
      {
        kind: "local_portion_skipped",
        explanation: `This reads like it also needs ${guessedLocal
          .map(describeCapability)
          .join(", ")}, which no Mac is available for. Juno will do the rest.`,
      },
    ],
    explanation: without.explanation,
  };
}

/**
 * The composer's one-line "what Juno read into this", or null when it read
 * nothing in particular.
 *
 * Phrased as an observation rather than a promise — "this looks like it needs
 * X" — because it is a regex, and a sentence that claimed certainty would be
 * overstating what the paragraph above can deliver.
 */
export function describeInference(
  inference: CapabilityInference,
  describe: (capability: string) => string
): string | null {
  if (inference.capabilities.length === 0) return null;
  const named = inference.capabilities.map(describe);
  if (named.length === 1) return `Looks like this needs ${named[0]}.`;
  const last = named[named.length - 1];
  return `Looks like this needs ${named.slice(0, -1).join(", ")} and ${last}.`;
}
