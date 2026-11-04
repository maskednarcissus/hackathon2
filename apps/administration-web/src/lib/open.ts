/** A known string union that tolerates values added by newer backends (keeps autocompletion). */
export type Open<T extends string> = T | (string & Record<never, never>);
