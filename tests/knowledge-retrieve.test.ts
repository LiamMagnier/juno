import test from "node:test";
import assert from "node:assert/strict";
import {
  describeLocator,
  estimateTokens,
  packDocumentChunks,
  splitSentences,
  type ChunkableBlock,
} from "@/lib/knowledge/chunk";
import {
  cosineSimilarity,
  lexicalQueryExpression,
  packContext,
  reciprocalRankFusion,
  rerankPassages,
  stitchOverlapping,
  type ScoredPassage,
} from "@/lib/knowledge/rank";
import { lexicalCandidateQuery } from "@/lib/knowledge/lexical-query";
import { buildProjectContext, contextActivityDetail } from "@/lib/chat/context-assembly";

/*
 * Knowledge: chunking, ranking, packing.
 *
 * Everything here is the pure half of retrieval (lib/knowledge/chunk and
 * lib/knowledge/rank) plus the prompt section it feeds. The database half lives
 * in lib/knowledge/retrieve.ts, which needs a real Postgres to say anything
 * true — there is no database in tests, so the pieces that decide what the
 * model is shown were deliberately put where they can be exercised without one.
 */

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

let nextBlockId = 0;
function block(text: string, over: Partial<ChunkableBlock> = {}): ChunkableBlock {
  nextBlockId += 1;
  return {
    id: `b${nextBlockId}`,
    ordinal: nextBlockId,
    type: "paragraph",
    text,
    ...over,
  };
}

/** A paragraph of roughly `tokens` estimated tokens, in whole sentences. */
function paragraph(tokens: number, word: string): string {
  const sentences: string[] = [];
  // "word word word word." is ~5 tokens by the chars/4 estimate for a 4-letter word.
  while (estimateTokens(sentences.join(" ")) < tokens) {
    sentences.push(`${word} ${word} ${word} ${word} ${word} ${word}.`);
  }
  return sentences.join(" ");
}

test("chunks stay inside the token budget", () => {
  const blocks = Array.from({ length: 12 }, () => block(paragraph(90, "alpha")));
  const chunks = packDocumentChunks(blocks, { maxTokens: 200, overlapTokens: 30 });

  assert.ok(chunks.length > 1, "a 1000-token document must not be one chunk");
  for (const chunk of chunks) {
    assert.ok(
      chunk.tokens <= 200,
      `chunk ${chunk.ordinal} is ${chunk.tokens} tokens, over the 200 budget`
    );
  }
});

