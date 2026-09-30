// The four logical indexes over one store (phase5-design.md §2.1). Each is a
// source_type filter on ai_search plus its own budget and federated quota.

import type { RetrievalConfig } from './config.ts';

export type IndexName = 'company' | 'reports' | 'tiktok' | 'incentives';

export type IndexDef = {
  name: IndexName;
  label: string;          // shown to the model as the group heading
  authority: string;      // what this index is authoritative for (§3)
  sourceTypes: string[];
};

export const INDEXES: Readonly<Record<IndexName, IndexDef>> = Object.freeze({
  company: {
    name: 'company', label: 'Wurx SOPs & knowledge base',
    authority: 'our own process: how Wurx works', sourceTypes: ['kb_article', 'ai_doc', 'app_guide'],
  },
  reports: {
    name: 'reports', label: 'Client reports (approved)',
    authority: "our clients' performance, as written by the team (numbers come from data tools)", sourceTypes: ['report'],
  },
  tiktok: {
    name: 'tiktok', label: 'TikTok Shop Academy',
    authority: 'TikTok platform rules and how-tos', sourceTypes: ['tts_article'],
  },
  incentives: {
    name: 'incentives', label: 'Incentive plans',
    authority: 'plan structure (payouts and progress come from data tools)', sourceTypes: ['incentive'],
  },
});

// Federated order: our own knowledge first.
export const INDEX_ORDER: readonly IndexName[] = ['company', 'reports', 'tiktok', 'incentives'];

export function indexForSourceType(sourceType: string): IndexName | null {
  for (const n of INDEX_ORDER) if (INDEXES[n].sourceTypes.includes(sourceType)) return n;
  return null;
}

export function budgetFor(index: IndexName, cfg: RetrievalConfig, federated = false): number {
  const k = `${federated ? 'FEDERATED_' : ''}BUDGET_${index.toUpperCase()}` as keyof RetrievalConfig;
  return cfg[k] as number;
}

export function quotaFor(index: IndexName, cfg: RetrievalConfig): number {
  return cfg[`QUOTA_${index.toUpperCase()}` as keyof RetrievalConfig] as number;
}
