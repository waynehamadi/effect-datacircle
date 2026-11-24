// Each tool's call on the live API, as LanguageModel and McpServer run it: the toolkit's handle, given the model's arguments,
// into the result the model reads; the answers a model's mistakes get; and the calls without a model. npm test
import { Effect, Exit, Layer, Schema, Stream } from 'effect';
import { Tool, Toolkit } from 'effect/ai';
import {
  BestPlans, DatacircleError, DatacircleLayer, DatacircleToolkit, ListApis, Provider, SearchPlans,
  bestPlans, isDatacircleTool, layer, listApis, providerRanks, searchPlans,
} from '@datacircle/effect';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed++;
};
const [LIST, BEST, SEARCH, PROVIDER] = ['datacircle_list_apis', 'datacircle_best_plans', 'datacircle_search_plans', 'datacircle_provider'];

// A call as LanguageModel makes it: the toolkit's handle on the model's JSON arguments, its last result as the model reads it.
const handle = (name, args, handlers = DatacircleLayer, toolkit = DatacircleToolkit) =>
  Effect.runPromise(Effect.gen(function* () {
    const kit = yield* toolkit;
    const results = Array.from(yield* Stream.runCollect(yield* kit.handle(name, args)));
    const last = results[results.length - 1];
    return { isFailure: last.isFailure, origin: last.failureOrigin, read: last.encodedResult, result: last.result };
  }).pipe(Effect.provide(handlers)));

check('names', Object.keys(DatacircleToolkit.tools).join(',') === [LIST, BEST, SEARCH, PROVIDER].join(','), Object.keys(DatacircleToolkit.tools).join(','));
for (const tool of [ListApis, BestPlans, SearchPlans, Provider]) {
  const s = Tool.getJsonSchema(tool);
  const props = Object.values(s.properties ?? {});
  check(`${tool.name} schema`, s.type === 'object' && props.length > 0 && props.every((p) => typeof p.description === 'string' && (p.type || p.enum))
    && (s.required ?? []).every((k) => k in s.properties) && Tool.getDescription(tool).length > 50 && tool.failureMode === 'return',
    `required [${s.required ?? []}] of [${Object.keys(s.properties)}]`);
}
const bestSchema = Tool.getJsonSchema(BestPlans);
check('best_plans limit bounds', bestSchema.properties.limit.minimum === 1 && bestSchema.properties.limit.maximum === 50 && bestSchema.properties.limit.type === 'integer', JSON.stringify(bestSchema.properties.limit));
check('search_plans sort enum', JSON.stringify(Tool.getJsonSchema(SearchPlans).properties.sort.enum) === '["score","provider","price"]', JSON.stringify(Tool.getJsonSchema(SearchPlans).properties.sort));
check('isDatacircleTool', isDatacircleTool(BEST) && !isDatacircleTool('get_weather') && !isDatacircleTool(undefined) && !isDatacircleTool('toString'), 'yes / no / no / no');

let r = await handle(LIST, {});
check('list_apis', !r.isFailure && r.read.total > 100 && r.read.apis.length === 20 && r.read.apis[0].slug, `total ${r.read.total}, first ${r.read.apis?.[0]?.slug}`);
r = await handle(LIST, { query: 'email', limit: 3 });
check('list_apis email', r.read.apis?.length === 3 && r.read.apis.every((a) => /email/i.test(a.api + a.slug)) && !r.read.note, r.read.apis?.map((a) => a.slug).join(', '));
r = await handle(LIST, { query: 'Bright Data' });
check('list_apis provider name', typeof r.read.note === 'string' && r.read.note.includes('datacircle_search_plans'), r.read.note);
r = await handle(LIST, { limit: 0 });
check('list_apis limit 0 refused', r.isFailure && r.origin === 'parameters' && /between 1 and 200/.test(JSON.stringify(r.read)), JSON.stringify(r.read).slice(0, 160));

r = await handle(BEST, { slug: 'email-finder', limit: 3 });
check('best_plans', !r.isFailure && r.read.plans.length === 3 && r.read.plans[0].rank === 1 && typeof r.read.plans[0].score === 'number' && r.read.plans[0].page && !('aggregators' in r.read.plans[0]),
  `${r.read.api}: ${r.read.plans?.map((p) => `${p.rank}. ${p.provider} ${p.score}`).join(' / ')}`);
r = await handle(BEST, { slug: 'Email Finder' });
check('best_plans name for slug', r.read.plans?.length === 10 && r.read.slug === 'email-finder', `${r.read.plans?.length} plans of ${r.read.slug}`);
r = await handle(BEST, { slug: 'email-finder', limit: 99 });
check('best_plans limit 99 refused', r.isFailure && r.origin === 'parameters' && /between 1 and 50/.test(JSON.stringify(r.read)), JSON.stringify(r.read).slice(0, 160));
r = await handle(BEST, { slug: 'email-finder', limit: '3' });
check('best_plans limit as text refused', r.isFailure && r.origin === 'parameters', JSON.stringify(r.read).slice(0, 160));
r = await handle(BEST, {});
check('best_plans no slug refused', r.isFailure && r.origin === 'parameters' && /slug/.test(JSON.stringify(r.read)), JSON.stringify(r.read).slice(0, 160));
r = await handle(BEST, { slug: 'bright-data' });
check('best_plans unknown slug', r.isFailure && r.origin === 'handler' && r.read._tag === 'DatacircleError' && r.read.message.startsWith('no API has the slug bright-data') && r.read.message.includes('datacircle_search_plans')
  && r.result instanceof DatacircleError, r.read.message);
