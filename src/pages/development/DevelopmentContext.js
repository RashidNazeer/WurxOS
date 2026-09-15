import { createContext, useContext } from 'react';

export const DevContext = createContext(null);

export const WORKSPACE_KEY = ['development', 'workspace'];

export function useDev() {
  const ctx = useContext(DevContext);
  if (!ctx) throw new Error('useDev() must be used inside the Development layout.');
  return ctx;
}
