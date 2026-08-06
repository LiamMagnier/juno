# Subprocessor inventory

**Derived from the code, not from the privacy policy.** This is the factual list
of third parties that can receive personal data when Juno runs, produced so a
lawyer has something accurate to work from. It is **not legal advice and not a
published notice** — `/legal/confidentialite` is the published document, and it
does not currently match this list.

Generated 2026-07-31 from `src/lib/providers.ts`, `src/lib/env.ts` and the
service modules named below. Re-derive it when a provider is added.

## What the published policy says today

`/legal/confidentialite` §4 "Destinataires et sous-traitants" lists three
entries:

1. **Hébergeur** — still the literal placeholder
   `[Hébergeur — ex. Google Cloud Platform, machine virtuelle localisée à préciser]`.
   Unfilled, in a published document.
2. **Stripe** — correct.
3. **Fournisseurs de modèles d'IA** — named only by example: "par exemple
   Anthropic, OpenAI, Google, ou d'autres fournisseurs proposés dans le
   Service."

GDPR Art. 13(1)(e) requires the recipients or *categories* of recipients, and
Art. 28 requires the controller to know its processors. "For example, and
others" is not a category. Six subprocessors are not mentioned at all.

## Model providers — receive prompt text and attachments

Every one of these can receive the full content of a message, because the user
picks the model. `src/lib/providers.ts`, 14 entries:

| Provider | Notes |
|---|---|
| Anthropic · Claude | US |
| OpenAI · GPT | US |
| Google · Gemini | US |
| Mistral | EU (France) |
| Meta · Muse | US |
| SpaceXAI · Grok | US |
| ByteDance · Seedance | PRC-headquartered |
| Zhipu · GLM | PRC |
| Moonshot · Kimi | PRC |
| DeepSeek | PRC |
| MiniMax | PRC |
| MiMo · Xiaomi | PRC |
| Alibaba · Qwen | PRC — international endpoint defaults to Singapore |
| Meituan · LongCat | PRC |

Seven of the fourteen are PRC-based. `docs/JUNO.md` already flags the
Qwen/Alibaba case; the other six are not flagged anywhere.

Note also that realtime voice streams audio to whichever realtime provider is
configured (OpenAI, Google Gemini Live, MiniMax, or Qwen/DashScope — see
`relay/`), which is the same disclosure question for a different data type.

## Other subprocessors

| Party | Purpose | Where it appears |
|---|---|---|
| **Supabase** | PostgreSQL (eu-west-1). Holds accounts and conversations (bodies encrypted at rest) | `DATABASE_URL`, `prisma/schema.prisma` |
| **Stripe** | Payments | `src/lib/stripe.ts` |
| **Tavily** | Web search + page fetch for deep research; receives the user's query | `src/lib/deep-research.ts` |
| **Composio** | Connector/tool brokerage — ~1,048 toolkits; receives tool arguments | `src/lib/composio.ts` |
| **Resend** | Transactional email; receives the user's email address | `src/lib/email.ts` |
| **S3-compatible object storage** | Attachments and avatars. Currently **unconfigured** — uploads are on the VM's local disk (see JUNO.md §20.7) | `src/lib/storage.ts` |
| **The VM host** | Oracle Cloud or GCP, per `deploy/`. This is the unfilled placeholder above | `deploy/VM_SETUP_GUIDE.md` |

## What a lawyer needs to decide

1. **Name them, or name categories properly.** Either list is defensible; "for
   example" is not.
2. **The transfer mechanism for each non-EU processor.** The policy asserts
   "clauses contractuelles types … ou mécanismes d'adéquation équivalents" as a
   blanket statement. For the seven PRC-based providers there is no adequacy
   decision, so SCCs plus a transfer impact assessment is the usual route — and
   whether each provider will actually sign SCCs is a question of fact, not
   drafting.
3. **Fill the `[Hébergeur]` placeholder.** It is live on a published page.
4. **Whether a DPA exists with each.** Art. 28 requires one with every processor.

## Related, and separate

`docs/JUNO.md` §20.7 records that uploads currently have no redundancy. That is
an availability issue rather than a disclosure one, but the same audit should
settle where user files actually live before this document claims it.
