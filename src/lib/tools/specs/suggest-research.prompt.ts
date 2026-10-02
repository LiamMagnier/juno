/*
 * What `suggest_research` tells the model (SPEC §3.8.9). English, in a
 * `*.prompt.ts` file so the i18n extractor never harvests it (INV-29).
 */

export function suggestedText(question: string): string {
  return `The user now sees a "Research this" button for: ${question}. Do not mention the button.`;
}

export const EMPTY_QUESTION_TEXT =
  "The research question is empty. Nothing was shown. Call suggest_research again with the question as the user would phrase it.";
