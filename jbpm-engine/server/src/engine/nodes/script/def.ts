import { type NodeDef, GENERAL, EXECUTION } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'script',
  palette: [{ key: 'script', label: 'Script Task', category: 'Tasks', icon: '{ }', color: '#0891b2', engineType: 'script', defaults: { type: 'script', lang: 'js', code: '' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Script (JavaScript / Java)', fields: [
    { key: 'lang', label: 'Language dialect', widget: 'select', options: ['js', 'java'], help: 'JavaScript (Node.js engine) or Java (JVM sidecar).' },
    { key: 'code', label: 'Script body', widget: 'code', placeholder: 'vars.status = "APPROVED";\n// or direct variables:\namount = amount * 1.1;', help: 'Direct JS variables (vars.x, bare x = val) or kcontext.' },
  ] }, EXECUTION],
  diagram: { icon: 'code', color: '#0891b2', shape: 'rectangle' },
  typeLabel: 'Script task',
  docs: {
    summary: 'Executes procedural logic in Node.js VM (JavaScript) or JVM sidecar (Java 8). Supports direct variable access, vars helper, and legacy kcontext.',
    purpose: 'Provides sandboxed procedural logic execution. For Node.js, read and write variables directly as plain JS variables or via the vars helper. Procedural compatibility scripts can also use kcontext.',
    whenToUse: [
      'Use the modern Node.js way (vars.x or direct variables) for clean, concise JavaScript code in native JSON workflows.',
      'Use for synchronous data transformations, payload mapping, and business rule calculations.',
      'Use Java dialect (or kcontext) when importing existing workflows without rewriting.',
    ],
    whenNotToUse: [
      'Do not perform outbound network or database calls in a script (use Service/HTTP Task).',
      'Do not run long-running CPU loops; bounded by scriptTimeoutSeconds.',
    ],
    scenarios: [
      {
        title: 'Modern Node.js / JavaScript (Recommended)',
        description: 'Directly reads and mutates flow variables using standard JavaScript or the vars object.',
        whenToUse: 'Native Node.js workflows, clean JSON manipulations, and calculations.',
        exampleJson: { id: 'script_1', name: 'Calculate Total', type: 'script', lang: 'js', code: '// Direct variable access:\nconst tax = amount * 0.18;\ntotal = amount + tax;\nvars.status = "CALCULATED";\nconsole.log(`Calculated total: ${total} for case ${instance.correlationKey}`);' },
      },
      {
        title: 'Procedural kcontext Compatibility',
        description: 'Uses kcontext.getVariable() and setVariable() for compatibility scripts.',
        whenToUse: 'Maintaining procedural compatibility scripts or running Java 8 dialect.',
        exampleJson: { id: 'script_legacy', name: 'Legacy Script', type: 'script', lang: 'js', code: 'const amount = kcontext.getVariable("amount") || 0;\nkcontext.setVariable("tax", amount * 0.18);' },
      },
      {
        title: 'Java 8 Sidecar Execution',
        description: 'Runs real Java 8 bytecode via the JVM sidecar with full standard library support.',
        whenToUse: 'Migrating legacy Java rules and scripts.',
        exampleJson: { id: 'script_java', name: 'Java Script', type: 'script', lang: 'java', code: 'String s = (String) kcontext.getVariable("input");\nkcontext.setVariable("output", s.toUpperCase());' },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'Script Task', required: true, description: 'Display name rendered on diagram.' },
      { key: 'lang', label: 'Language', type: 'select', options: ['js', 'java'], default: 'js', required: false, description: 'Execution dialect: js (Node VM) or java (JVM sidecar).' },
      { key: 'code', label: 'Script Code', type: 'string', required: true, description: 'Script statements to execute.' },
    ],
    gotchas: [
      'Scripts run synchronously in the token path and are subject to the system setting scriptTimeoutSeconds.',
      'Spawning threads or accessing Node.js process / fs internals is blocked by the security sandbox.',
    ],
  },
};
