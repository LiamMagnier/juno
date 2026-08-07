import type { ProviderAdapter } from '../providers/types.js';
import { structuralValidation } from './session.js';
import type { WorkValidator } from './session.js';
import type { WorkValidationCheck } from './types.js';

/**
 * A validator that actually reads the deliverable against the goal.
 *
 * **What it is for.** `structuralValidation` is handed the goal and never reads
 * it: it checks that every step reached a terminal status, that skips and
 * failures carry a reason, that something was produced, and that nothing
 * unfinished went unmentioned. All of that is about the *record* of a run. A
 * run that ticks its own boxes and returns a paragraph about something else
 * passes it, which is why a run it passes may only say it produced a result —
 * never that the result answers the goal.
 *
 * This closes that, and the calibration is the whole design.
 *
 * **It is deliberately hard to fail.** The model is asked one question and told
 * to answer `yes` unless the deliverable plainly does not address the goal.
 * A judge that fails borderline work is worse than no judge: the run has
 * already been done and paid for, the user is told it failed, and the only
 * remedy on offer is to run it again. So this catches the egregious case — an
 * answer about something else entirely — and stays out of the way of anything
 * arguable. Quality is not what it measures and it must not grow into that.
 *
 * **It fails open, and that is a departure worth stating.** `WorkAgentSession`
 * treats a validator that *throws* as a failure, on the principle that
 * completion should only be asserted when something checked. That principle is
 * about the mechanism being broken. Here the structural checks have already run
 * and passed; if the extra question cannot be put to the model — a timeout, a
 * refusal, an unparseable reply — turning a transient provider hiccup into a
 * failed run would destroy work that is probably fine. Instead the run passes
 * with `judged: false`, so it reports having produced a result rather than
 * having answered the goal, and the transcript records that the check could not
 * be made. Not asserting is the honest middle.
 */
export function goalValidator(options: {
  provider: ProviderAdapter;
  model: string;
  /** Bounds the judge so a stuck call cannot outlive the run it is judging. */
  timeoutMs?: number;
}): WorkValidator {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async (input) => {
    const structural = structuralValidation(input);
    // A run that failed its own record does not need a second opinion, and
    // spending a model call to add one would delay a failure already decided.
    if (!structural.satisfied) return structural;

    const answer = input.answer.trim();
    const artifacts = input.artifacts.map((ref) => ref.id).join(', ');
    let verdict: { addressed: boolean; why: string } | null = null;

    try {
      verdict = await ask({
        provider: options.provider,
        model: options.model,
        goal: input.goal,
        answer,
        artifacts,
        timeoutMs,
      });
    } catch {
      verdict = null;
    }

    if (verdict === null) {
      const check: WorkValidationCheck = {
        claim: 'The deliverable was read against the goal.',
        satisfied: true,
        evidence: 'The check could not be made, so this run is not reported as judged.',
      };
      return {
        ...structural,
        checks: [...structural.checks, check],
        judged: false,
      };
    }

    const check: WorkValidationCheck = {
      claim: 'The deliverable addresses what was asked for.',
      satisfied: verdict.addressed,
      evidence: verdict.why,
    };
    const checks = [...structural.checks, check];
    const unmet = verdict.addressed ? structural.unmet : [...structural.unmet, verdict.why];
    return {
      satisfied: verdict.addressed,
      checks,
      unmet,
      // Judged either way: the comparison was made, and that is what the word
      // means. A failed judgement is still a judgement.
      judged: true,
    };
  };
}

/** One question, one short answer. */
async function ask(input: {
  provider: ProviderAdapter;
  model: string;
  goal: string;
  answer: string;
  artifacts: string;
  timeoutMs: number;
}): Promise<{ addressed: boolean; why: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const stream = input.provider.stream({
      model: input.model,
      system: [
        'You check whether a completed task addressed what was asked.',
        '',
        'Answer with one line and nothing else:',
        '  YES — <up to fifteen words>',
        '  NO — <up to fifteen words saying what was asked for and not delivered>',
        '',
        'Answer NO only when the result plainly does not address the request:',
        'it is about a different subject, or it describes what would be done',
        'instead of doing it. Anything arguable is YES. You are not judging',
        'quality, thoroughness or style — only whether this is an attempt at',
        'the thing that was asked for.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'What was asked for:',
                input.goal,
                '',
                'What the run produced:',
                input.answer || '(no written answer)',
                input.artifacts ? `\nFiles produced: ${input.artifacts}` : '',
              ].join('\n'),
            },
          ],
        },
      ],
      tools: [],
      maxTokens: 100,
      signal: controller.signal,
    });

    let text = '';
    for await (const event of stream) {
      if (event.type === 'text_delta') text += event.text;
    }
    return parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The verdict, or nothing.
 *
 * An unreadable reply is `null` rather than a guess in either direction.
 * Guessing YES would launder a broken judge into a pass that claims to have
 * been judged; guessing NO would fail a run over a formatting slip.
 */
function parse(text: string): { addressed: boolean; why: string } | null {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return null;
  const upper = line.toUpperCase();
  // Prefix-anchored: a "NO" appearing inside the explanation of a YES must not
  // flip the verdict.
  if (upper.startsWith('YES')) {
    return { addressed: true, why: reason(line) || 'The result addresses the request.' };
  }
  if (upper.startsWith('NO')) {
    return {
      addressed: false,
      why: reason(line) || 'The result does not address what was asked for.',
    };
  }
  return null;
}

function reason(line: string): string {
  const separator = line.indexOf('—') >= 0 ? '—' : '-';
  const at = line.indexOf(separator);
  return at < 0 ? '' : line.slice(at + separator.length).trim();
}
