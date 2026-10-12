// Shared shapes for Buddy's web tools, so SearXNG and Tavily results merge.

export type WebHit = {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  score: number | null;
  engine: string;              // 'tavily' | 'searxng:<engine>' — shown to the admin, not the model
};

export type WebPage = {
  url: string;
  title: string | null;
  text: string;
  source: 'tavily' | 'direct';
};

export type WebUsage = { provider: string; calls: number; credits: number };

export type WebSearchOutcome = {
  hits: WebHit[];
  answer: string | null;
  usage: WebUsage[];
  providersTried: string[];
  errors: { provider: string; error: string }[];
};
