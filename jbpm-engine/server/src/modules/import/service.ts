// Import a jBPM (kjar) project — a { relativePath -> content } file map (as produced by export) — back
// into an engine project, then create a new project + draft version from it. Uses the SDK reader.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseProject, toEngineProject, dmnToDecisionModel, type EngineProject,
  type Asset, type EngineForm, type FormField, type EngineRuleset, type DrlModel, type EngineDecisionModel,
} from '../../sdk/index.ts';
import type { AppContext } from '../../context.ts';
import { WorkflowService } from '../workflows/service.ts';
import { VersionService } from '../versions/service.ts';
import { DeploymentService } from '../deployments/service.ts';
import { validation } from '../../infra/errors.ts';
import { Collections } from '../../domain.ts';
import { provisionAssignees, type Provisioned } from './assignees.ts';
import { WORKITEM_HANDLERS } from '../../engine/workitems/registry.ts';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export interface AssetImportReport {
  formsImported: string[];
  rulesetPlaceholders: { group: string; ruleNames: string[] }[];
  decisionsImported: string[];
  skipped: { path: string; kind: string; reason: string }[];
}

// Real jBPM Designer names a task form "<FormName>-taskform.form" and the userTask's own `form`
// field (see toEngine's userTask conversion) already holds exactly that stripped <FormName> — matching
// on the FILENAME this way (not the form XML's own internal <property name="name"> metadata, which is
// unrelated legacy authoring-tool bookkeeping, not what the process actually references) is what makes
// an imported form resolve against the process's existing references with zero manual relinking.
const formNameFromPath = (p: string): string => path.basename(p).replace(/-taskform\.form$|\.form$/i, '');

const FIELD_WIDGET: Record<string, FormField['widget']> = {
  InputText: 'text', InputTextArea: 'textarea', InputInteger: 'integer', InputDecimal: 'decimal',
  InputNumber: 'number', CheckBox: 'checkbox', DropDownList: 'dropdown', RadioGroup: 'radio', InputDate: 'date',
};

/** Real .form XML: a <form> with <field type="InputText" name="..."> children, each carrying its
 *  process-variable binding as a nested <property name="outputBinding"|"inputBinding" value="...">
 *  (see a real sample's exact shape — e.g. jbpm-playground's evaluation-taskform.form). Best-effort:
 *  field TYPE -> widget is a cosmetic mapping (defaults to 'text' for anything unrecognized); the bind
 *  name is what actually matters for the form to work, and that's a direct, lossless extraction. */
function formFieldsFromXml(root: any): FormField[] {
  const fields: FormField[] = [];
  for (const el of root?.children || []) {
    if (el.name !== 'field') continue;
    const props: Record<string, string> = {};
    for (const p of el.children || []) if (p.name === 'property') props[p.attrs?.name] = p.attrs?.value;
    const bind = props.outputBinding || props.inputBinding || el.attrs?.name;
    if (!bind) continue;
    fields.push({
      bind, label: props.label || bind, widget: FIELD_WIDGET[el.attrs?.type] || 'text',
      required: props.fieldRequired === 'true', readOnly: props.readonly === 'true',
      placeholder: props.placeholder || undefined,
    });
  }
  return fields;
}

// A real DRL rule's `when`/`then` can hold arbitrary imperative code (raw Java/MVEL statements,
// System.out.println, direct WorkingMemory calls like update()/insert() with real dialects) that this
// engine's own visual rule builder (EngineRuleDef: fact/where/set/insert only) has no way to represent
// — there is no raw-DRL escape hatch in that schema (see asset-fields.component.ts's rulesets editor).
// Auto-translating anyway would silently fabricate WRONG rule semantics, which is worse than not
// converting at all. So: create the ruleset placeholder (rules: []) so the ruleflowGroup reference
// resolves and validation doesn't dangle, and report exactly which named rules still need manual
// reconstruction — honest partial import beats either silent data loss or a silently wrong rule.
function rulesetGroupsFromDrl(drl: DrlModel, fallbackGroup: string): { group: string; ruleNames: string[] }[] {
  const byGroup = new Map<string, string[]>();
  for (const r of drl.rules || []) {
    const group = r.attrs?.ruleflowGroup || fallbackGroup;
    (byGroup.get(group) || byGroup.set(group, []).get(group)!).push(r.name);
  }
  return [...byGroup.entries()].map(([group, ruleNames]) => ({ group, ruleNames }));
}

