export const CLARIFICATION_WIZARD_DEMO_MESSAGE = `I can help you write the blog series, but I need one detail first.

:::clarification-wizard
title: Blog series setup
description: Choose the closest answer, or type your own.
mode: step-by-step
questions:
- id: topic
  question: What’s the topic or theme for the blog series, and who’s the target audience?
  type: single-choice
  options:
  - AI & Tech for professionals
  - Marketing & Growth for startups
  - Health & Wellness for general readers
  - Something else
  allowCustom: true
  customPlaceholder: Something else
  required: false
- id: tone
  question: What tone should the blog series use?
  type: single-choice
  options:
  - Professional
  - Friendly and simple
  - Deep and technical
  - Storytelling
  allowCustom: true
  customPlaceholder: Describe the tone
  required: false
submitLabel: Continue
skipLabel: Skip
closeLabel: Close
:::`;
