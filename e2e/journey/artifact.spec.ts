import { expect, test } from "@playwright/test";
import {
  SMOKE_ARTIFACT_BODY,
  SMOKE_ARTIFACT_DIRECTIVE,
  SMOKE_ARTIFACT_TITLE,
  SMOKE_ARTIFACT_TOKEN,
} from "../../src/lib/chat/turn/model-streams";
import { conversationIdOf, expectNotStreaming, openNewChat, submitPrompt } from "./journey";

/*
 * Artifacts, end to end (ledger P1-5): an answer that carries an artifact
 * block becomes an artifact card in the transcript (never raw markup), opens
 * in the canvas, is stored as the user's artifact for this conversation, and
 * is still there after a reload.
 *
 * The smoke provider's artifact mode emits one closed markdown
 * <juno:artifact>, so the real parse, verification and persistence run.
 */

test.describe("Artifacts", () => {
  test("an artifact in an answer becomes a stored card that opens in the canvas", async ({ page }) => {
    test.setTimeout(120_000);
    await openNewChat(page);

    await submitPrompt(page, `Artifact probe: write a short note. ${SMOKE_ARTIFACT_DIRECTIVE}`);
    // The token is in the answer's own text, outside the artifact block. Read
    // from <main>, not the last .prose-juno, which may be the card's preview.
    await expect(page.locator("main")).toContainText(SMOKE_ARTIFACT_TOKEN, { timeout: 60_000 });
    await expectNotStreaming(page);
    const conversationId = await conversationIdOf(page);

    const card = page.getByRole("button", { name: `Open ${SMOKE_ARTIFACT_TITLE} in canvas` }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main")).not.toContainText("<juno:artifact");

    // Stored server-side as this user's artifact, in this conversation.
    const listed = await page.request.get("/api/artifacts");
    expect(listed.ok(), `GET /api/artifacts answered ${listed.status()}`).toBeTruthy();
    const { items } = (await listed.json()) as { items: Array<{ title: string; type: string; conversationId: string | null }> };
    expect(items.filter((item) => item.conversationId === conversationId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: SMOKE_ARTIFACT_TITLE, type: "MARKDOWN" })])
    );

    await card.click();
    await expect(page.getByRole("button", { name: "Close canvas" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(SMOKE_ARTIFACT_BODY, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/chat/${conversationId}`));
    await expect(page.getByRole("button", { name: `Open ${SMOKE_ARTIFACT_TITLE} in canvas` }).first()).toBeVisible({ timeout: 30_000 });
  });
});
