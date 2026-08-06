import test from "node:test";
import assert from "node:assert/strict";
import { describeInference, inferCapabilities, selectForInferred } from "@/lib/work/inference";
import {
  WORK_CAPABILITIES,
  describeCapability,
  selectTarget,
  type HostCapabilityView,
  type WorkCapability,
} from "@/lib/work/domain";

/*
 * What a task looks like it needs, read out of the task.
 *
 * Every case here is one where a wrong answer is expensive in one direction and
 * free in the other, and the tests are written around that asymmetry rather
 * than around accuracy in general. A cloud capability inferred by mistake
 * changes no decision — the cloud offers all five, so a spurious `web_research`
 * costs nothing. A local capability inferred by mistake sends `selectTarget`
 * looking for a Mac, and with no Mac awake it refuses the run outright: a
 * person who asked Juno to draft an email is told "No Mac has been switched on
 * for Juno Work" and has been blocked by a guess.
 *
 * So the pairs below are the substance of this file. Each one differs by a
 * single possessive word, and the pair must land on different answers.
 */

/** Shorthand: the capability list for a goal, which is what callers act on. */
function capabilities(goal: string): WorkCapability[] {
  return inferCapabilities(goal).capabilities;
}

// ---------------------------------------------------------------------------
// The local / cloud asymmetry
// ---------------------------------------------------------------------------

test("a file nobody claimed is not a file on the user's Mac", () => {
  // "the finance folder" is a folder somewhere. It could be in Drive, it could
  // be in the attachment they just uploaded, it could be rhetorical. Reading it
  // as a folder on their disk is what turns a cloud task into a refusal.
  assert.deepEqual(
    capabilities("Reconcile the spreadsheet in the finance folder against the invoices"),
    ["deliverables"]
  );

  // One possessive later it is evidence about a specific machine, and now the
  // task genuinely cannot run in the cloud.
  assert.deepEqual(
    capabilities("Reconcile the spreadsheet in my finance folder against the invoices"),
    ["local_files", "deliverables"]
  );
});

test("naming the Mac is enough on its own, and not naming it is not", () => {
  assert.deepEqual(
    capabilities("Pull the numbers out of the document and email them to Priya"),
    ["connectors"],
    "the document is not yet anybody's document"
  );
  assert.deepEqual(
    capabilities("Pull the numbers out of the document on my Mac and email them to Priya"),
    ["local_files", "connectors"]
  );
});

test("a path is the least ambiguous evidence there is", () => {
  // Nobody writes `~/Downloads` about a file they have not got.
  assert.deepEqual(capabilities("Rename every file in ~/Downloads by date"), ["local_files"]);
  assert.deepEqual(capabilities("Sort /Users/robin/Desktop into folders by year"), ["local_files"]);

  // The same sentence with the path taken out asks for nothing in particular,
  // and that is the honest reading of it.
  assert.deepEqual(capabilities("Rename every file by date"), []);
});

test("cloud rules are content to match a topic, because a wrong one costs nothing", () => {
  // No possessive anywhere in this sentence, and every capability it produces
  // is one the cloud serves — so over-reading it changes no decision.
  assert.deepEqual(
    capabilities("Research the latest pricing for three vendors and write a comparison memo, with sources"),
    ["web_research", "deliverables"]
  );
});

// ---------------------------------------------------------------------------
// The shape of the answer
// ---------------------------------------------------------------------------

test("a goal that names nothing in particular needs nothing in particular", () => {
  // Not a failure to find an answer. `selectTarget` with no requirements routes
  // to the cloud, which is exactly where "summarise this idea" belongs, and a
  // function that reached for a capability rather than return nothing would be
  // the over-claiming this whole design exists to avoid.
  assert.deepEqual(capabilities("Summarise this idea for me"), []);
  assert.deepEqual(capabilities(""), []);
  assert.deepEqual(capabilities("   \n  "), []);
  assert.deepEqual(inferCapabilities("").evidence, []);
});

test("the list is in wire order, not in the order the goal happened to mention things", () => {
  // Two equal inferences must be equal arrays: the list is stored on the run,
  // compared against the retry's, and rendered as chips. An order that followed
  // the sentence would make the same task look like two different tasks.
  const capabilityIndex = new Map(WORK_CAPABILITIES.map((capability, index) => [capability, index]));

  const wordy =
    "Every Monday, look up what our competitors charge, check my inbox for the vendor replies, " +
    "and put together a comparison deck from the files in my Downloads folder";
  const found = capabilities(wordy);

  const indexes = found.map((capability) => capabilityIndex.get(capability) ?? -1);
  assert.deepEqual(
    [...indexes].sort((a, b) => a - b),
    indexes,
    "the capabilities must come back in WORK_CAPABILITIES order"
  );
  assert.deepEqual(capabilities(wordy), found, "the same goal twice is the same array twice");
});

