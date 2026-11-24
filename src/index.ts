// Effect AI tools on Datacircle's open API: find the best GTM APIs. The API needs no key:
// https://api.datacircle.dev/v1 (its spec: https://api.datacircle.dev/v1/openapi.json). More at https://datacircle.dev

import { Effect, Schema } from 'effect';
import { Tool, Toolkit } from 'effect/ai';
import { BASE_URL, Client, VERSION } from './client.js';
import type { Answer, DatacircleOptions } from './client.js';
import { bestPlansRun, listApisRun, providerRun, searchPlansRun } from './runs.js';
import type { BestPlansInput, ListApisInput, ProviderInput, SearchPlansInput } from './runs.js';

export { BASE_URL, VERSION };
export type { Answer, BestPlansInput, DatacircleOptions, ListApisInput, ProviderInput, SearchPlansInput };

const LIST_APIS_ABOUT = "Lists the GTM APIs on Datacircle's sheet (https://datacircle.dev). GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use. Gives each API's slug, how many plans and providers it has and its best plan. Call it first to find an API's slug.";
const BEST_PLANS_ABOUT = "Gives an API's plans best first by their score out of 100 on Datacircle's benchmark (https://datacircle.dev), each with its rank, provider, plan, $ per 1,000 calls and its page. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const SEARCH_PLANS_ABOUT = "Searches every plan on Datacircle's sheet (https://datacircle.dev), or one API's, by provider or plan name, sorted by score, provider or price. Gives how many were found and up to limit of them. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const PROVIDER_ABOUT = "Gives each API one provider sells and its rank on each on Datacircle's benchmark (https://datacircle.dev), with its best plan there, its best rank first. total is how many APIs it sells, ranked on how many of them it has a rank. For an API's best providers, call datacircle_best_plans.";

/**
 * A call the API refused (an unknown slug, a wrong argument) or that failed (the network, a 5xx), in the API's words. A tool
 * gives it back to the model as its result, so that the model can call again.
 */
export class DatacircleError extends Schema.TaggedError<DatacircleError>()('DatacircleError', {
  message: Schema.String,
}) {}

/** What a tool gives the model: the API's answer, cut to what chooses a plan. */
const AnswerSchema = Schema.Record(Schema.String, Schema.Json);

/** An answer as the tools give it: a JSON object. */
export type DatacircleAnswer = typeof AnswerSchema.Type;

const text = (description: string) => Schema.optionalKey(Schema.String.annotate({ description }));
const count = (minimum: number, maximum: number, description: string) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum, maximum })).annotate({ description }));

/** A read-only tool on the API: its failures, a DatacircleError, are the model's to read. */
const readOnly = <T extends Tool.Any>(tool: T, title: string): T =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true) as T;

/** GET /apis: every GTM API on the sheet. */
export const ListApis = readOnly(Tool.make('datacircle_list_apis', {
  description: LIST_APIS_ABOUT,
  parameters: Schema.Struct({
    query: text("Words of the API's name or slug, like email or linkedin profile: the APIs that hold the most of them come first. Left out, the sheet's order"),
    limit: count(1, 200, 'How many APIs to give, 1 to 200. 20 when left out: the sheet has about 150'),
  }),
  success: AnswerSchema,
  failure: DatacircleError,
  failureMode: 'return',
}), 'List the APIs');

/** GET /apis/{slug}/best: who is best for one API. */
export const BestPlans = readOnly(Tool.make('datacircle_best_plans', {
  description: BEST_PLANS_ABOUT,
  parameters: Schema.Struct({
    slug: Schema.String.annotate({ description: "The API's slug, like email-finder or linkedin-profile, as datacircle_list_apis gives it" }),
    limit: count(1, 50, 'How many plans to give, 1 to 50. 10 when left out'),
  }),
  success: AnswerSchema,
  failure: DatacircleError,
  failureMode: 'return',
}), 'Who is best for an API');