/** Best-effort convert every recognized non-process kjar asset (SDK's `engine.assets`, from
 *  toEngineProject's structured parse) into this engine's own first-class forms/rulesets collections
 *  — mutates `engine` in place. Without this, everything but the .bpmn2 process itself (task forms,
 *  DRL rules, work-item definitions, ...) was silently dropped on import: parsed correctly by the SDK,
 *  then never looked at again (see the audit that flagged this against real jbpm-playground examples). */
export function convertAssets(engine: EngineProject): AssetImportReport {
  const report: AssetImportReport = { formsImported: [], rulesetPlaceholders: [], decisionsImported: [], skipped: [] };
  const assets = (engine as any).assets as Record<string, Asset | string> | undefined;
  if (!assets) return report;
  const forms: EngineForm[] = ((engine as any).forms ||= []);
  const rulesets: EngineRuleset[] = ((engine as any).rulesets ||= []);
  const decisions: EngineDecisionModel[] = ((engine as any).decisions ||= []);
  const existingFormNames = new Set(forms.map((f) => f.name));
  const existingRulesetGroups = new Set(rulesets.map((r) => r.group));
  const existingDecisionNames = new Set(decisions.map((d) => d.name));

  for (const [assetPath, val] of Object.entries(assets)) {
    if (typeof val === 'string') { report.skipped.push({ path: assetPath, kind: 'text', reason: 'unrecognized file type' }); continue; }
    const { kind, model } = val;
    if (kind === 'form') {
      const name = formNameFromPath(assetPath);
      if (existingFormNames.has(name)) { report.skipped.push({ path: assetPath, kind, reason: `form "${name}" already imported` }); continue; }
      forms.push({ id: slug(name), name, model: { className: '' }, fields: formFieldsFromXml((model as any).xml) } as EngineForm);
      existingFormNames.add(name);
      report.formsImported.push(name);
    } else if (kind === 'drl') {
      const fallbackGroup = path.basename(assetPath).replace(/\.(rdrl|rdslr|drl)$/i, '');
      for (const g of rulesetGroupsFromDrl(model as DrlModel, fallbackGroup)) {
        if (existingRulesetGroups.has(g.group)) continue;
        rulesets.push({ group: g.group, package: (model as DrlModel).package, rules: [] } as EngineRuleset);
        existingRulesetGroups.add(g.group);
        report.rulesetPlaceholders.push(g);
      }
    } else if (kind === 'dmn') {
      // Only decisionTable-driven decisions come back (see dmnToDecisionModel's own doc comment) — a
      // DMN file built entirely from literalExpression/businessKnowledgeModel (a real FEEL conditional
      // or a Java-backed function, both common in real-world DMN) has nothing recoverable this way and
      // is reported skipped rather than silently ignored or, worse, guessed at.
      const parsed = dmnToDecisionModel((model as any).xml);
      if (!parsed) { report.skipped.push({ path: assetPath, kind, reason: 'no decisionTable-driven decision found (literalExpression/businessKnowledgeModel-only DMN isn\'t evaluated by this engine)' }); continue; }
      if (existingDecisionNames.has(parsed.name)) { report.skipped.push({ path: assetPath, kind, reason: `decision model "${parsed.name}" already imported` }); continue; }
      decisions.push(parsed);
      existingDecisionNames.add(parsed.name);
      report.decisionsImported.push(parsed.name);
    } else {
      report.skipped.push({
        path: assetPath, kind,
        reason: kind === 'workItemDefinition'
          ? 'custom work-item definitions have no equivalent asset kind yet — recreate the service task manually'
          : 'no automatic conversion for this asset kind',
      });
    }
  }
  return report;
}