test("a capability is claimed once however many phrases argued for it", () => {
  // Both the path rule and the possessive-folder rule fire on this sentence.
  // Two `local_files` entries would be stored on the run, shown as two chips
  // and counted twice by anything that counts.
  const inference = inferCapabilities("Move the files in my Downloads folder into ~/Archive");
  assert.deepEqual(inference.capabilities, ["local_files"]);
  assert.equal(inference.evidence.filter((entry) => entry.capability === "local_files").length, 1);
});

test("every phrase in the evidence is quoted from the goal, not invented for it", () => {
  // The composer shows these back as "Juno read this into your task". A phrase
  // the user cannot find in their own sentence reads as Juno having decided
  // something it will not explain.
  const goal = "Every morning, check my inbox and tidy up the files in my Downloads folder";
  for (const entry of inferCapabilities(goal).evidence) {
    assert.ok(goal.includes(entry.phrase), `${JSON.stringify(entry.phrase)} is not in the goal`);
  }
});

test("every capability the rules can produce is one the vocabulary owns", () => {
  // A rule naming a capability outside `WORK_CAPABILITIES` would pass the type
  // checker only until somebody renamed one, and would then be stored on runs,
  // sent over the wire and dropped by `selectTarget` without a word.
  const corpus = [
    "Tidy up the files in my Downloads folder",
    // Capitalised and unmistakable. "in preview" and "in pages" are ordinary
    // English, so the app rule asks for a name that is only ever an app.
    "Open the invoice in Finder",
    "Use my signed-in browser to download last month's statement",
    "Click through the setup wizard on my Mac",
    // Possessive, like every other local rule: "run the tests" alone is
    // something a cloud checkout does too.
    "Run the tests on my Mac",
    "Research what the current rates are",
    "Go through my inbox and draft replies",
    "Read the file I attached",
    "Write a report on what you find",
    "Keep going overnight and have it ready in the morning",
  ];

  const produced = new Set<WorkCapability>();
  for (const goal of corpus) for (const capability of capabilities(goal)) produced.add(capability);

  const vocabulary = new Set<string>(WORK_CAPABILITIES);
  for (const capability of produced) {
    assert.ok(vocabulary.has(capability), `${capability} is not in WORK_CAPABILITIES`);
  }
  // And the corpus is worth keeping only if it still reaches every rule: a
  // subset check alone passes trivially the day a rule stops firing at all.
  assert.deepEqual([...produced].sort(), [...WORK_CAPABILITIES].sort());
});

// ---------------------------------------------------------------------------
// The sentence the composer shows
// ---------------------------------------------------------------------------

test("the summary line is an observation, and there is none to make when nothing matched", () => {
  assert.equal(describeInference(inferCapabilities("Summarise this idea"), describeCapability), null);

  assert.equal(
    describeInference(inferCapabilities("Research the latest prices"), describeCapability),
    "Looks like this needs web research."
  );

  // Comma-separated with a final "and", because this is read aloud in the head
  // and a list joined entirely by commas reads as an unfinished sentence.
  assert.equal(
    describeInference(
      inferCapabilities("Research the latest prices and write a report from the files in my Downloads folder"),
      describeCapability
    ),
    "Looks like this needs access to a folder on your Mac, web research and document and spreadsheet creation."
  );
});

// ---------------------------------------------------------------------------
// Ordinary English is not a command line
// ---------------------------------------------------------------------------

/*
 * These are regressions, and they are the reason `selectForInferred` exists
 * below. The first version of the shell rule matched `\b(?:npm|…|make|…|git) \w`,
 * which reads "Make a plan for the offsite" as a request for a shell on the
 * reader's Mac — and because no cloud capability was inferred alongside it,
 * `selectTarget` refused and the Start button went dead on a sentence about a
 * meeting. The app rules had the same shape: "in preview", "in pages" and "in
 * photos" are ordinary English long before they are Apple applications.
 */