r = await handle(BEST, { slug: 'serp-api', limit: 2 });
check('best_plans slug with -api', r.read.slug === 'serp' && r.read.plans?.length === 2 && r.read.note?.startsWith('No API has the slug serp-api'), r.read.note);
r = await handle(BEST, { slug: '<api-slug>' });
check('best_plans placeholder', r.isFailure && r.read.message?.includes('placeholder'), r.read.message);

r = await handle(SEARCH, { query: 'bright data', sort: 'price', limit: 3 });
check('search_plans', !r.isFailure && r.read.total > 3 && r.read.plans.length === 3 && r.read.plans.every((p) => /bright data/i.test(p.provider)), `${r.read.total} found, ${r.read.plans?.map((p) => `${p.api} ${p.perThousand}`).join(' / ')}`);
r = await handle(SEARCH, { api: 'email-finder', sort: 'score', limit: 2, offset: 1 });
check('search_plans api and offset', r.read.plans?.length === 2 && r.read.plans.every((p) => p.api === 'Email finder' || /email/i.test(p.api)) && r.read.offset === 1, r.read.plans?.map((p) => `${p.rank} ${p.provider}`).join(' / '));
r = await handle(SEARCH, { api: 'Bright Data' });
check('search_plans provider sent as api', r.read.total > 0 && r.read.note?.includes('No API is named'), r.read.note);
r = await handle(SEARCH, { query: 'bright-data', limit: 1 });
check('search_plans slug as query', r.read.total > 0 && r.read.note?.includes('bright data'), r.read.note);
r = await handle(SEARCH, { sort: 'cheapest' });
check('search_plans wrong sort refused', r.isFailure && r.origin === 'parameters' && /score/.test(JSON.stringify(r.read)), JSON.stringify(r.read).slice(0, 160));

r = await handle(PROVIDER, { slug: 'Bright Data' });
check('provider', !r.isFailure && r.read.total > 10 && r.read.ranked > 0 && r.read.apis[0].rank <= r.read.apis[r.read.ranked - 1].rank && r.read.apis[r.read.ranked]?.rank === undefined, `${r.read.total} APIs, ${r.read.ranked} ranked, best ${r.read.apis?.[0]?.slug} #${r.read.apis?.[0]?.rank}`);
r = await handle(PROVIDER, { slug: 'email-finder' });
check('provider sent an API slug', r.isFailure && r.read.message?.includes('datacircle_best_plans'), r.read.message);

// The app's own fetch and address: our User-Agent sent, a 5xx a failure the model reads, the API down a failure too.
const seen = [];
const spy = (input, init) => { seen.push(init?.headers?.['User-Agent']); return fetch(input, init); };
r = await handle(BEST, { slug: 'serp', limit: 1 }, layer({ fetch: spy }));
check('own fetch', r.read.plans?.length === 1 && /^datacircle-effect\/\d/.test(seen[0] ?? ''), `${seen[0]}`);
r = await handle(BEST, { slug: 'serp' }, layer({ fetch: async () => new Response('busy', { status: 503, statusText: 'Service Unavailable' }) }));
check('API 503', r.isFailure && r.origin === 'handler' && r.read.message.includes('503'), r.read.message);
r = await handle(LIST, {}, layer({ baseURL: 'http://127.0.0.1:9' }));
check('API down', r.isFailure && r.origin === 'handler' && r.read.message.startsWith('datacircle:'), r.read.message);

// Interrupted, a call stops its request.
let aborted = false;
const slow = (input, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }));
const exit = await Effect.runPromiseExit(Effect.timeout(bestPlans({ slug: 'serp' }, { fetch: slow }), '200 millis'));
check('interrupt stops the request', Exit.isFailure(exit) && aborted, `aborted ${aborted}`);

// Beside an app's own toolkit: merged, each handler found by its tool.
const Weather = Tool.make('get_weather', { parameters: Schema.Struct({ city: Schema.String }), success: Schema.String });
const Mine = Toolkit.make(Weather);
const merged = Toolkit.merge(Mine, DatacircleToolkit);
const both = Layer.mergeAll(Mine.toLayer({ get_weather: ({ city }) => Effect.succeed(`sunny in ${city}`) }), DatacircleLayer);
r = await handle('get_weather', { city: 'Paris' }, both, merged);
const r2 = await handle(BEST, { slug: 'serp', limit: 1 }, both, merged);
check('merged with an app\'s toolkit', r.read === 'sunny in Paris' && r2.read.plans?.length === 1, `${r.read} / ${r2.read.plans?.[0]?.provider}`);
// Only some of the four, in a toolkit of the app's own.
const some = Toolkit.make(SearchPlans, Weather);
r = await handle(SEARCH, { query: 'apollo', limit: 1 }, both, some);
check('one tool in an app\'s toolkit', r.read.plans?.length === 1, `${r.read.plans?.[0]?.provider}`);

// The calls without a model.
const a = await Effect.runPromise(bestPlans({ slug: 'email-finder', limit: 2 }));
check('bestPlans()', a.plans.length === 2, a.plans.map((p) => p.provider).join(', '));
const b = await Effect.runPromise(listApis({ limit: 2 }));
check('listApis()', b.apis.length === 2, b.apis.map((x) => x.slug).join(', '));
const c = await Effect.runPromise(searchPlans({ query: 'apollo', limit: 1 }));
check('searchPlans()', c.plans.length === 1, c.plans[0]?.provider);
const d = await Effect.runPromise(providerRanks({ slug: 'apollo' }));
check('providerRanks()', d.total > 0, `${d.total} APIs`);
const e = await Effect.runPromise(Effect.flip(bestPlans({ slug: 'nope-nope' })));
check('bestPlans() unknown slug fails', e instanceof DatacircleError && e._tag === 'DatacircleError', e.message);

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