/** GET /plans: every plan, by API, provider or price. */
export const SearchPlans = readOnly(Tool.make('datacircle_search_plans', {
  description: SEARCH_PLANS_ABOUT,
  parameters: Schema.Struct({
    api: text("Only this API's plans: its name or slug, like email-finder. A provider's name goes in query, never here. Left out, every API"),
    query: text("Words that must all appear in the provider's or plan's name, like bright data. Left out, every plan"),
    sort: Schema.optionalKey(Schema.Literals(['score', 'provider', 'price']).annotate({
      description: 'score (best first, the default), provider (A to Z) or price ($ per 1,000, lowest first)',
    })),
    limit: count(1, 50, 'How many plans to give, 1 to 50. 10 when left out'),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: 'How many found plans to skip first. 0 when left out' })),
  }),
  success: AnswerSchema,
  failure: DatacircleError,
  failureMode: 'return',
}), 'Search the plans');

/** GET /providers/{slug}: one provider's rank on every API it sells. */
export const Provider = readOnly(Tool.make('datacircle_provider', {
  description: PROVIDER_ABOUT,
  parameters: Schema.Struct({
    slug: Schema.String.annotate({ description: "The provider's slug, like bright-data, or its name, like Bright Data: the name is made a slug" }),
  }),
  success: AnswerSchema,
  failure: DatacircleError,
  failureMode: 'return',
}), 'One provider on every API');

/**
 * The four tools: datacircle_list_apis, datacircle_best_plans, datacircle_search_plans and datacircle_provider. Give it to
 * LanguageModel.generateText or a Chat as its toolkit, or merge it with your own (Toolkit.merge), with DatacircleLayer for
 * its handlers.
 */
export const DatacircleToolkit = Toolkit.make(ListApis, BestPlans, SearchPlans, Provider);

type Run<I> = (client: Client, input: I, signal?: AbortSignal) => Promise<Answer>;

/** One call as an Effect: interrupting it stops its request, and the API's {error} answer is a DatacircleError. */
const call = <I>(name: string, run: Run<I>, client: Client, input: I): Effect.Effect<DatacircleAnswer, DatacircleError> =>
  Effect.tryPromise({
    try: (signal) => run(client, input, signal),
    catch: (error) => new DatacircleError({ message: error instanceof Error ? error.message : String(error) }),
  }).pipe(
    Effect.flatMap((answer) =>
      typeof answer.error === 'string' ? Effect.fail(new DatacircleError({ message: answer.error })) : Effect.succeed(answer as DatacircleAnswer)),
    Effect.withSpan(`datacircle.${name}`),
  );

/** The handlers of the four tools, calling https://api.datacircle.dev/v1, or options.baseURL with options.fetch. */
export const layer = (options: DatacircleOptions = {}) => {
  const client = new Client(options);
  return DatacircleToolkit.toLayer({
    datacircle_list_apis: (input) => call('list_apis', listApisRun, client, input),
    datacircle_best_plans: (input) => call('best_plans', bestPlansRun, client, input),
    datacircle_search_plans: (input) => call('search_plans', searchPlansRun, client, input),
    datacircle_provider: (input) => call('provider', providerRun, client, input),
  });
};

/** The handlers of the four tools, on https://api.datacircle.dev/v1 with the runtime's fetch. */
export const DatacircleLayer = layer();

// The same calls without a model: each gives the answer the model would read, a refusal as a DatacircleError.

/** GET /apis: the APIs, as datacircle_list_apis gives them. */
export const listApis = (input: ListApisInput = {}, options?: DatacircleOptions) => call('list_apis', listApisRun, new Client(options), input);

/** GET /apis/{slug}/best: an API's plans best first, as datacircle_best_plans gives them. */
export const bestPlans = (input: BestPlansInput, options?: DatacircleOptions) => call('best_plans', bestPlansRun, new Client(options), input);

/** GET /plans: the plans found, as datacircle_search_plans gives them. */
export const searchPlans = (input: SearchPlansInput = {}, options?: DatacircleOptions) => call('search_plans', searchPlansRun, new Client(options), input);

/** GET /providers/{slug}: where a provider ranks, as datacircle_provider gives it. */
export const providerRanks = (input: ProviderInput, options?: DatacircleOptions) => call('provider', providerRun, new Client(options), input);

/** Whether a tool's name is one of the four tools'. */
export const isDatacircleTool = (name: unknown): name is keyof typeof DatacircleToolkit.tools =>
  typeof name === 'string' && Object.hasOwn(DatacircleToolkit.tools, name);