test("everyday verbs are not evidence of a shell", () => {
  for (const goal of [
    "Make a plan for next week's offsite",
    "Make me a summary of the vendor quotes",
    "Book a table and make a reservation for six",
    "Run the tests and tell me what broke",
  ]) {
    assert.deepEqual(capabilities(goal), [], goal);
  }
});

test("everyday nouns are not evidence of an app", () => {
  assert.deepEqual(capabilities("Check the numbers in pages 3-4 of the report"), []);
  assert.deepEqual(capabilities("Give it a preview and tell me what you think"), []);
  // Named as an application, it is evidence again.
  assert.deepEqual(capabilities("Open the file in Finder"), ["local_apps"]);
});

test("a shell still follows from a machine the reader called theirs", () => {
  assert.deepEqual(capabilities("Run the build on my Mac"), ["local_shell"]);
  assert.deepEqual(capabilities("Do it in the terminal"), ["local_shell"]);
});

// ---------------------------------------------------------------------------
// A guess is never allowed to refuse
// ---------------------------------------------------------------------------

/*
 * `selectTarget` returns a null target when a task needs a Mac and no Mac can
 * take it, and it is right to: a queued run nothing can claim is a spinner that
 * never resolves. But that is the correct answer to a *request*. Applied to a
 * reading of some prose it produces the failure this whole file was written to
 * avoid — the Start button goes dead, the reader is told their note about "my
 * downloads folder" needs a computer nobody asked them about, and the chip that
 * used to let them force the cloud is gone.
 */

const NO_HOSTS: HostCapabilityView[] = [];

test("an inferred local requirement yields rather than blocking the reader", () => {
  const inferred = inferCapabilities("Tidy my Downloads folder");
  assert.deepEqual(inferred.capabilities, ["local_files"]);

  const selection = selectForInferred({
    requested: "automatic",
    inferred: inferred.capabilities,
    hosts: NO_HOSTS,
    cloudAvailable: true,
  });

  // The task runs, and the reader is told which part of their reading will not.
  assert.equal(selection.target, "cloud");
  assert.ok(selection.degradation.some((entry) => entry.kind === "local_portion_skipped"));
  assert.ok(selection.missing.includes("local_files"));
});

test("the same requirement, named by the reader, still refuses", () => {
  // Because "run this on my Mac" is a request, and refusing a request that
  // nothing can serve is the honest answer. The asymmetry is the point.
  const selection = selectTarget({
    requested: "local",
    required: ["local_files"],
    hosts: NO_HOSTS,
    cloudAvailable: true,
  });
  assert.equal(selection.target, null);
});

test("a cloud that is not accepting work still refuses, because there is nowhere left", () => {
  const selection = selectForInferred({
    requested: "automatic",
    inferred: inferCapabilities("Tidy my Downloads folder and write a summary").capabilities,
    hosts: NO_HOSTS,
    cloudAvailable: false,
  });
  assert.equal(selection.target, null);
});

test("a reading with nothing local in it is passed through untouched", () => {
  const inferred = inferCapabilities("Research the latest rates and write a summary");
  const direct = selectTarget({
    requested: "automatic",
    required: inferred.capabilities,
    hosts: NO_HOSTS,
    cloudAvailable: true,
  });
  const softened = selectForInferred({
    requested: "automatic",
    inferred: inferred.capabilities,
    hosts: NO_HOSTS,
    cloudAvailable: true,
  });
  assert.deepEqual(softened, direct);
});

test("a Git host in the goal infers that a connected app is needed", () => {
  // The reported failure: "Clean my GitHub and add readme to projects that
  // doesn't have" inferred *nothing*, because the only Git pattern was
  // `github issues`. So the composer told the reader the task needed no
  // connected app, the run was dispatched with no Git tools, and the model
  // narrated an intention, called nothing, and died against a plan it had
  // never begun. Naming the host is the signal; "issues" never was.
  for (const goal of [
    "Clean my GitHub and add readme to projects that doesn't have",
    "archive my old gitlab repos",
    "review the open pull requests on bitbucket",
  ]) {
    assert.ok(
      inferCapabilities(goal).capabilities.includes("connectors"),
      `no connector inferred for: ${goal}`
    );
  }
});

test("a Git host is a connector requirement and not a local one", () => {
  // `connectors` is cloud-servable, so inferring it must not push the task on
  // to a Mac the reader was never asked about — the asymmetry this module's
  // own docstring exists to protect.
  const inferred = inferCapabilities("clean up my github");
  assert.deepEqual(inferred.capabilities, ["connectors"]);
});
