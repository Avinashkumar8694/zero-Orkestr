// jBPM user-task deadlines (NotStartedReassign / NotCompletedReassign / NotStartedNotify / NotCompletedNotify).
// Syntax (jbpm HumanTaskHandlerHelper): components joined by `^`; each component is `[<action>]@[<expiry>(,<expiry>…)]`;
// an action is `key:value|key:value` where a value may be a comma list. Reassign keys: users, groups. Notify keys:
// tousers, togroups, toemails, from, replyto, subject, body, locale. Expiry: `4h`, `2d`, `1h 30m`, `PT30M`, `R/PT1H`.
import { parseDelay } from './duration.ts';

export type DeadlineType = 'notStartedReassign' | 'notCompletedReassign' | 'notStartedNotify' | 'notCompletedNotify';
export const DEADLINE_TYPES: DeadlineType[] = ['notStartedReassign', 'notCompletedReassign', 'notStartedNotify', 'notCompletedNotify'];
export interface Deadline { action: Record<string, string>; expiries: string[] }

const REASSIGN_KEYS = new Set(['users', 'groups']);
const NOTIFY_KEYS = new Set(['tousers', 'togroups', 'toemails', 'from', 'replyto', 'subject', 'body', 'locale']);

/** parsed deadlines, or the first thing wrong with the text */
export function parseDeadlines(text: unknown, type: DeadlineType): { deadlines: Deadline[]; error?: string } {
  const src = typeof text === 'string' ? text.trim() : '';
  if (!src) return { deadlines: [] };
  const allowed = type.endsWith('Reassign') ? REASSIGN_KEYS : NOTIFY_KEYS;
  const deadlines: Deadline[] = [];
  for (const part of src.split('^')) {
    const m = /^\s*\[(.*)\]\s*@\s*\[(.*)\]\s*$/s.exec(part);
    if (!m) return { deadlines: [], error: `"${part.trim()}" is not of the form [action]@[expiry]` };
    const action: Record<string, string> = {};
    for (const kv of m[1]!.split('|')) {
      const i = kv.indexOf(':');
      if (i < 1) return { deadlines: [], error: `"${kv.trim()}" is not key:value` };
      const k = kv.slice(0, i).trim().toLowerCase(), v = kv.slice(i + 1).trim();
      if (!allowed.has(k)) return { deadlines: [], error: `"${k}" is not valid for ${type} (use ${[...allowed].join(', ')})` };
      action[k] = v;
    }
    if (type.endsWith('Reassign') && !action.users && !action.groups) return { deadlines: [], error: 'a reassignment needs users and/or groups' };
    if (type.endsWith('Notify') && !action.tousers && !action.togroups && !action.toemails) return { deadlines: [], error: 'a notification needs tousers, togroups or toemails' };
    const expiries = m[2]!.split(',').map((e) => e.trim()).filter(Boolean);
    if (!expiries.length) return { deadlines: [], error: 'an expiry is required after @' };
    for (const e of expiries) if (!parseDelay(e)) return { deadlines: [], error: `expiry "${e}" is not a duration (try 4h, 2d, PT30M)` };
    deadlines.push({ action, expiries });
  }
  return { deadlines };
}