export /** Splits the argument list of a call whose "(" is at `open`; returns the top-level args and the index after ")" (string/char literals and nesting respected). */
function callArgs(src: string, open: number): { args: string[]; end: number } | undefined {
  const args: string[] = []; let depth = 0, start = open + 1, quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { args.push(src.slice(start, i)); return { args, end: i + 1 }; } }
    else if (c === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return undefined;
}

/** Java String.replace(a, b) replaces EVERY literal occurrence and replaceAll(regex, b) is a global regex replace; JS replace() with a string only replaces the first. */
function javaReplaceSemantics(js: string): string {
  const rewrite = (src: string, name: string, make: (a: string, b: string) => string): string => {
    let out = '', i = 0;
    const re = new RegExp('\\.' + name + '\\s*\\(', 'g');
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const open = m.index + m[0].length - 1; const call = callArgs(src, open);
      if (!call || call.args.length !== 2) continue;
      out += src.slice(i, m.index) + make(call.args[0]!.trim(), call.args[1]!.trim()); i = call.end; re.lastIndex = call.end;
    }
    return out + src.slice(i);
  };
  const step1 = rewrite(js, 'replaceAll', (a, b) => `.replace(new RegExp(${a}, 'g'), ${b})`);
  return rewrite(step1, 'replace', (a, b) => `.replaceAll(${a}, ${b})`);
}

