"use client";

import * as React from "react";
import { VisualLearningBlockRenderer } from "@/components/chat/learning/visual-learning-renderer";
import { findLearningBlocks } from "@/lib/learning-blocks";

/* Realistic sample source — the same `:::` YAML the model emits in chat. */
const SAMPLES: { label: string; source: string }[] = [
  {
    label: "step-lab · full pipeline (compact)",
    source: `:::step-lab
title: How an LLM generates a reply
label: LLM Pipeline
description: A language model produces its answer one token at a time.
density: compact
takeaway: Everything a model writes is one next-token guess at a time, each conditioned on all the tokens before it.
steps:
- id: tokenize
  title: Tokenization
  summary: The text is split into tokens.
  detail: The model maps each token to a numerical ID from its fixed vocabulary. Rare words are split into several sub-word tokens, which is why token counts differ from word counts.
  notice: Click each token — the ID comes from a fixed vocabulary, not from meaning.
  visualType: tokenization
  data:
    input: "Swift is powerful"
    tokens:
    - text: "Swift"
      id: 1842
    - text: "is"
      id: 318
    - text: "powerful"
      id: 5271
- id: embed
  title: Embeddings
  summary: Tokens become vectors of meaning.
  detail: Each token ID looks up a learned vector. Words used in similar contexts end up with nearby vectors, letting the model compare meaning numerically.
  notice: Switch between tokens and watch the shape of the vector change — that shape IS the meaning.
  visualType: embedding
  data:
    examples:
    - token: "Swift"
      vector: [0.62, -0.31, 0.88, 0.14, -0.52]
    - token: "is"
      vector: [0.08, 0.12, -0.05, 0.31, 0.02]
    - token: "powerful"
      vector: [0.55, -0.44, 0.72, -0.18, 0.36]
- id: attention
  title: Attention
  summary: The model links related information.
  detail: Every token scores how relevant every other token is to it. High weights mean "look here when building my meaning" — this is how "it" finds what it refers to.
  visualType: attention
  data:
    tokens: ["Swift", "is", "powerful"]
    matrix:
    - [0.62, 0.2, 0.18]
    - [0.38, 0.24, 0.38]
    - [0.52, 0.14, 0.34]
- id: layers
  title: Transformer layers
  summary: Dozens of layers refine the representation.
  detail: Each layer mixes attention (context exchange) with feed-forward blocks (stored knowledge), plus residual connections that keep training stable.
  visualType: transformer-processing
  data:
    tokens: ["Swift", "is", "powerful"]
    layers: 24
- id: probabilities
  title: Probability distribution
  summary: The model scores possible next tokens.
  detail: The final layer projects onto the whole vocabulary and softmax turns scores into probabilities that sum to 1.
  visualType: probability-distribution
  data:
    candidates:
    - token: "and"
      probability: 0.34
      note: Continuing the list of qualities is the most likely direction.
    - token: "."
      probability: 0.27
      note: Ending the sentence is nearly as plausible.
    - token: "because"
      probability: 0.18
    - token: "for"
      probability: 0.12
    - token: "!"
      probability: 0.09
- id: select
  title: Next-token selection
  summary: One token is chosen and appended.
  detail: Sampling picks from the distribution (temperature controls how adventurous). The chosen token joins the prompt and the whole pass runs again — autoregression.
  visualType: next-token-selection
  data:
    prompt: "Swift is powerful"
    selectedToken: "and"
quiz:
  questions:
  - question: Why can a single word become several tokens?
    hint: The vocabulary has a fixed size, but text is unlimited.
    options:
    - label: The vocabulary is fixed, so rare words are split into sub-word pieces.
      correct: true
      explanation: Tokenizers cover any text with a finite vocabulary by composing rare words from frequent fragments.
    - label: The model randomly cuts long words to save memory.
    - label: Every syllable always becomes its own token.
  - question: What does the attention step let a token do?
    options:
    - label: Pull in information from other relevant tokens
      correct: true
      explanation: Attention scores how much each token should draw from every other token.
    - label: Change its own spelling
    - label: Skip the rest of the network
  - question: What is the model's final output at each step?
    options:
    - label: A probability for every possible next token
      correct: true
      explanation: The final layer scores the whole vocabulary, then softmax turns it into probabilities.
    - label: The single correct answer, always
    - label: A rewritten version of the prompt
:::`,
  },
  {
    label: "step-lab · generic process (comfortable)",
    source: `:::step-lab
title: How HTTPS protects a request
label: Security
description: From plaintext to an encrypted tunnel in three moves.
steps:
- id: hello
  title: Handshake
  summary: Client and server agree on keys.
  detail: The TLS handshake exchanges certificates and derives a shared session key without ever sending it over the wire.
  visualType: generic-process
  data:
    input: "ClientHello + ServerHello"
    transform: "Certificate check, key exchange"
    output: "Shared session key"
- id: encrypt
  title: Encryption
  summary: Data is sealed with the session key.
  detail: Symmetric encryption (AES-GCM) is fast and authenticated — tampering is detected, not just hidden.
  visualType: generic-process
  data:
    input: "Plain request"
    transform: "AES-GCM with session key"
    output: "Ciphertext + auth tag"
:::`,
  },
  {
    label: "learning-card · four tones",
    source: `:::learning-card
title: Idée centrale
icon: 🧠
tone: insight
content: Le Machine Learning consiste à ajuster progressivement des paramètres numériques afin qu'un modèle produise de meilleures prédictions.
:::

:::learning-card
title: Prefer composition over inheritance
tone: tip
content: Small pieces that combine are easier to test and reuse than deep class hierarchies.
:::

:::learning-card
title: Floating point comparisons
tone: warning
content: Never compare floats with ===. Accumulated rounding error means 0.1 + 0.2 !== 0.3 — compare against an epsilon instead.
:::

:::learning-card
title: Terminology
tone: note
content: "Parameters" are learned weights inside the model; "hyperparameters" are the knobs you choose before training starts.
:::`,
  },
  {
    label: "process-timeline · ML training cycle",
    source: `:::process-timeline
title: Le cycle général du Machine Learning
steps:
- label: Données
  description: Le modèle reçoit des exemples accompagnés ou non de réponses correctes.
- label: Prédiction
  description: Il produit une réponse à partir de ses paramètres actuels.
- label: Évaluation
  description: Une fonction de perte mesure l'écart entre sa prédiction et la réponse attendue.
- label: Ajustement
  description: La rétropropagation corrige chaque paramètre proportionnellement à sa contribution à l'erreur.
- label: Répétition
  description: Le cycle recommence des millions de fois jusqu'à convergence.
:::`,
  },
  {
    label: "comparison · SQL vs NoSQL vs NewSQL",
    source: `:::comparison
title: Choosing a database
columns: ["SQL", "NoSQL", "NewSQL"]
rows:
- label: Schema
  values: ["Fixed, enforced", "Flexible, per-document", "Fixed, enforced"]
- label: Scaling
  values: ["Vertical first", "Horizontal by design", "Horizontal with SQL semantics"]
- label: Transactions
  values: ["Full ACID", "Usually eventual", "Full ACID, distributed"]
- label: Best for
  values: ["Relational integrity", "Evolving shapes at scale", "Global OLTP"]
verdict: Choose by data shape and consistency needs, not fashion.
:::`,
  },
  {
    label: "quiz · multi-question + recap",
    source: `:::quiz
title: Check your understanding
questions:
- question: What does the model update during training?
  options:
  - The browser CSS
  - Its internal weights
  - The user's keyboard
  - The dataset labels
  answer: Its internal weights
  hint: Think about which part of the system is numerical and adjustable.
  explanation: Training adjusts the model's internal numerical parameters — the weights — to reduce prediction error.
- question: What is a loss function for?
  options:
  - Measuring how wrong a prediction is
  - Storing the training data
  - Rendering the user interface
  answer: Measuring how wrong a prediction is
  explanation: The loss quantifies the gap between prediction and target, and training minimizes it.
- question: What does backpropagation do?
  options:
  - Assigns blame for the error to each weight
  - Downloads a new model
  - Deletes incorrect examples
  answer: Assigns blame for the error to each weight
  hint: It works backwards from the loss.
  explanation: Backprop computes each weight's contribution to the error so it can be nudged the right way.
:::`,
  },
  {
    label: "quiz · single question (degrades cleanly)",
    source: `:::quiz
question: How many tokens does the word "unbelievable" usually become?
options:
- Several sub-word tokens
- Exactly one token, always
- One token per letter
answer: Several sub-word tokens
explanation: Longer or rarer words are split into multiple sub-word pieces.
:::`,
  },
  {
    label: "deep-dive · collapsed detail",
    source: `:::deep-dive
title: What is a vector embedding?
summary: A vector embedding is a list of numbers representing meaning.
content: Words with similar meanings sit close together in this numerical space, which lets the model compare concepts with simple arithmetic. Famously, king − man + woman lands near queen. Modern models use thousands of dimensions, and the same trick embeds whole sentences, images, and code.
:::`,
  },
];

function Section({ label, source }: { label: string; source: string }) {
  const blocks = React.useMemo(() => findLearningBlocks(source), [source]);
  return (
    <section className="flex flex-col gap-1">
      <h2 className="font-mono text-[11px] font-semibold text-muted-foreground">{label}</h2>
      <div className="prose-juno">
        {blocks.map((block) => (
          <VisualLearningBlockRenderer key={block.blockId} parsed={block} />
        ))}
        {blocks.length === 0 && <p className="text-sm text-destructive">Parser returned no blocks — check the sample.</p>}
      </div>
    </section>
  );
}

export function LearningGallery() {
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-4 py-10">
      <header>
        <p className="font-mono text-[11px] font-semibold text-primary">Dev gallery</p>
        <h1 className="pt-1 font-serif text-2xl font-semibold tracking-tight">Inline learning blocks</h1>
        <p className="pt-1 text-sm text-muted-foreground">
          Rendered through the real parser + renderer path at chat width (720px). Resize for mobile; toggle dark mode from the OS.
        </p>
      </header>
      {SAMPLES.map((sample) => (
        <Section key={sample.label} {...sample} />
      ))}
    </main>
  );
}