test("a block larger than the whole budget is split on sentences, never mid-sentence", () => {
  // A half-sentence embeds as a fragment nobody wrote and reads worse — a model
  // shown "…therefore we should not" finishes the thought itself.
  const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} ends here.`);
  const chunks = packDocumentChunks([block(sentences.join(" "))], {
    maxTokens: 60,
    overlapTokens: 10,
    includeHeadingBreadcrumb: false,
  });

  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.match(chunk.text.trim(), /\.$/, `chunk ${chunk.ordinal} ends mid-sentence`);
    for (const piece of splitSentences(chunk.text)) {
      assert.ok(
        sentences.includes(piece),
        `"${piece}" is not one of the original sentences — a sentence was cut`
      );
    }
  }
});

test("consecutive chunks overlap, so a fact across a boundary is findable from either side", () => {
  const blocks = Array.from({ length: 10 }, (_, i) => block(`Paragraph ${i} states a distinct fact.`));
  const chunks = packDocumentChunks(blocks, {
    maxTokens: 40,
    overlapTokens: 16,
    minTokens: 8,
    includeHeadingBreadcrumb: false,
  });

  assert.ok(chunks.length > 2);
  for (let i = 1; i < chunks.length; i++) {
    const shared = chunks[i - 1].blockIds.filter((id) => chunks[i].blockIds.includes(id));
    assert.ok(shared.length > 0, `chunks ${i - 1} and ${i} share no block — the overlap is missing`);
  }
});

test("overlap never swallows a whole chunk, so packing always advances", () => {
  // The overlap is seeded from the tail of the emitted chunk. Carrying the
  // whole chunk would make no progress and loop forever.
  const blocks = Array.from({ length: 40 }, (_, i) => block(`Short line ${i}.`));
  const chunks = packDocumentChunks(blocks, {
    maxTokens: 24,
    overlapTokens: 23,
    minTokens: 4,
    includeHeadingBreadcrumb: false,
  });
  assert.ok(chunks.length > 1);
  const covered = new Set(chunks.flatMap((chunk) => chunk.blockIds));
  assert.equal(covered.size, blocks.length, "every block must land in some chunk");
});

test("chunks preserve document order and record the blocks a citation resolves against", () => {
  const blocks = [
    block("Third paragraph.", { ordinal: 30 }),
    block("First paragraph.", { ordinal: 10 }),
    block("Second paragraph.", { ordinal: 20 }),
  ];
  const chunks = packDocumentChunks(blocks, { maxTokens: 400, includeHeadingBreadcrumb: false });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].ordinal, 0);
  assert.match(chunks[0].text, /First paragraph\.[\s\S]*Second paragraph\.[\s\S]*Third paragraph\./);
  // Ordered by the document, not by the order the rows arrived in.
  assert.deepEqual(chunks[0].blockIds, [blocks[1].id, blocks[2].id, blocks[0].id]);
});

test("ordinals are dense and monotonic, because reading order is restored from them", () => {
  const blocks = Array.from({ length: 20 }, () => block(paragraph(60, "beta")));
  const chunks = packDocumentChunks(blocks, { maxTokens: 150, overlapTokens: 20 });
  assert.deepEqual(
    chunks.map((chunk) => chunk.ordinal),
    chunks.map((_, i) => i)
  );
});

test("blank blocks contribute nothing, and an empty document is no chunks", () => {
  assert.deepEqual(packDocumentChunks([]), []);
  assert.deepEqual(packDocumentChunks([block("   "), block("\n\n")]), []);
});

test("a heading starts a section once the current chunk is substantial", () => {
  const blocks = [
    block("Intro paragraph one.", { type: "paragraph" }),
    block(paragraph(80, "gamma")),
    block("Refunds", { type: "heading" }),
    block("The customer may request one within 30 days."),
  ];
  const chunks = packDocumentChunks(blocks, {
    maxTokens: 400,
    minTokens: 40,
    includeHeadingBreadcrumb: false,
  });
  assert.equal(chunks.length, 2, "the heading should have opened a new chunk");
  assert.match(chunks[1].text, /^Refunds/);
});

test("the heading breadcrumb rides along, because the section title names the subject", () => {
  // "Refunds" followed by three paragraphs of "the customer may…" is only
  // findable by subject if the breadcrumb is in the chunk.
  const chunks = packDocumentChunks(
    [block("The customer may request one within 30 days.", { heading: ["Policy", "Refunds"] })],
    { maxTokens: 200 }
  );
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /^Policy › Refunds\n/);
});

test("CJK is not counted as a quarter of a token each", () => {
  // chars/4 is calibrated on English. A Chinese document chunked on it alone
  // produces chunks four times the intended size and is truncated provider-side
  // without an error.
  const chinese = "文字".repeat(100);
  assert.equal(estimateTokens(chinese), 200);
  assert.ok(estimateTokens(chinese) > estimateTokens("a".repeat(200)));

  const chunks = packDocumentChunks([block(`${chinese}。${chinese}。`)], {
    maxTokens: 120,
    includeHeadingBreadcrumb: false,
  });
  for (const chunk of chunks) assert.ok(chunk.tokens <= 120, `${chunk.tokens} tokens over budget`);
});

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

test("a locator says where the text physically is, per format", () => {
  assert.equal(describeLocator([{ page: 4 }]), "page 4");
  assert.equal(describeLocator([{ page: 4 }, { page: 6 }]), "pages 4–6");
  assert.equal(describeLocator([{ slide: 3 }]), "slide 3");
  assert.equal(describeLocator([{ sheet: "Sheet2", cellRange: "B7" }]), "Sheet2!B7");
  assert.equal(
    describeLocator([
      { sheet: "Sheet2", cellRange: "B7" },
      { sheet: "Sheet2", cellRange: "D9" },
    ]),
    "Sheet2!B7:D9"
  );
  assert.equal(describeLocator([{ path: "src/app.ts", lineStart: 10, lineEnd: 20 }]), "src/app.ts:10–20");
  assert.equal(describeLocator([{ lineStart: 10, lineEnd: 20 }]), "lines 10–20");
  assert.equal(describeLocator([{ heading: ["Policy", "Refunds"] }]), "Policy › Refunds");
  assert.equal(describeLocator([]), "");
  assert.equal(describeLocator([{}]), "", "nothing recorded is an empty locator, not a crash");
});

// ---------------------------------------------------------------------------
// Semantic scoring
// ---------------------------------------------------------------------------

test("cosine ranks the nearer vector first, and ignores magnitude", () => {
  const query = [1, 0, 0];
  assert.ok(cosineSimilarity(query, [1, 0, 0]) > cosineSimilarity(query, [0.5, 0.5, 0]));
  assert.ok(cosineSimilarity(query, [0.5, 0.5, 0]) > cosineSimilarity(query, [0, 1, 0]));
  // Same direction, ten times the length — similarity is unchanged.
  assert.ok(Math.abs(cosineSimilarity(query, [10, 0, 0]) - 1) < 1e-12);
  assert.ok(cosineSimilarity(query, [-1, 0, 0]) < 0);
});

test("vectors from different spaces score 0 rather than a plausible number", () => {
  // A chunk embedded before the deployment changed model. Comparing the two is
  // not a similarity, it is noise with a believable magnitude.
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, "a zero vector has no direction");
});

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

test("fusion rewards agreement between the two legs", () => {
  const lexical = ["a", "b", "c"];
  const semantic = ["c", "b", "z"];
  const fused = reciprocalRankFusion([lexical, semantic]);

  // "a" is first on one leg and absent from the other; "b" and "c" appear on
  // both. Agreement wins — which is the entire reason for fusing rather than
  // trusting either leg's top hit.
  assert.deepEqual(fused.slice(0, 2).map((entry) => entry.id), ["c", "b"]);
  assert.ok(fused[1].score > fused[2].score);
  assert.deepEqual(fused.map((entry) => entry.id).slice(2), ["a", "z"]);
  assert.deepEqual(
    fused.find((entry) => entry.id === "a")!.ranks,
    [1, null],
    "a passage missing from a leg records null, not a fabricated rank"
  );
});

test("fusion is stable: same inputs, same order, whatever order the lists come in", () => {
  const one = ["a", "b", "c", "d"];
  const two = ["d", "c", "b", "a"];
  const forward = reciprocalRankFusion([one, two]).map((entry) => entry.id);
  const backward = reciprocalRankFusion([two, one]).map((entry) => entry.id);

  // The legs disagree completely, so the ids pair off into exact score ties:
  // {a, d} at 1/61 + 1/64 and {b, c} at 1/62 + 1/63. Ties must resolve
  // identically every time, or retrieval reshuffles between two identical
  // questions — which reads as broken even though both orders are defensible.
  assert.deepEqual(forward, ["a", "d", "b", "c"]);
  assert.deepEqual(backward, forward, "the order the legs are passed in must not matter");
});

test("one leg alone still fuses", () => {
  const fused = reciprocalRankFusion([["a", "b"]]);
  assert.deepEqual(fused.map((entry) => entry.id), ["a", "b"]);
  assert.ok(fused[0].score > fused[1].score);
});

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-08T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function passage(over: Partial<ScoredPassage> & { chunkId: string }): ScoredPassage {
  return {
    documentId: "doc1",
    fileName: "handbook.pdf",
    mimeType: "application/pdf",
    projectId: null,
    ordinal: 0,
    text: "text",
    blockIds: [],
    documentAt: daysAgo(30),
    score: 0.01,
    lexicalRank: 1,
    semanticRank: null,
    locator: "",
    ...over,
  };
}

test("recency and scope nudge, they do not override relevance", () => {
  const relevant = passage({ chunkId: "relevant", score: 0.02, documentAt: daysAgo(2000) });
  const recentAndInProject = passage({
    chunkId: "recent",
    documentId: "doc2",
    score: 0.012,
    documentAt: NOW,
    projectId: "p1",
  });
  const ranked = rerankPassages([relevant, recentAndInProject], { now: NOW, projectId: "p1" });
  assert.equal(ranked[0].chunkId, "relevant", "a 1.4x nudge must not beat a 1.7x relevance gap");

  // Between two comparable passages, the recent in-project one wins.
  const close = passage({ chunkId: "close", score: 0.0125, documentAt: daysAgo(2000) });
  const ranked2 = rerankPassages([close, recentAndInProject], { now: NOW, projectId: "p1" });
  assert.equal(ranked2[0].chunkId, "recent");
});

test("source diversity stops one document from occupying every slot", () => {
  // A single long document with a matching heading otherwise fills the context,
  // and an answer from one source is both worse context and less trustworthy.
  const hogs = Array.from({ length: 5 }, (_, i) =>
    passage({ chunkId: `hog${i}`, ordinal: i, score: 0.02 - i * 0.0001 })
  );
  const other = passage({ chunkId: "other", documentId: "doc2", score: 0.0155 });
  const ranked = rerankPassages([...hogs, other], { now: NOW, limit: 3 });

  assert.equal(ranked[0].documentId, "doc1");
  assert.ok(
    ranked.slice(0, 3).some((entry) => entry.documentId === "doc2"),
    "the second document must reach the context"
  );
});

test("the rerank limit is honoured, and an empty candidate set is empty", () => {
  const many = Array.from({ length: 20 }, (_, i) => passage({ chunkId: `c${i}`, ordinal: i }));
  assert.equal(rerankPassages(many, { now: NOW, limit: 4 }).length, 4);
  assert.deepEqual(rerankPassages([], { now: NOW }), []);
  // An options object carrying an explicit undefined must not erase the default.
  assert.equal(rerankPassages(many, { now: NOW, limit: undefined }).length, 12);
});

// ---------------------------------------------------------------------------
// Context packing
// ---------------------------------------------------------------------------

test("neighbouring chunks are merged, not repeated", () => {
  const shared = "The refund window is thirty days from delivery.";
  const packed = packContext([
    passage({
      chunkId: "c2",
      ordinal: 2,
      score: 0.02,
      text: `Refunds › Window\n${shared} Requests after that are declined.`,
      blockIds: ["b2", "b3"],
    }),
    passage({
      chunkId: "c1",
      ordinal: 1,
      score: 0.019,
      text: `Refunds › Window\nCustomers may ask for a refund. ${shared}`,
      blockIds: ["b1", "b2"],
    }),
  ]);

  assert.equal(packed.passages.length, 1, "adjacent chunks must arrive as one passage");
  const merged = packed.passages[0];
  assert.equal(
    merged.text.split(shared).length - 1,
    1,
    "the overlap must appear once, not twice"
  );
  assert.match(merged.text, /Customers may ask for a refund\..*Requests after that are declined\./s);
  assert.deepEqual(merged.blockIds, ["b1", "b2", "b3"], "citations survive the merge, deduplicated");
});

test("non-adjacent chunks from the same document stay separate", () => {
  const packed = packContext([
    passage({ chunkId: "c1", ordinal: 1, text: "First part." }),
    passage({ chunkId: "c9", ordinal: 9, text: "Ninth part." }),
  ]);
  assert.equal(packed.passages.length, 2);
});

test("packing restores reading order after relevance scrambled it", () => {
  // A model shown page 9 above page 4 narrates the document backwards.
  const packed = packContext([
    passage({ chunkId: "late", ordinal: 9, score: 0.03, text: "Ninth." }),
    passage({ chunkId: "early", ordinal: 4, score: 0.02, text: "Fourth." }),
    passage({ chunkId: "other", documentId: "doc2", ordinal: 0, score: 0.025, text: "Elsewhere." }),
  ]);
  assert.deepEqual(
    packed.passages.map((entry) => entry.chunkId),
    ["early", "late", "other"],
    "most relevant document first, its passages in document order"
  );
});

test("the token budget is a ceiling, and a later small passage still fits", () => {
  const big = passage({ chunkId: "big", ordinal: 0, text: "x".repeat(4_000) }); // ~1000 tokens
  const small = passage({ chunkId: "small", documentId: "doc2", ordinal: 0, text: "short" });
  const packed = packContext([big, small], { tokenBudget: 60 });

  assert.deepEqual(packed.passages.map((entry) => entry.chunkId), ["small"]);
  assert.equal(packed.droppedForBudget, 1);
  assert.ok(packed.tokens <= 60);
});

test("stitching falls back to concatenation when there is no overlap", () => {
  assert.equal(stitchOverlapping("alpha.", "beta."), "alpha.\n\nbeta.");
  assert.equal(stitchOverlapping("", "beta."), "beta.");
  assert.equal(stitchOverlapping("alpha beta gamma", "beta gamma"), "alpha beta gamma");
});

// ---------------------------------------------------------------------------
// The lexical query
// ---------------------------------------------------------------------------

test("no tsquery operator survives a user's question", () => {
  // The expression is bound as a parameter, but a tsquery is its own little
  // language: an unescaped `!` or `<->` either errors or silently means
  // something else.
  const expression = lexicalQueryExpression("refund & !policy <-> (drop table users);")!;
  assert.ok(expression);
  for (const character of ["&", "!", "<", ">", "(", ")", ";", "'"]) {
    assert.ok(!expression.includes(character), `"${character}" survived sanitisation`);
  }
  assert.match(expression, /refund:\*/);
});

test("terms are ORed with prefixes, because a chunk that is never a candidate is never an answer", () => {
  const expression = lexicalQueryExpression("What is the refund window")!;
  // Stopwords go; "refund" and "window" stay, ORed.
  assert.equal(expression, "refund:* | window:*");
});

test("a question with nothing searchable has no query at all", () => {
  // to_tsquery('') is an error, not an empty result.
  assert.equal(lexicalQueryExpression("?! ..."), null);
  assert.equal(lexicalQueryExpression(""), null);
  assert.equal(lexicalQueryExpression("a"), null, "a single letter prefix-matches the corpus");
  // A question that is nothing but stopwords keeps them rather than vanishing.
  assert.equal(lexicalQueryExpression("what is this"), "what:* | is:* | this:*");
});

// ---------------------------------------------------------------------------
// The lexical statement
//
// This is the one query in the knowledge subsystem the ownership guard in
// db.ts cannot see: the guard is a Prisma query extension and $queryRaw is not
// a model operation. So the scoping is asserted here, on the composed
// statement, rather than trusted.
// ---------------------------------------------------------------------------

test("the account is bound into the statement twice, on the chunk and on the document", () => {
  const sql = lexicalCandidateQuery({
    userId: "user-1",
    expression: lexicalQueryExpression("refund window")!,
    withEmbeddings: false,
    limit: 120,
  });

  assert.match(sql.text, /c\."userId" = \$\d+/);
  assert.match(sql.text, /d\."userId" = \$\d+/);
  assert.equal(
    sql.values.filter((value) => value === "user-1").length,
    2,
    "both scopes must be the requesting account"
  );
  // Superseded versions keep their rows so old citations resolve, but must not
  // be answered from.
  assert.match(sql.text, /d\."supersededById" IS NULL/);
});

test("no user input reaches the SQL as text", () => {
  const hostile = "'; DROP TABLE \"KnowledgeChunk\"; --";
  const sql = lexicalCandidateQuery({
    userId: hostile,
    expression: lexicalQueryExpression("refund")!,
    filters: { projectId: hostile, documentIds: [hostile], mimeTypes: [hostile] },
    withEmbeddings: true,
    limit: 10,
  });

  assert.ok(!sql.text.includes("DROP TABLE"), "a value was interpolated into the statement");
  assert.ok(!sql.text.includes(hostile));
  assert.ok(sql.values.includes(hostile), "it must be a bound parameter instead");
  // The text-search configuration and the tsquery are parameters too.
  assert.match(sql.text, /to_tsquery\(\$\d+::regconfig, \$\d+\)/);
});

test("filters are added only when asked for, and null project means unfiled", () => {
  const none = lexicalCandidateQuery({
    userId: "u",
    expression: "refund:*",
    withEmbeddings: false,
    limit: 5,
  });
  // Both columns are in the SELECT list, so the assertion is on the predicate.
  assert.ok(!none.text.includes('d."projectId" ='));
  assert.ok(!none.text.includes('d."projectId" IS NULL'));
  assert.ok(!none.text.includes('d."mimeType" = ANY'));
  assert.ok(!none.text.includes('d."createdAt" >='));

  const unfiled = lexicalCandidateQuery({
    userId: "u",
    expression: "refund:*",
    filters: { projectId: null },
    withEmbeddings: false,
    limit: 5,
  });
  assert.match(unfiled.text, /d\."projectId" IS NULL/);

  const dated = lexicalCandidateQuery({
    userId: "u",
    expression: "refund:*",
    filters: { since: new Date("2026-01-01"), until: new Date("2026-06-01") },
    withEmbeddings: false,
    limit: 5,
  });
  assert.match(dated.text, /d\."createdAt" >= \$\d+/);
  assert.match(dated.text, /d\."createdAt" <= \$\d+/);
});

test("vector columns are selected only when there is a query vector to compare", () => {
  // A 3072-dimension embedding is ~24KB of JavaScript numbers per row; fetching
  // 120 of them for a lexical-only request is pure waste.
  const without = lexicalCandidateQuery({ userId: "u", expression: "a:*", withEmbeddings: false, limit: 5 });
  assert.ok(!without.text.includes('c."embedding"'));
  assert.match(without.text, /NULL::double precision\[\] AS "embedding"/);

  const with_ = lexicalCandidateQuery({ userId: "u", expression: "a:*", withEmbeddings: true, limit: 5 });
  assert.match(with_.text, /c\."embedding" AS "embedding"/);
});

// ---------------------------------------------------------------------------
// The prompt section
// ---------------------------------------------------------------------------

const retrieved = (over: Partial<Parameters<typeof buildProjectContext>[1] & object> = {}) => ({
  passages: [
    {
      documentId: "d1",
      fileName: "handbook.pdf",
      locator: "page 4",
      blockIds: ["b1"],
      text: "Refunds are granted within thirty days.",
    },
  ],
  indexedFileNames: ["handbook.pdf"],
  ...over,
});

test("a project with nothing indexed keeps exactly its old prompt", () => {
  // The whole boundary: retrieval must be invisible until something is indexed.
  const before = buildProjectContext({
    name: "Juno",
    instructions: "Be brief.",
    files: [{ fileName: "spec.md", extractedText: "the spec" }],
  });
  const after = buildProjectContext(
    { name: "Juno", instructions: "Be brief.", files: [{ fileName: "spec.md", extractedText: "the spec" }] },
    null
  );
  assert.equal(after, before);
  assert.ok(before.includes("### spec.md\nthe spec"));
});

test("an indexed file is cited, not dumped", () => {
  // Otherwise the document is in the prompt twice — once entire, once in
  // extract — and retrieval has bought nothing.
  const context = buildProjectContext(
    {
      name: "Juno",
      instructions: "",
      files: [
        { fileName: "handbook.pdf", extractedText: "THE ENTIRE HANDBOOK" },
        { fileName: "notes.md", extractedText: "loose notes" },
      ],
    },
    retrieved()
  );

  assert.ok(!context.includes("THE ENTIRE HANDBOOK"), "the indexed file must not be dumped whole");
  assert.ok(context.includes("### notes.md\nloose notes"), "an unindexed file is unaffected");
  assert.ok(context.includes("### handbook.pdf · page 4"), "the extract must carry its page");
  assert.ok(context.includes("Refunds are granted within thirty days."));
});

test("a degraded retrieval says so, rather than passing keyword hits off as more", () => {
  const degraded = buildProjectContext(
    { name: "Juno", instructions: "", files: [] },
    retrieved({ degraded: true })
  );
  assert.match(degraded, /Keyword matches only/);
  assert.match(degraded, /may be missing/);

  const healthy = buildProjectContext({ name: "Juno", instructions: "", files: [] }, retrieved());
  assert.ok(!healthy.includes("Keyword matches only"));
  assert.match(healthy, /Cite the source/);
});

test("a passage with no locator is still cited by file", () => {
  const context = buildProjectContext(
    { name: "Juno", instructions: "", files: [] },
    retrieved({
      passages: [
        { documentId: "d1", fileName: "notes.txt", locator: "", blockIds: ["b1"], text: "A line." },
      ],
    })
  );
  assert.ok(context.includes("### notes.txt\nA line."));
  assert.ok(!context.includes("·"));
});

test("the context line counts retrieved passages without changing the old line", () => {
  assert.equal(
    contextActivityDetail({ messages: 4, attachments: 0, memories: 0, hasProjectContext: true }),
    "4 messages · project context"
  );
  assert.equal(
    contextActivityDetail({
      messages: 4,
      attachments: 0,
      memories: 0,
      hasProjectContext: true,
      documentPassages: 3,
    }),
    "4 messages · 3 document passages · project context"
  );
  assert.equal(
    contextActivityDetail({
      messages: 4,
      attachments: 0,
      memories: 0,
      hasProjectContext: true,
      documentPassages: 1,
    }),
    "4 messages · 1 document passage · project context"
  );
});

// ---------------------------------------------------------------------------
// The degraded path, end to end over the pure pipeline
// ---------------------------------------------------------------------------

test("with no embeddings at all, lexical hits still rank, pack and cite", () => {
  // This is the shape of a deployment whose background-provider policy permits
  // no embedding provider — a `same_provider` policy on an Anthropic
  // conversation, for instance, since Anthropic has no embeddings endpoint. It
  // must be a working product, not an error.
  const lexicalOrder = ["c1", "c2", "c3"];
  const fused = reciprocalRankFusion([lexicalOrder]);
  const scored = fused.map((entry, index) =>
    passage({
      chunkId: entry.id,
      ordinal: index,
      score: entry.score,
      lexicalRank: index + 1,
      semanticRank: null,
      text: `Passage ${index} about refunds.`,
      blockIds: [`b${index}`],
    })
  );
  const packed = packContext(rerankPassages(scored, { now: NOW }));

  assert.ok(packed.passages.length > 0, "lexical-only must still return passages");
  for (const entry of packed.passages) {
    assert.equal(entry.semanticRank, null);
    assert.ok(entry.documentId, "every passage carries its document");
    assert.ok(entry.blockIds.length > 0, "every passage carries the blocks it cites");
  }
});
