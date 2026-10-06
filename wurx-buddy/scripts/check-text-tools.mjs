// Quick check: the exact nemotron output the Owner saw parses into a real rank_brands call.
import { parseTextToolCalls, looksLikeToolMarkup, stripToolMarkup } from '../supabase/functions/_shared/ai/llm/textTools.ts';

const sample = `<tool_call>
<function=rank_brands>
<parameter=period>
August 2026
</parameter>
<parameter=type>
monthly
</parameter>
<parameter=order>
desc
</parameter>
<parameter=metric>
gmv
</parameter>
<parameter=top_n>
10
</parameter>
</function>
</tool_call>`;
const tools = [{ type: 'function', name: 'rank_brands', parameters: { type: 'object', properties: { period: { type: 'string' }, type: { type: 'string' }, order: { type: 'string' }, metric: { type: 'string' }, top_n: { type: 'integer' } } } }];
console.log('looks like markup:', looksLikeToolMarkup(sample));
console.log('parsed:', JSON.stringify(parseTextToolCalls(sample, tools)));
console.log('unknown tool rejected:', JSON.stringify(parseTextToolCalls(sample.replace(/rank_brands/g, 'nope'), tools)));
console.log('hermes:', JSON.stringify(parseTextToolCalls('<tool_call>{"name":"rank_brands","arguments":{"metric":"gmv"}}</tool_call>', tools)));
console.log('strip leftovers:', JSON.stringify(stripToolMarkup('Here you go. </parameter>\n<tool_call>')));