function javaScriptify(code?: string): string {
  if (!code) return '';
  let js = code;

  // 1. Comments and system calls
  js = js.replace(/System\.out\.println\s*\(/g, 'console.log(');
  js = js.replace(/System\.out\.print\s*\(/g, 'console.log(');
  js = js.replace(/System\.(getenv|getProperty)\s*\(\s*"([^"]+)"\s*\)/g, '((env && env["$2"] != null) ? env["$2"] : null)');   // Java returns null (not "") for an unset variable, so `x == null` fallbacks still fire
  js = js.replace(/String\.valueOf\s*\(/g, 'String(');
  js = js.replace(/\.length\s*\(\s*\)/g, '.length');

  // 2. catch (Exception e) -> catch (e)
  js = js.replace(/catch\s*\(\s*(?:[a-zA-Z0-9_\.]+\s+)?([a-zA-Z0-9_]+)\s*\)/g, 'catch ($1)');

  // 3. new Class<Generics>() -> new Class()
  js = js.replace(/new\s+([a-zA-Z0-9_\.]+)<[^>]+>\s*\(/g, 'new $1(');

  // 4. .class literal -> ""
  js = js.replace(/\.class\b/g, '');

  // 5. Type casts: (Type) expr -> expr (only if preceded by non-word/operator)
  const castPattern = /(?<![\w\.\$])\(\s*(?:int|long|double|float|boolean|char|short|byte|(?:[a-z0-9_]+\.)*[A-Z][a-zA-Z0-9_]*(?:<[^>]+>)?)\s*\)\s*(?![;,=\)])/g;
  js = js.replace(castPattern, '');

  // 6. Variable declarations: Type varName = -> let varName =
  const declPattern = /\b(?:int|long|double|float|boolean|char|short|byte|(?:[a-z0-9_]+\.)*[A-Z][a-zA-Z0-9_]*(?:<[^>]+>)?)\s+([a-zA-Z0-9_]+)\s*([=;])/g;
  js = js.replace(declPattern, 'let $1 $2');

  // 7. For loops: for (Type x : list) -> for (let x of list)
  js = js.replace(/for\s*\(\s*(?:[a-zA-Z0-9_\\.<>]+)\s+([a-zA-Z0-9_]+)\s*:\s*([^)]+)\)/g, 'for (let $1 of $2)');
  js = js.replace(/for\s*\(\s*int\s+([a-zA-Z0-9_]+)\s*=/g, 'for (let $1 =');

  js = javaReplaceSemantics(js);
  return js;
}

export function convertProjectToNodeEngine(engine: EngineProject): EngineProject {
  for (const proc of engine.processes || []) {
    for (const node of proc.nodes || []) {
      if (node.type === 'script') {
        node.lang = 'js';
        const js = javaScriptify(node.code);
        node.code = js.trim() ? js : '// no-op';
      }
      if ((node as any).onEntry) {
        (node as any).onEntryLang = 'js';
        (node as any).onEntry = javaScriptify((node as any).onEntry);
      }
      if ((node as any).onExit) {
        (node as any).onExitLang = 'js';
        (node as any).onExit = javaScriptify((node as any).onExit);
      }
      if ((node as any).exitScript) {
        (node as any).lang = 'js';
        (node as any).exitScript = javaScriptify((node as any).exitScript);
      }
      if (node.type === 'subprocess' && Array.isArray((node as any).nodes)) {
        for (const sub of (node as any).nodes) {
          if (sub.type === 'script') {
            sub.lang = 'js';
            const js = javaScriptify(sub.code);
            sub.code = js.trim() ? js : '// no-op';
          }
          if (sub.onEntry) { sub.onEntryLang = 'js'; sub.onEntry = javaScriptify(sub.onEntry); }
          if (sub.onExit) { sub.onExitLang = 'js'; sub.onExit = javaScriptify(sub.onExit); }
        }
        for (const flow of (node as any).flows || []) {
          if (flow.when) {
            flow.lang = 'js';
            flow.when = javaScriptify(flow.when);
          }
        }
      }
    }
    for (const flow of proc.flows || []) {
      if (flow.when) {
        flow.lang = 'js';
        flow.when = javaScriptify(flow.when);
      }
    }
  }
  return engine;
}

/** Reconstruct an EngineProject from a kjar file map (writes to a temp dir, parses, converts) or native EngineProject JSON. */
/** a script task with no body (a Business Central placeholder) still needs valid code */
function noopEmptyScripts(engine: EngineProject): EngineProject {
  const walk = (nodes: any[]) => { for (const n of nodes || []) { if (n.type === 'script' && !String(n.code || '').trim()) n.code = '// no-op'; if (Array.isArray(n.nodes)) walk(n.nodes); } };
  for (const p of engine.processes || []) walk(p.nodes as any[]);
  return engine;
}

/** `dialect: 'java'` keeps every Java script, onEntry/onExit and condition as Java (run on the JVM sidecar, exactly as jBPM would); the default converts them to JavaScript. */
export function kjarToEngine(files: Record<string, string> | any, opts: { dialect?: 'js' | 'java' } = {}): EngineProject {
  if (!files || !Object.keys(files).length) throw validation('no files to import');
  if (Array.isArray(files.processes)) {
    return files as EngineProject;
  }
  if (files.engine && Array.isArray(files.engine.processes)) {
    return files.engine as EngineProject;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kjar-in-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content as string | Uint8Array);
    }
    const engine = toEngineProject(parseProject(dir));
    return opts.dialect === 'java' ? noopEmptyScripts(engine) : convertProjectToNodeEngine(engine);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------- import report
export interface ImportReportItem { process: string; nodeId?: string; nodeName?: string; severity: 'unsupported' | 'warning' | 'info'; code: string; message: string }
export interface ImportReport { summary: { unsupported: number; warnings: number; info: number }; items: ImportReportItem[] }

/** Everything in an imported project that did not map cleanly, per process — so nothing is dropped silently:
 *  constructs kept only as raw XML, jBPM features this engine deliberately does not have (Java imports / globals, rule-driven conditional
 *  starts, web-service tasks), work-item handlers that are not available here, and a note where Java scripts will use the JVM sidecar. */
export function buildImportReport(engine: EngineProject, files?: Record<string, unknown>, directory?: { users: Set<string>; groups: Set<string> }): ImportReport {
  const items: ImportReportItem[] = [];
  const add = (i: ImportReportItem) => items.push(i);
  const known = new Set(Object.keys(WORKITEM_HANDLERS));
  const walk = (processId: string, nodes: any[]) => {
    for (const n of nodes || []) {
      const name = n.name || n.id;
      if (n.type === 'raw') {
        const tag = /<\s*(?:\w+:)?(\w+)/.exec(String(n.raw || ''))?.[1] ?? n.bpmnLocal ?? 'element';
        add({ process: processId, nodeId: n.id, nodeName: name, severity: 'unsupported', code: 'unsupported-construct', message: `"${name}" (${tag}) is not converted: it is kept only in the source XML and does nothing at run time. Replace it with a supported node.` });
      }
      if (n.type === 'workItem' && n.handler && !known.has(String(n.handler))) {
        add({ process: processId, nodeId: n.id, nodeName: name, severity: 'warning', code: 'work-item-handler', message: `Work-item handler "${n.handler}" is not available here: the task will fail with SERVICE_ERROR. Use the HTTP node or one of: ${[...known].join(', ')}.` });
      }
      if ((n.type === 'script' || n.type === 'http') && n.lang === 'java') add({ process: processId, nodeId: n.id, nodeName: name, severity: 'info', code: 'java-script', message: `"${name}" is a Java script: it runs in the JVM sidecar (a JDK must be available on the server).` });
      if (n.type === 'start' && (n.on?.condition || n.event?.condition)) add({ process: processId, nodeId: n.id, nodeName: name, severity: 'warning', code: 'conditional-start', message: `Conditional start "${name}" is not supported (it needs a rule engine watching data). Start by signal, message or timer, or start the process and use a conditional catch as its first step.` });
      if (n.type === 'userTask') {
        const split = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
        const users = [...new Set([...split(n.assignee), ...split(n.actors), ...split(n.taskInputs?.ActorId), ...split(n.businessAdmin), ...split(n.taskInputs?.BusinessAdministratorId)])];
        const groups = [...new Set([...split(n.group), ...split(n.groups), ...split(n.businessAdminGroups), ...split(n.taskInputs?.BusinessAdministratorGroupId)])];
        const dynamic = (x: string) => /^[#$]\{|^\$/.test(x);                      // #{var} / $var are resolved per instance, not names to look up
        if (!users.length && !groups.length) add({ process: processId, nodeId: n.id, nodeName: name, severity: 'info', code: 'task-unassigned', message: `User task "${name}" has no actors or groups: any member who may manage tasks can claim it. Set Actors / Group on the task if it should be restricted.` });
        else {
          add({ process: processId, nodeId: n.id, nodeName: name, severity: 'info', code: 'task-assignment', message: `User task "${name}" is offered to ${[users.length ? `actors ${users.join(', ')}` : '', groups.length ? `groups ${groups.join(', ')}` : ''].filter(Boolean).join(' and ')}.` });
          if (directory) {
            const unknown = [...users.filter((u) => !dynamic(u) && !directory.users.has(u) && !directory.groups.has(u)).map((u) => `user or group "${u}"`), ...groups.filter((g) => !dynamic(g) && !directory.groups.has(g) && !directory.users.has(g)).map((g) => `group "${g}"`)];
            if (unknown.length) add({ process: processId, nodeId: n.id, nodeName: name, severity: 'warning', code: 'task-assignee-unknown', message: `User task "${name}" is assigned to ${unknown.join(', ')}, which does not exist in this workspace: until it is created (Admin → users and groups) or the assignment is changed, only business administrators can work this task.` });
          }
        }
      }
      if (Array.isArray(n.nodes)) walk(processId, n.nodes);
    }
  };
  for (const p of engine.processes || []) walk(p.id!, p.nodes as any[]);
  // source-level findings (only when the source XML is at hand)
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/\.bpmn2?$/i.test(rel) || typeof content !== 'string') continue;
    const proc = /<bpmn2?:process[^>]*\bid="([^"]+)"/.exec(content)?.[1] ?? rel;
    const imports = [...content.matchAll(/<drools:import\s+name="([^"]+)"/g)].map((m) => m[1]);
    if (imports.length) add({ process: proc, severity: 'info', code: 'java-imports', message: `Java imports (${imports.slice(0, 5).join(', ')}${imports.length > 5 ? ', …' : ''}) are not used: this engine runs JavaScript or JVM-sidecar scripts, not a Drools session.` });
    if (/<drools:global\b/.test(content)) add({ process: proc, severity: 'info', code: 'globals', message: 'Rule globals are not supported.' });
    if (/implementation="##WebService"|<bpmn2?:serviceTask[^>]*implementation="(?:##WebService|Other)"/.test(content)) add({ process: proc, severity: 'warning', code: 'service-task', message: 'A web-service / Java service task is present: use the HTTP node or a work item instead.' });
  }
  const count = (s: ImportReportItem['severity']) => items.filter((i) => i.severity === s).length;
  return { summary: { unsupported: count('unsupported'), warnings: count('warning'), info: count('info') }, items };
}

