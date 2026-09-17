/*
 * OPENING A PULL REQUEST FROM A CODE SESSION, AND THE THREE WAYS TO DO IT.
 *
 * Until now the cloud runner opened one pull request, always, at the end of any
 * run that changed a file — non-draft, with a body it wrote itself, and with no
 * way for the person who asked for the work to say "not yet" or "as a draft".
 * When that call failed the runner said so in a sentence ("Pushed branch X, but
 * the pull request could not be created automatically") and the branch was then
 * a dead end on the web: nothing in the product could open one.
 *
 * So the review dock gets a Create PR control, and it offers the three shapes a
 * person actually wants:
 *
 *   full     open it now, ready for review
 *   draft    open it now, marked draft — the same commits, none of the pings
 *   compose  GitHub's own compare page, prefilled, so the title and body are
 *            written by the person rather than by us
 *
 * `compose` is deliberately not a server write. It is a URL, and a URL that
 * GitHub itself renders is a better "let me word this myself" than any textarea
 * we could put in the dock.
 *
 * ── WHY THIS MODULE IS PURE ────────────────────────────────────────────────
 *
 * Everything here is string work over facts a caller already holds, so the
 * client can decide whether to DRAW the control using the same function the
 * server uses to decide whether to HONOUR it. A control that appears and then
 * fails is the defect this split exists to prevent, and a shared sentence is
 * how the refusal reads the same in both places.
 */

/** The three shapes a pull request request can take. */
export const PULL_REQUEST_MODES = ["full", "draft", "compose"] as const;

export type PullRequestMode = (typeof PULL_REQUEST_MODES)[number];

/** The task facts the decision is made from — a structural subset of `CodeTask`. */
export interface PullRequestSubject {
  /** "device" | "cloud". Only a cloud run pushes anything to GitHub. */
  target: string;
  repoOwner: string | null;
  repoName: string | null;
  /** The branch the run pushed, once it has pushed one. */
  branch: string | null;
  prUrl: string | null;
}

export interface PullRequestBlocker {
  /** A stable code for the client; the message is what a person reads. */
  code: "device_run" | "no_repo" | "no_branch" | "pull_request_exists";
  message: string;
}

/**
 * Why this session cannot open a pull request, or null when it can.
 *
 * The device case is the one worth stating plainly, because it is the one a
 * reader would otherwise read as a bug: a run on your Mac writes to a checkout
 * on your Mac. Nothing was pushed, so there is no head to compare, and a button
 * that offered to open one would be promising a push this product has no way to
 * perform — the review pane's own docblock is the precedent (it cannot apply,
 * stage, revert or land anything either, and says so instead of pretending).
 */
export function pullRequestBlocker(subject: PullRequestSubject): PullRequestBlocker | null {
  if (subject.target !== "cloud") {
    return {
      code: "device_run",
      message:
        "This run happened on your Mac, so nothing has been pushed to GitHub. Commit and push from the Mac, then open the pull request there.",
    };
  }
  if (!subject.repoOwner || !subject.repoName) {
    return { code: "no_repo", message: "This run is not linked to a repository." };
  }
  if (!subject.branch) {
    return {
      code: "no_branch",
      message: "This run hasn’t pushed a branch yet. A pull request needs commits on GitHub to compare.",
    };
  }
  if (subject.prUrl) {
    return {
      code: "pull_request_exists",
      message: "This session already has a pull request — it is linked in the banner above.",
    };
  }
  return null;
}

/**
 * GitHub's compare page for a branch, with the pull request form already open.
 *
 * `quick_pull=1` is what makes GitHub render the create form rather than the
 * plain comparison. `title` and `body` are sent EMPTY on purpose: the whole
 * reason someone picks compose over full is to write those two fields
 * themselves, and prefilling them with the generated text would put our words
 * in the box they came here to type in.
 */
export function pullRequestCompareUrl(input: {
  owner: string;
  repo: string;
  base: string;
  head: string;
}): string {
  const path = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  // `...` separates base from head in GitHub's compare path and must survive
  // encoding, so the two refs are encoded individually and joined after.
  const range = `${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`;
  return `https://github.com/${path}/compare/${range}?quick_pull=1&title=&body=`;
}

/** GitHub refuses a title over 256 characters; one line of the prompt is the title. */
export function pullRequestTitle(prompt: string, fallback: string): string {
  const firstLine = prompt.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  return (firstLine || fallback).slice(0, 200);
}

/**
 * The body of a pull request opened from the review dock.
 *
 * It says who asked for it and what they asked for, and it does NOT claim the
 * change was reviewed — the person opening it has been reading the diff, but
 * this text is read by everyone else, and a body that asserts a review nobody
 * recorded is exactly the kind of confident sentence a reviewer learns to
 * distrust.
 */
export function pullRequestBody(input: {
  branch: string;
  base: string;
  prompt: string;
  /** The requester's GitHub login, when the app (not their own token) opens it. */
  mention: string | null;
  draft: boolean;
}): string {
  const asked = pullRequestTitle(input.prompt, "").slice(0, 500);
  return [
    `Opened from Juno Code${input.mention ? ` for @${input.mention}` : ""}.`,
    "",
    ...(asked ? ["**Task prompt**", "", `> ${asked}`, ""] : []),
    `Branch \`${input.branch}\` targets \`${input.base}\`.${
      input.draft ? " Opened as a draft — mark it ready when it is." : " Review before merging."
    }`,
  ].join("\n");
}
