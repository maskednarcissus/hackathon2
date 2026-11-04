/**
 * Parser for `infrastructure/events/subscriptions.yaml`.
 *
 * The file deliberately uses a strict YAML subset (documented in its header) so the dev bus can
 * read it without a YAML dependency, while Terraform reads the same file with `yamldecode`.
 */

export interface Subscription {
  /** Subscription name, unique per topic. */
  name: string;
  /** Logical service name, resolved to a base URL per environment. */
  service: string;
  /** Push path on the service, starting with `/`. */
  path: string;
}

export type RoutingTable = Map<string, Subscription[]>;

export class SubscriptionsParseError extends Error {
  constructor(lineNo: number, message: string) {
    super(`subscriptions.yaml line ${lineNo}: ${message}`);
    this.name = 'SubscriptionsParseError';
  }
}

const TOPIC_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const NAME_RE = /^[a-z][a-z0-9-]*$/;

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).replace(/\s+$/, '');
}

export function parseSubscriptions(text: string): RoutingTable {
  const table: RoutingTable = new Map();
  let inTopics = false;
  let currentTopic: string | undefined;
  let current: Partial<Subscription> | undefined;
  let currentLine = 0;

  const flush = (): void => {
    if (!current || currentTopic === undefined) return;
    const { name, service, path } = current;
    if (!name || !service || !path) {
      throw new SubscriptionsParseError(currentLine, 'subscription needs name, service and path');
    }
    if (!NAME_RE.test(name)) throw new SubscriptionsParseError(currentLine, `bad name "${name}"`);
    if (!NAME_RE.test(service)) {
      throw new SubscriptionsParseError(currentLine, `bad service "${service}"`);
    }
    if (!path.startsWith('/')) {
      throw new SubscriptionsParseError(currentLine, `path must start with "/"`);
    }
    const subs = table.get(currentTopic) ?? [];
    if (subs.some((s) => s.name === name)) {
      throw new SubscriptionsParseError(currentLine, `duplicate subscription "${name}"`);
    }
    subs.push({ name, service, path });
    table.set(currentTopic, subs);
    current = undefined;
  };

  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = stripComment(raw);
    if (line.trim() === '') return;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      flush();
      if (content !== 'topics:') {
        throw new SubscriptionsParseError(lineNo, `unexpected top-level key "${content}"`);
      }
      inTopics = true;
      return;
    }
    if (!inTopics) throw new SubscriptionsParseError(lineNo, 'content before "topics:"');

    if (indent === 2) {
      flush();
      const m = /^([^:\s]+):\s*(\[\])?$/.exec(content);
      if (!m?.[1]) throw new SubscriptionsParseError(lineNo, `expected "<topic>:"`);
      const topic = m[1];
      if (!TOPIC_RE.test(topic)) throw new SubscriptionsParseError(lineNo, `bad topic "${topic}"`);
      if (table.has(topic)) throw new SubscriptionsParseError(lineNo, `duplicate topic "${topic}"`);
      table.set(topic, []);
      currentTopic = topic;
      return;
    }

    if (currentTopic === undefined) throw new SubscriptionsParseError(lineNo, 'no topic open');
    let body = content;
    if (indent === 4) {
      if (!content.startsWith('- ')) throw new SubscriptionsParseError(lineNo, 'expected "- name:"');
      flush();
      current = {};
      currentLine = lineNo;
      body = content.slice(2).trim();
    } else if (indent !== 6 || !current) {
      throw new SubscriptionsParseError(lineNo, `unexpected indentation (${indent})`);
    }
    const kv = /^(name|service|path):\s*(\S+)$/.exec(body);
    if (!kv?.[1] || kv[2] === undefined) {
      throw new SubscriptionsParseError(lineNo, `expected "name|service|path: <value>"`);
    }
    const key = kv[1] as keyof Subscription;
    if (current[key] !== undefined) throw new SubscriptionsParseError(lineNo, `duplicate "${key}"`);
    current[key] = kv[2];
  });
  flush();
  if (!inTopics) throw new SubscriptionsParseError(1, 'missing "topics:"');
  return table;
}

/** `audio-processing` → `AUDIO_PROCESSING_URL`. */
export function serviceUrlEnvName(service: string): string {
  return `${service.toUpperCase().replace(/-/g, '_')}_URL`;
}

export function resolveEndpoint(
  sub: Subscription,
  env: Record<string, string | undefined>,
): string | undefined {
  const base = env[serviceUrlEnvName(sub.service)];
  if (!base) return undefined;
  return base.replace(/\/+$/, '') + sub.path;
}