export class ImportService {
  constructor(private ctx: AppContext) {}
  /** Import a kjar file map as a new project (workflow) + initial draft. */
  /** the users and groups this workspace knows, so an import can say which task assignments point at nobody */
  private async directory(): Promise<{ users: Set<string>; groups: Set<string> }> {
    const t = this.ctx.tenantId; const users = new Set<string>(); const groups = new Set<string>();
    for (const u of await this.ctx.store.repo<any>(Collections.users).query((x) => x.tenantId === t)) { users.add(u.username); if (u.email) users.add(u.email); for (const g of u.groups || []) groups.add(g); for (const r of u.roles || []) groups.add(r); }
    for (const g of await this.ctx.store.repo<any>(Collections.groups).query((x) => x.tenantId === t)) groups.add(g.name);
    for (const r of await this.ctx.store.repo<any>(Collections.roles).query((x) => x.tenantId === t)) groups.add(r.name);
    for (const m of await this.ctx.store.repo<any>(Collections.tenantMembers).query((x) => x.tenantId === t)) { if (m.userId) users.add(m.userId); if (m.email) users.add(m.email); }
    return { users, groups };
  }

  /** Creates the users and groups the project's tasks are assigned to when this workspace lacks them (least permission), and says so in the report. */
  private async provision(engine: EngineProject, actor: string, canProvision: boolean | undefined): Promise<Provisioned | undefined> {
    return canProvision ? provisionAssignees(this.ctx, engine, actor) : undefined;
  }
  private withProvisioning(report: ImportReport, p: Provisioned | undefined, canProvision: boolean | undefined): ImportReport {
    const add = (severity: ImportReportItem['severity'], code: string, message: string) => report.items.push({ process: '(workspace)', severity, code, message });
    if (p?.createdGroups.length) add('info', 'assignee-group-created', `Created group${p.createdGroups.length > 1 ? 's' : ''} ${p.createdGroups.join(', ')}: no members yet, no permissions beyond what its members' roles give. Add members under Admin → Groups.`);
    if (p?.createdUsers.length) add('info', 'assignee-user-created', `Created user${p.createdUsers.length > 1 ? 's' : ''} ${p.createdUsers.join(', ')} with the read-only viewer role, disabled: an administrator must set a password, enable the account and grant the roles it needs.`);
    for (const f of p?.failed ?? []) add('warning', 'assignee-create-failed', `Could not create ${f.kind} "${f.name}": ${f.reason}`);
    if (canProvision === false) add('info', 'assignee-not-created', 'Users and groups named by task assignments were not created because the importing account may not manage users; create them under Admin if they are missing (see the warnings above).');
    const count = (sv: ImportReportItem['severity']) => report.items.filter((i) => i.severity === sv).length;
    report.summary = { unsupported: count('unsupported'), warnings: count('warning'), info: count('info') };
    return report;
  }

