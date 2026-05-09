import { QueryClient } from '@tanstack/react-query';

// Shared client tuned for "snappy navigation" feel:
//   * Cached data is served instantly when the user navigates back to a page —
//     no spinner, no refetch, as long as the entry is still within staleTime.
//   * Background revalidation only happens explicitly (refresh button, mutation
//     invalidation, or after staleTime expires on a fresh mount).
//
// This matches v1's perception of speed: v1's Firestore listeners keep data
// hot in memory, so screens render instantly. We mimic that by giving cached
// data a generous freshness window and disabling the on-mount/on-focus
// auto-refetch that was making every page transition feel like a cold load.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Treat cached data as fresh for 5 minutes — well beyond a typical
      // tab-switch window. Pages with a manual Refresh button can still
      // call queryClient.invalidateQueries to force a refetch.
      staleTime: 5 * 60_000,
      // Keep entries in memory for 30 min after last use before GC. Means
      // a quick detour to another page and back doesn't trigger a refetch.
      gcTime: 30 * 60_000,
      // Don't refetch on mount if data is still fresh — show cached
      // result immediately. This is the single biggest perceptual win.
      refetchOnMount: false,
      // Don't refetch when the tab regains focus. Annoying for power
      // users who alt-tab constantly; mutation invalidation handles
      // freshness when something actually changes.
      refetchOnWindowFocus: false,
      // Fail fast on transient errors; no auto-retry storms.
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
