// A readable name for a process id such as "com.acme.ClaimAssessment" or "claims-intake.process": the last segment that
// says something. A trailing generic word ("process") used to be shown on its own, so every row read just "process".
const GENERIC = new Set(['process', 'bpmn', 'workflow', 'flow']);
export function processLabel(processId?: string | null, fallback = ''): string {
  const parts = (processId || '').split('.').filter(Boolean);
  const meaningful = [...parts].reverse().find((p) => !GENERIC.has(p.toLowerCase()));
  return meaningful || parts.pop() || fallback;
}
