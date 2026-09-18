import { prisma } from "@/lib/prisma";
import { resolveSkillResources, type SkillResource } from "@/lib/work/skills";

/**
 * The write-time half of "a skill's files are the author's own files".
 *
 * A skill contract is a document a client sends, and a skill is the one Work
 * object a person acquires from somebody else — pasted out of a message,
 * imported from a repository, typed by a client nobody here wrote. So a list of
 * attachment ids arriving in one is a claim, and the only thing that makes it
 * true is a row carrying this user's id. Without this check a skill could name
 * an id it had no business naming and the executor would go and read whatever
 * it found; with it, an id that is not the caller's own file never reaches the
 * column at all.
 *
 * The executor checks again when it reads them, on `userId`, and that is not
 * redundancy for its own sake: the two checks answer different questions. This
 * one is "may this be written", asked once; the run's is "is this still one of
 * their files", asked every time, because a file can be deleted the day after a
 * version is minted.
 *
 * Missing and not-yours are answered identically by the callers, deliberately.
 * Distinguishing them would turn a skill route into an oracle for which
 * attachment ids exist in the product.
 */
export async function ownsEverySkillResource(
  userId: string,
  attachmentIds: readonly string[]
): Promise<boolean> {
  const wanted = [...new Set(attachmentIds)];
  if (wanted.length === 0) return true;

  const rows = await prisma.attachment.findMany({
    where: { id: { in: wanted }, userId, deletedAt: null },
    select: { id: true },
  });
  // A count, because the question is "are all of these yours" and the answer is
  // yes or no. Counted against the deduplicated list so a contract naming one
  // file twice is not read as naming two files, one of which is missing.
  return rows.length === wanted.length;
}

/**
 * The same lookup without the refusal, for a read path.
 *
 * A version minted last month can name a file deleted since. That is not an
 * error to answer a GET with — the version is exactly what it was — so the page
 * is told which of its files are still there and can say so, which is the
 * sentence a reader needs when the skill stops producing the document it used
 * to.
 *
 * Resolved through the same `resolveSkillResources` the executor uses, so the
 * ordering and deduplication rules are stated once. A page listing the files in
 * a different order from the one the run reads them in would be a second answer
 * to a question that has one.
 */
export async function readSkillResources(
  userId: string,
  attachmentIds: readonly string[]
): Promise<SkillResource[]> {
  if (attachmentIds.length === 0) return [];

  const rows = await prisma.attachment.findMany({
    where: { id: { in: [...new Set(attachmentIds)] }, userId, deletedAt: null },
    select: { id: true, fileName: true },
  });
  return resolveSkillResources({
    requested: attachmentIds,
    available: rows.map((row) => ({ attachmentId: row.id, fileName: row.fileName })),
  }).attached;
}
