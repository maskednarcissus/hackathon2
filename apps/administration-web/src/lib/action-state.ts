export interface ActionState {
  message?: string;
  error?: string;
}

export const formText = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
