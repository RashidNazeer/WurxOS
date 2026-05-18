import { useEffect } from 'react';
import { registerDirtyForm, clearDirtyForm } from '../lib/appUpdate';

let seq = 0;

/**
 * Marks the calling form as holding unsaved changes while `isDirty`
 * is true. While any guarded form is dirty:
 *   • a stale-deploy auto-reload is suppressed (the update banner
 *     shows instead — see appUpdate.js / requestAppReload), and
 *   • a beforeunload prompt warns before an accidental tab close.
 *
 * Drop into any form: `useUnsavedGuard(hasUnsavedChanges)`.
 */
export function useUnsavedGuard(isDirty) {
  useEffect(() => {
    if (!isDirty) return undefined;
    const id = `form-${++seq}`;
    registerDirtyForm(id);
    return () => clearDirtyForm(id);
  }, [isDirty]);
}
