/**
 * Demo message exercising the full inline visual learning system:
 * learning card → compact step lab (all major visuals) → quiz.
 * Injected locally via the composer's /learn-demo command (no API call) so
 * the blocks can be exercised — streaming states, interactions, fallbacks —
 * without spending tokens.
 */
export const STEP_LAB_DEMO_MESSAGE = `# How LLMs Predict the Next Token

An LLM generates text by repeatedly predicting the most likely next token from the context.

:::learning-card
title: Core intuition
icon: 🧠
tone: insight
content: The model is not searching a database. It is calculating which token is statistically most likely to come next based on everything it has seen so far.
:::

:::step-lab
title: The Next-Token Prediction Pipeline
label: Step Lab
description: A compact interactive walkthrough of how a language model turns text into the next token.
density: compact
steps:
- id: tokenization
  title: Tokenization
  summary: Text is split into tokens.
  detail: The model first converts your text into small units called tokens. Tokens can be words, word pieces, or punctuation.
  visualType: tokenization
  data:
    input: "The model predicts the next word"
    tokens:
    - text: "The"
      id: 791
    - text: "model"
      id: 2746
    - text: "predicts"
      id: 42119
    - text: "the"
      id: 279
    - text: "next"
      id: 1828
    - text: "word"
      id: 3492
- id: embeddings
  title: Embeddings
  summary: Tokens become vectors.
  detail: Each token ID is mapped to a vector, which is a list of numbers that represents meaning and relationships.
  visualType: embedding
  data:
    examples:
    - token: "model"
      vector: [0.12, -0.44, 0.87, 0.31]
    - token: "predicts"
      vector: [0.52, 0.11, -0.73, 0.24]
- id: attention
  title: Attention
  summary: Tokens look at each other.
  detail: Attention helps the model decide which previous words matter most for understanding the current context.
  visualType: attention
  data:
    tokens: ["The", "model", "predicts", "the", "next", "word"]
    matrix:
    - [0.1, 0.3, 0.2, 0.1, 0.2, 0.1]
    - [0.2, 0.1, 0.4, 0.1, 0.1, 0.1]
    - [0.1, 0.4, 0.1, 0.1, 0.2, 0.1]
    - [0.1, 0.1, 0.2, 0.1, 0.4, 0.1]
    - [0.1, 0.1, 0.2, 0.2, 0.1, 0.3]
    - [0.2, 0.1, 0.1, 0.2, 0.3, 0.1]
- id: probabilities
  title: Probability Distribution
  summary: The model scores possible next tokens.
  detail: The model produces a probability distribution over possible next tokens.
  visualType: probability-distribution
  data:
    candidates:
    - token: "word"
      probability: 0.42
    - token: "step"
      probability: 0.25
    - token: "token"
      probability: 0.18
    - token: "idea"
      probability: 0.1
    - token: "."
      probability: 0.05
- id: output
  title: Next Token
  summary: One token is selected.
  detail: The chosen token is added to the text, then the whole process repeats.
  visualType: next-token-selection
  data:
    prompt: "The model predicts the next"
    selectedToken: "word"
:::

The pipeline above runs once per generated token — notice how the probability step feeds directly into the selection step, then loops.

:::process-timeline
title: The generation loop
steps:
- label: Context in
  description: The prompt plus everything generated so far.
- label: Forward pass
  description: Tokenize, embed, attend, and score candidates.
- label: Select token
  description: Sample one token from the probability distribution.
- label: Append & repeat
  description: The new token joins the context and the loop runs again.
:::

:::deep-dive
title: What is a vector embedding?
summary: A vector embedding is a list of numbers representing meaning.
content: Words with similar meanings tend to have vectors that are closer together in mathematical space. This lets the model compare concepts numerically — "cat" and "kitten" land near each other, while "cat" and "carburetor" land far apart. Distance in this space is what the model actually reasons over.
:::

:::quiz
question: What is the model actually predicting at each generation step?
options:
- The next full paragraph
- The next token
- The user's intention exactly
answer: The next token
explanation: The model repeatedly predicts one token at a time, then uses the updated context to predict the following token.
:::

**Recap:** tokenize → embed → attend → score → select, once per token. The "intelligence" lives in how the probability distribution shifts with context.`;
