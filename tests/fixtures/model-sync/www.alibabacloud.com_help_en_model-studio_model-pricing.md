# Model inference pricing

<meta property="og:title" content="Model inference pricing" />

Model API calls are billed on a pay-as-you-go basis by default.

<Note>
  This document only lists <strong>standard prices</strong>. For the latest promotions, visit the [Model Studio console](https://modelstudio.console.alibabacloud.com/ap-southeast-1/model/market).
</Note>

<Note>
  Some models support <strong>context caching</strong> (explicit cache and implicit cache). Cache-hit input tokens and the tokens used to create an explicit cache are billed at unit prices different from the standard input price (for example, explicit cache creation is billed at 125% of the standard input price, and cache hits at 10%). The input prices in the tables below do <strong>not</strong> include cache prices. For cache billing rules, discount rates, and supported models, see [Context Cache](/help/en/model-studio/context-cache).
</Note>

## Tiered pricing rules <span id="d3be061317ozi" />

Some Model Studio models use tiered pricing. The unit price is determined by the total number of input tokens in a single request. All tokens in the request are billed at the unit price of the corresponding tier.

In the pricing tiers, K means 1,000 and M means 1,000,000. For example, 128K equals 128,000 tokens, 256K equals 256,000 tokens, and 1M equals 1,000,000 tokens.

For example, a model has two pricing tiers: 0 \< tokens ≤ 32K and 32K \< tokens ≤ 128K. If a request contains 100K input tokens, it falls into the second tier (32K \< 100K ≤ 128K), and all tokens are billed at the unit price of the second tier.

## Text generation - Qwen <span id="52500fd0880my" />

### Qwen-Max <span id="f82b6d3f48h8m" />

You are charged for input tokens and output tokens.

If the model supports [batch calls](/help/en/model-studio/batch-interfaces-compatible-with-openai), the unit price for both input and output tokens is 50% of the real-time inference price. If the model supports [context cache](/help/en/model-studio/context-cache), only input tokens receive a discount. These two discounts cannot apply simultaneously.

<Note>
  The following models offer a free quota only in Singapore. No free quota is available in other regions.
</Note>

<Tabs>
  <Tab title="Singapore">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>

            > <strong>Chain of thought + answer</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Free quota</strong>[(Note)](/help/en/model-studio/new-free-quota#591f3dfedfyzj)

            <sup>Valid for 90 days from the date of Model Studio activation, model release, or application approval, whichever is later</sup>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-0902

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > Currently equivalent to qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-06-08

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-preview

            > Currently equivalent to qwen3.7-max-2026-05-17
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-17
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.6-max-preview

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.8
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max

            > Currently equivalent to qwen3-max-2026-01-23

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2026-01-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2025-09-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-preview

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>
      </tbody>
    </table>

    ##### More models <span id="cbd82810644gh" />

    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />

        <col style={{ width: "14.285714%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Free quota</strong>[(Note)](/help/en/model-studio/new-free-quota#591f3dfedfyzj)

            <sup>Valid for 90 days from the date of Model Studio activation, model release, or application approval, whichever is later</sup>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen-max

            > 50% [batch inference](/help/en/model-studio/batch-interfaces-compatible-with-openai) discount
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            No tiered pricing
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>
      </tbody>
    </table>
  </Tab>

  <Tab title="China (Beijing)">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>

            > <strong>Chain of thought + answer</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-prime

            > For more details, see [Fast mode (Prime)](/help/en/model-studio/prime-mode)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.301
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$9.902
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > 50% [batch inference](/help/en/model-studio/batch-interfaces-compatible-with-openai) discount

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-0902

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > Currently equivalent to qwen3.7-max-2026-05-20

            > 50% [batch inference](/help/en/model-studio/batch-interfaces-compatible-with-openai) discount

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-06-08

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.6-max-preview

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.238
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.426
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.063
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12.377
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max

            > Currently equivalent to qwen3-max-2026-01-23

            > 50% [batch inference](/help/en/model-studio/batch-interfaces-compatible-with-openai) discount

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.359
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.574
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.294
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.004
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.014
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2026-01-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.359
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.574
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.294
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.004
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.014
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2025-09-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.861
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.441
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$5.735
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.151
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$8.602
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-preview

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.861
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.441
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$5.735
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.151
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$8.602
          </td>
        </tr>
      </tbody>
    </table>

    ##### More models <span id="3ac7ff9a27nxw" />

    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}><colgroup><col style={{ width: "16.666667%" }} /><col style={{ width: "16.666667%" }} /><col style={{ width: "16.666667%" }} /><col style={{ width: "16.666667%" }} /><col style={{ width: "16.666667%" }} /><col style={{ width: "16.666667%" }} /></colgroup><thead><tr><th style={{ verticalAlign: "top" }}><p><strong>Model ID</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>Deployment scope</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>Mode</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>Input tokens per request</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>Input price (per 1 million tokens)</strong></p></th><th style={{ verticalAlign: "top" }}><p><strong>Output price (per 1 million tokens)</strong></p></th></tr></thead><tbody><tr><td style={{ verticalAlign: "top" }}><p>qwen-max</p></td><td style={{ verticalAlign: "top" }}><p>Chinese mainland</p></td><td style={{ verticalAlign: "top" }}><p>Non-Thinking mode only</p></td><td style={{ verticalAlign: "top" }}><p>No tiered pricing</p></td><td style={{ verticalAlign: "top" }}><p>\$0.345</p></td><td style={{ verticalAlign: "top" }}><p>\$1.377</p></td></tr></tbody></table>
  </Tab>

  <Tab title="Hong Kong (China)">
    <Note>
      The following table shows <strong>list prices</strong>. Some models offer limited-time night/daytime discounts (see labels next to prices). Night hours: 22:00 to 08:00 (UTC+8), based on billing time; other hours are daytime hours.
    </Note>

    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.75%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>

            > <strong>Chain of thought + answer</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-0902

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > Currently equivalent to qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-06-08

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max

            > Currently equivalent to qwen3-max-2026-01-23

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Hong Kong (China)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2026-01-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Hong Kong (China)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>
      </tbody>
    </table>
  </Tab>

  <Tab title="Germany (Frankfurt)">
    <Note>
      The following table shows <strong>list prices</strong>. Some models offer limited-time night/daytime discounts (see labels next to prices). Night hours: 22:00 to 08:00 (UTC+8), based on billing time; other hours are daytime hours.
    </Note>

    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.75%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>

            > <strong>Chain of thought + answer</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-0902

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > Currently equivalent to qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-06-08

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max

            > Currently equivalent to qwen3-max-2026-01-23

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.359
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.574
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.294
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.004
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.014
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max

            > Currently equivalent to qwen3-max-2026-01-23

            > 50% [batch inference](/help/en/model-studio/batch-interfaces-compatible-with-openai) discount

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            EU
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2026-01-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            EU
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$15
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2025-09-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.861
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.441
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$5.735
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.151
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$8.602
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-preview

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.861
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.441
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$5.735
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.151
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$8.602
          </td>
        </tr>
      </tbody>
    </table>
  </Tab>

  <Tab title="US (Virginia)">
    <Note>
      The following table shows <strong>list prices</strong>. Some models offer limited-time night/daytime discounts (see labels next to prices). Night hours: 22:00 to 08:00 (UTC+8), based on billing time; other hours are daytime hours.
    </Note>

    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.65%" }} />

        <col style={{ width: "16.75%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>

            > <strong>Chain of thought + answer</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            US
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-0902

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > Currently equivalent to qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            US
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$7.5
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-06-08

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-20

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max

            > Currently equivalent to qwen3-max-2026-01-23

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.359
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.574
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.294
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.004
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.014
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-2025-09-23
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking mode only
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.861
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.441
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$5.735
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.151
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$8.602
          </td>
        </tr>

        <tr>
          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            qwen3-max-preview

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td rowSpan={3} style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤32K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.861
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.441
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            32K\<Token≤128K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.434
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$5.735
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            128K\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.151
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$8.602
          </td>
        </tr>
      </tbody>
    </table>
  </Tab>

  <Tab title="Japan (Tokyo)">
    <Note>
      The following table shows <strong>list prices</strong>. Some models offer limited-time night/daytime discounts (see labels next to prices). Night hours: 22:00 to 08:00 (UTC+8), based on billing time; other hours are daytime hours.
    </Note>

    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "16.73%" }} />

        <col style={{ width: "16.73%" }} />

        <col style={{ width: "16.73%" }} />

        <col style={{ width: "16.73%" }} />

        <col style={{ width: "16.73%" }} />

        <col style={{ width: "16.35%" }} />
      </colgroup>

      <thead>
        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>

            > <strong>Chain of thought + answer</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.8-max-0902

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max

            > Currently equivalent to qwen3.7-max-2026-05-20

            > [Context Cache](/help/en/model-studio/context-cache) context caching discount
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen3.7-max-2026-05-20

            > [Context Cache](/help/en/model-studio/context-cache) context caching discount
          </td>

          <td style={{ verticalAlign: "top" }}>
            Global
          </td>

          <td style={{ verticalAlign: "top" }}>
            Non-Thinking and Thinking modes
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.65
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.951
          </td>
        </tr>
      </tbody>
    </table>
  </Tab>
</Tabs>

### Qwen-Plus <span id="3ca9f7fa60u88" />

You are charged for input tokens and output tokens.

<Note>
  The following models offer a free quota only in Singapore. No free quota is available in other regions.
</Note>

<Tabs>
  <Tab title="Singapore">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "14.3%" }} />

        <col style={{ width: "14.3%" }} />

        <col style={{ width: "14.3%" }} />

        <col style={{ width: "14.3%" }} />

        <col style={{ width: "14.3%" }} />

        <col style={{ width: "14.3%" }} />

        <col style={{ width: "14.2%" }} />
      </colgroup>

      <thead>
        <tr>
          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Deployment scope</strong>
          </th>

          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th colSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>
          </th>

          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Free quota</strong>[(Note)](/help/en/model-studio/new-free-quota#591f3dfedfyzj)

            <sup>Valid for 90 days from the date of Model Studio activation, model release, or application approval, whichever is later</sup>
          </th>
        </tr>

        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Non-Thinking mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Thinking mode (chain of thought + answer)</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.7-plus

            > Currently equivalent to qwen3.7-plus-2026-05-26

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$0.4 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$1.6 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$1.6 <strong>(Limited-time 20% off)</strong>
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$1.2 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$4.8 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$4.8 <strong>(Limited-time 20% off)</strong>
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.7-plus-2026-05-26

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.6
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.8
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4.8
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.6-plus

            > Currently equivalent to qwen3.6-plus-2026-04-02
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.6-plus-2026-04-02
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$6
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.5-plus

            > Currently equivalent to qwen3.5-plus-2026-02-15
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.5-plus-2026-04-20
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.5-plus-2026-02-15
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$2.4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.5
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen-plus

            > Currently equivalent to qwen-plus-2025-12-01
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen-plus-latest
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen-plus-2025-12-01
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen-plus-2025-09-11
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen-plus-2025-07-28
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.6
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$12
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen-plus-2025-07-14
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            No tiered pricing
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen-plus-2025-04-28
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            No tiered pricing
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$4
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            qwen-plus-2025-01-25
          </td>

          <td style={{ verticalAlign: "top" }}>
            International
          </td>

          <td style={{ verticalAlign: "top" }}>
            No tiered pricing
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.4
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.2
          </td>

          <td style={{ verticalAlign: "top" }}>
            -
          </td>

          <td style={{ verticalAlign: "top" }}>
            1 million tokens
          </td>
        </tr>
      </tbody>
    </table>
  </Tab>

  <Tab title="China (Beijing)">
    <table style={{ display: "table", tableLayout: "fixed", width: "100%", overflowWrap: "anywhere" }}>
      <colgroup>
        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />

        <col style={{ width: "20%" }} />
      </colgroup>

      <thead>
        <tr>
          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Model ID</strong>
          </th>

          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Input tokens per request</strong>
          </th>

          <th rowSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Input price (per 1 million tokens)</strong>
          </th>

          <th colSpan={2} style={{ verticalAlign: "top" }}>
            <strong>Output price (per 1 million tokens)</strong>
          </th>
        </tr>

        <tr>
          <th style={{ verticalAlign: "top" }}>
            <strong>Non-Thinking mode</strong>
          </th>

          <th style={{ verticalAlign: "top" }}>
            <strong>Thinking mode (chain of thought + answer)</strong>
          </th>
        </tr>
      </thead>

      <tbody>
        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.7-plus

            > Currently equivalent to qwen3.7-plus-2026-05-26

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$0.276 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$1.101 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$1.101 <strong>(Limited-time 20% off)</strong>
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$0.826 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$3.301 <strong>(Limited-time 20% off)</strong>
          </td>

          <td style={{ verticalAlign: "top" }}>
            List price \$3.301 <strong>(Limited-time 20% off)</strong>
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.7-plus-2026-05-26

            > [context caching discount](/help/en/model-studio/context-cache)
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.276
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.101
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$1.101
          </td>
        </tr>

        <tr>
          <td style={{ verticalAlign: "top" }}>
            256K\<Token≤1M
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$0.826
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.301
          </td>

          <td style={{ verticalAlign: "top" }}>
            \$3.301
          </td>
        </tr>

        <tr>
          <td rowSpan={2} style={{ verticalAlign: "top" }}>
            qwen3.6-plus

            > Currently equivalent to qwen3.6-plus-2026-04-02
          </td>

          <td style={{ verticalAlign: "top" }}>
            0\<Token≤256K
          </td>

          <td style={{ verticalAlign: "top" }}>
      </Tab>

### Qwen-Omni <span id="ea2cc071fdn3e" />

Pricing rule: billed by input tokens and output tokens. For the token calculation rules of different modalities, see [Billing and rate limits](/help/en/model-studio/qwen-omni#12db7427b94qt).

<Note>
  The Qwen3.5-Omni, Qwen3-Omni, and Qwen-Omni-Turbo series offer a free quota only in Singapore. No free quota is available in other regions.
</Note>

<Tabs>
  <Tab title="Singapore">
| Model ID             | Deployment scope | Input price (per million tokens) | Cache-hit input price (per million tokens) | Output price (per million tokens) |
| -------------------- | ---------------- | -------------------------------- | ------------------------------------------ | --------------------------------- |
| `qwen3.8-omni-flash` | International    | USD 0.15                         | USD 0.016                                  | USD 0.47                          |

  </Tab>
</Tabs>