  async importKjar(files: Record<string, string>, name: string | undefined, actor: string, opts: { canProvision?: boolean; dialect?: 'js' | 'java' } = {}): Promise<{ workflowId: string; processes: number; report: ImportReport } & AssetImportReport> {
    const engine = kjarToEngine(files, { dialect: opts.dialect });
    const assetReport = convertAssets(engine);
    const provisioned = await this.provision(engine, actor, opts.canProvision);
    const report = this.withProvisioning(buildImportReport(engine, files, await this.directory()), provisioned, opts.canProvision);
    const wf = await new WorkflowService(this.ctx).create({ name: name || (engine as any).name || (engine as any).id || 'Imported project' }, actor);
    await new VersionService(this.ctx).saveDraft(wf.defaultBranchId, engine, actor);
    await this.ctx.audit({ actor, kind: 'project.imported', workflowId: wf.id, data: { processes: engine.processes?.length || 0, ...assetReport, report: report.summary } });
    return { workflowId: wf.id, processes: engine.processes?.length || 0, ...assetReport, report };
  }

  /** Import a kjar straight to a running deployment in one step — no manual Publish/Deploy detour
   *  through the project first. Mirrors jBPM's own "deploy this artifact" ops flow: the import still
   *  creates a normal project + draft (so it's editable afterwards like any other), but also publishes
   *  and deploys that exact draft immediately. Deploying edits a NEW version, same as the UI's own
   *  Publish+Deploy buttons — this never mutates an already-active deployment in place, since that
   *  would desync it from whatever instances are already running against it. */
  async importAndDeploy(
    files: Record<string, string>, name: string | undefined, actor: string,
    opts: { environment: string; tags?: string[]; env?: Record<string, string>; canProvision?: boolean; dialect?: 'js' | 'java' },
  ): Promise<{ workflowId: string; processes: number; deploymentId: string; report: ImportReport } & AssetImportReport> {
    const engine = kjarToEngine(files, { dialect: opts.dialect });
    const assetReport = convertAssets(engine);
    const provisioned = await this.provision(engine, actor, opts.canProvision);
    const report = this.withProvisioning(buildImportReport(engine, files, await this.directory()), provisioned, opts.canProvision);
    const wf = await new WorkflowService(this.ctx).create({ name: name || (engine as any).name || (engine as any).id || 'Imported project' }, actor);
    const ver = new VersionService(this.ctx);
    let dep: Awaited<ReturnType<DeploymentService['deploy']>>;
    try {
      const draft = await ver.saveDraft(wf.defaultBranchId, engine, actor);
      const { published } = await ver.publish(draft.id, actor, 'v1');
      dep = await new DeploymentService(this.ctx).deploy(published.id, { environment: opts.environment, tags: opts.tags, env: opts.env, activate: true }, actor);
    } catch (e) {
      // an import that cannot be published or deployed must not leave an empty project behind (the retry would also hit "key already exists")
      await new WorkflowService(this.ctx).purge(wf.id, actor).catch(() => {});
      throw e;
    }
    await this.ctx.audit({ actor, kind: 'project.imported', workflowId: wf.id, data: { processes: engine.processes?.length || 0, deployed: true, deploymentId: dep.id, ...assetReport, report: report.summary } });
    return { workflowId: wf.id, processes: engine.processes?.length || 0, deploymentId: dep.id, ...assetReport, report };
  }
}
