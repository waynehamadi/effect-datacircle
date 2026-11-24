# Datacircle tools for Effect AI

Find the best GTM APIs. We benchmark all the GTM APIs and we put the results on our website. GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use.

Our website: https://datacircle.dev

This package gives four tools as a toolkit for [Effect](https://github.com/Effect-TS/effect)'s `effect/ai`: for `LanguageModel.generateText`, a `Chat` and an `McpServer`. The tools call Datacircle's open API, https://api.datacircle.dev/v1. You need no key and no account.

| Tool | What the tool gives | Call |
| --- | --- | --- |
| `datacircle_list_apis` | Every GTM API on Datacircle, with the API's slug, number of plans, number of providers and best plan | `GET /apis` |
| `datacircle_best_plans` | One API's plans, best score out of 100 first. Each plan comes with a rank and a price per 1,000 calls | `GET /apis/{slug}/best` |
| `datacircle_search_plans` | Plans that match a provider or plan name, on all APIs or on one API. You can sort them by score, provider or price | `GET /plans` |
| `datacircle_provider` | The APIs a provider sells, and the provider's rank on each API | `GET /providers/{slug}` |

## Install

```bash
npm install @datacircle/effect
```

The package works on effect 4.0.0 and later. It uses your app's `effect` and needs no other package.

## Give the tools to a model

`DatacircleToolkit` holds the four tools. `DatacircleLayer` runs them. This example uses `@effect/ai-openai`, and any provider of `effect/ai` works the same way:

```ts
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Effect, Layer } from "effect";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { DatacircleLayer, DatacircleToolkit } from "@datacircle/effect";

const OpenAi = OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") })
  .pipe(Layer.provide(FetchHttpClient.layer));

const program = Effect.gen(function* () {
  const toolkit = yield* DatacircleToolkit;
  const response = yield* LanguageModel.generateText({
    prompt: "Who are the 3 best providers for the email-finder API?",
    toolkit,
  });
  for (const result of response.toolResults) {
    console.log(result.name, result.isFailure ? "failed" : "answered");
  }
});

program.pipe(
  Effect.provide(OpenAiLanguageModel.model("gpt-5.2")),
  Effect.provide([DatacircleLayer, OpenAi]),
  Effect.runPromise,
);
```

`generateText` runs the tools the model calls and gives you their results. To let the model read the results and answer, use a `Chat`, as shown next.

## Add the tools beside your own, in a Chat

`Toolkit.merge` puts our tools in your toolkit. Then give both layers. A `Chat` keeps the history, so the model can call tools until it answers:

```ts
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Effect, Layer, Schema } from "effect";
import { Chat, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { DatacircleLayer, DatacircleToolkit } from "@datacircle/effect";

const TeamBudget = Tool.make("team_budget", {
  description: "Gives the sales team's monthly budget for data, in dollars.",
  success: Schema.Struct({ monthly: Schema.Number }),
});
const MyToolkit = Toolkit.make(TeamBudget);
const MyToolkitLayer = MyToolkit.toLayer({ team_budget: () => Effect.succeed({ monthly: 500 }) });

const Tools = Toolkit.merge(MyToolkit, DatacircleToolkit);

const OpenAi = OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") })
  .pipe(Layer.provide(FetchHttpClient.layer));

const program = Effect.gen(function* () {
  const toolkit = yield* Tools;
  const chat = yield* Chat.fromPrompt([
    { role: "system", content: "You answer questions about GTM APIs with the tools." },
    { role: "user", content: "Which email-verification plan is best, and does it fit our budget?" },
  ]);
  while (true) {
    const response = yield* chat.generateText({ prompt: [], toolkit });
    if (response.toolCalls.length === 0) return response.text;
  }
});

program.pipe(
  Effect.provide(OpenAiLanguageModel.model("gpt-5.2")),
  Effect.provide([MyToolkitLayer, DatacircleLayer, OpenAi]),
  Effect.runPromise,
).then(console.log);
```

## Serve the tools from an MCP server

`McpServer.toolkit` serves the four tools to any MCP client, with your own tools if you add them. This server runs over stdio:

```ts
import { Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { DatacircleLayer, DatacircleToolkit } from "@datacircle/effect";

const Tools = McpServer.toolkit(DatacircleToolkit).pipe(Layer.provide(DatacircleLayer));

const Server = McpServer.layerStdio({
  name: "gtm-tools",
  version: "1.0.0",
  protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25],
});

Tools.pipe(Layer.provide(Server), Layer.provide(NodeStdio.layer), Layer.launch, NodeRuntime.runMain);
```

For HTTP, use `McpServer.layerHttp({ ..., path: "/mcp" })` with `HttpRouter.serve`. Each tool is marked read-only. When a call fails, the client gets an error result (`isError`).

## Set your own fetch and base URL

`layer(options)` runs the tools with your own `fetch` and `baseURL`. Pass your own `fetch` to call through a proxy or in tests. Give the layer in place of `DatacircleLayer`:

```ts
import { layer } from "@datacircle/effect";

const MyDatacircleLayer = layer({ fetch: myFetch });
```

## Make each call yourself

You can make each call without a model. Each call is an Effect that gives the answer as an object:

```ts
import { Effect } from "effect";
import { bestPlans } from "@datacircle/effect";

const answer = await Effect.runPromise(bestPlans({ slug: "email-finder", limit: 3 }));
console.log(answer.plans);
```

The other calls are `listApis()`, `searchPlans()` and `providerRanks()`. When the API refuses a call, the Effect fails with a `DatacircleError`.

## What the model reads

Each tool gives the model a JSON object. Each plan comes with a rank, provider, plan, score, price per 1,000 (`perThousand`, in dollars) and a page on datacircle.dev. The page on datacircle.dev lists every field.

For an unknown slug, the tool returns a `DatacircleError` to the model, with the API's message and the tool to call instead. If the network fails, the model gets a `DatacircleError` with the network error's message. The model can then call again and keep working, and your program goes on. If an argument does not fit the tool's schema, `effect/ai` gives the model an error that names the argument. If you interrupt a tool call, its request stops. Each call runs in a span named `datacircle.<tool>`, such as `datacircle.best_plans`.

## Network

Each tool call sends one GET request to https://api.datacircle.dev/v1. It sends a second or third one only to try again with a corrected name, such as `serp` for `serp-api`. Each request holds only the tool's own arguments: no key and nothing from your chats. The API takes up to 60 calls a minute from one IP address. After a 429 answer (too many calls), the tool waits up to a minute and tries once more. The package stores nothing.

## Links

- Datacircle: https://datacircle.dev
- The API: https://datacircle.dev/api
- The API's spec: https://api.datacircle.dev/v1/openapi.json
- What each key means: https://datacircle.dev/fields

MIT license.
