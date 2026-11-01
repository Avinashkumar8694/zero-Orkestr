package bpmscript;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The real, concrete {@code kcontext} binding a compiled script snippet is invoked with — same
 * method surface jBPM's own {@code org.kie.api.runtime.process.ProcessContext} exposes, cross-checked
 * against jBPM/Drools source this session (kie-api's {@code ProcessContext}/{@code ProcessInstance}/
 * {@code NodeInstance}/{@code ProcessRuntime}), so scripts converted unmodified from a real jBPM
 * project work exactly as they do there. Scripts never reference this class's fully-qualified name
 * (kcontext is always used as a bare, pre-bound identifier), so it doesn't need to live under jBPM's
 * real package name to compile correctly.
 *
 * Deliberately NOT implemented, with the real-jBPM reasoning for each: human task querying/management
 * (real jBPM has no path to {@code TaskService}/{@code RuntimeDataService} from {@code kcontext}
 * either — those are external REST/Java-client-only APIs; the one community workaround, reaching a
 * {@code RuntimeManager} through the environment, is an unofficial hack, not upstream behavior);
 * rule-engine fact insert/delete/update (tied to Drools' working memory, which this engine has no
 * concept of); {@code getCaseData()}/{@code getCaseAssignment()} (CMMN case management, not
 * applicable — this engine has no case-management concept); starting a new process or enumerating
 * other running instances from a script (real jBPM itself is documented as unreliable here — NPEs
 * starting a process from a script, {@code getProcessInstances()} commonly returning empty since
 * instances are persisted rather than held live in the session — so this isn't a capability worth
 * out-engineering past what real jBPM's own users route around via the audit log instead).
 *
 * Design invariant: {@link #setVariable} always unwraps a {@link JsonNode} to its plain underlying
 * value before storing, and every process variable is persisted as plain JSON between separate
 * {@code /execute} calls (instances are persisted as JSON everywhere else in this engine too) — so a
 * non-JSON-native Java type (BigDecimal, Date, a custom POJO) a script stores does NOT survive as that
 * same Java type into a LATER script/condition's execution purely from storage. {@link #getVariable}
 * closes most of this gap for numeric types: given the variable's DECLARED type (structureRef, from
 * the process's own variable declarations — the same map {@code ScriptRunner.withVarBindings} already
 * uses for bare-name binding), it coerces the raw JSON-shaped value (Integer/Long/Double/BigInteger)
 * to the declared numeric type — most importantly {@code BigDecimal}, since that's the far-and-away
 * most common declared type for a real financial value that isn't just a bare double. This makes
 * {@code (BigDecimal) kcontext.getVariable("fee")} reliable across separate script/condition calls
 * as long as {@code fee} is a DECLARED process variable — matching what real jBPM's own kcontext
 * effectively guarantees (a declared variable is always its declared type, since real jBPM keeps it
 * as a live typed Java object for the life of the session). An UNDECLARED variable (not in the
 * process's own variable list) has no declared type to coerce to, so it's still returned as whatever
 * raw JSON-shaped value it was stored as — same as before, and the same limitation real jBPM doesn't
 * have either (every variable there is declared, by construction — there's no such thing as an
 * "undeclared process variable" in real jBPM).
 */
public final class KContext {
    /** jBPM ids are `long`: a stable 53-bit FNV-1a of the engine's string id (the server computes the same number, so the API resolves it back to the instance). */
    static long stableLong(String s) {
        long h = 0xcbf29ce484222325L;
        if (s != null) for (int i = 0; i < s.length(); i++) { h ^= s.charAt(i); h *= 0x100000001b3L; }
        return h & 0x1fffffffffffffL;   // 53 bits: survives a JSON number unchanged
    }

    private final Map<String, Object> vars;
    private final Map<String, String> varTypes;
    private final String instanceId;
    private final String processId;
    private final String processName;
    private final String correlationKey;
    private final String parentInstanceId;
    private final int state;
    private final String nodeInstanceId;
    private final String nodeId;
    private final String nodeName;
    private final Map<String, String> env;
    private final List<NodeInstance> activeNodeInstances;
    private final List<PendingAction> pendingActions;

    public KContext(Map<String, Object> vars, Map<String, String> varTypes, String instanceId, String processId, String processName,
                     String correlationKey, String parentInstanceId, int state,
                     String nodeInstanceId, String nodeId, String nodeName,
                     Map<String, String> env, List<NodeInstance> activeNodeInstances) {
        this.vars = vars;
        this.varTypes = varTypes;
        this.instanceId = instanceId == null ? "" : instanceId;
        this.processId = processId;
        this.processName = processName;
        this.correlationKey = correlationKey;
        this.parentInstanceId = parentInstanceId;
        this.state = state;
        this.nodeInstanceId = nodeInstanceId == null ? "" : nodeInstanceId;
        this.nodeId = nodeId == null ? "" : nodeId;
        this.nodeName = nodeName == null ? "" : nodeName;
        this.env = env;
        this.activeNodeInstances = activeNodeInstances == null ? new ArrayList<NodeInstance>() : activeNodeInstances;
        this.pendingActions = new ArrayList<PendingAction>();
    }

    public Object getVariable(String name) { return coerce(vars.get(name), varTypes == null ? null : varTypes.get(name)); }

    /** Coerces a raw JSON-shaped value to the declared numeric type, if it isn't already that type.
     *  A no-op for non-numeric declared types (String/Boolean/Object/List/Map/Date/a custom POJO FQN
     *  this engine can't resolve anyway) and for a value that's already the right type. */
    @SuppressWarnings("unchecked")
    private static Object coerce(Object value, String declaredType) {
        // A JSON object/array held by a variable that is declared text or object (or not declared) was stored there as a Jackson node by an earlier script
        // (jBPM keeps the object in memory, whatever the declared type); here it travelled as JSON, so give it back as a node: `(JsonNode) kcontext.getVariable(..)`.
        // A variable declared Map / List keeps the plain collection.
        if (value instanceof java.util.Map || value instanceof java.util.List) {
            String t = declaredType == null ? "Object" : ScriptRunner.javaTypeFor(declaredType);
            if ("String".equals(t) || "Object".equals(t)) {
                return value instanceof java.util.Map
                    ? new com.fasterxml.jackson.databind.node.ObjectNode((java.util.Map<String, Object>) value)
                    : new com.fasterxml.jackson.databind.node.ArrayNode((java.util.List<Object>) value);
            }
            return value;
        }
        if (value == null || declaredType == null) return value;
        if (!(value instanceof Number) && !(value instanceof String)) return value;
        String type = ScriptRunner.javaTypeFor(declaredType);
        if ("java.math.BigDecimal".equals(type)) return value instanceof java.math.BigDecimal ? value : new java.math.BigDecimal(value.toString());
        if ("java.math.BigInteger".equals(type)) return value instanceof java.math.BigInteger ? value : new java.math.BigInteger(new java.math.BigDecimal(value.toString()).toBigInteger().toString());
        if (!(value instanceof Number)) return value;   // remaining branches are numeric-only
        Number n = (Number) value;
        if ("Double".equals(type)) return value instanceof Double ? value : n.doubleValue();
        if ("Float".equals(type)) return value instanceof Float ? value : n.floatValue();
        if ("Long".equals(type)) return value instanceof Long ? value : n.longValue();
        if ("Integer".equals(type)) return value instanceof Integer ? value : n.intValue();
        return value;
    }

    public void setVariable(String name, Object value) {
        vars.put(name, value instanceof JsonNode ? ((JsonNode) value).rawValue() : value);
    }

    public ProcessInstance getProcessInstance() {
        return new ProcessInstance(instanceId, processId, processName, correlationKey, parentInstanceId,
            state, vars, activeNodeInstances, pendingActions);
    }

    public NodeInstance getNodeInstance() { return new NodeInstance(nodeInstanceId, nodeId, nodeName); }

    public KieRuntime getKieRuntime() { return new KieRuntime(env, pendingActions); }

    /** actions (signal/abort) queued via kcontext.getKieRuntime()/.getProcessInstance() during this
     *  execution — the caller (Server) resolves these against the real instance store after the
     *  script returns, since a JVM sidecar request has no store access of its own. */
    List<PendingAction> pendingActions() { return pendingActions; }

    public static final class ProcessInstance {
        // matches real jBPM's org.kie.api.runtime.process.ProcessInstance state constants exactly.
        public static final int STATE_PENDING = 0;
        public static final int STATE_ACTIVE = 1;
        public static final int STATE_COMPLETED = 2;
        public static final int STATE_ABORTED = 3;
        public static final int STATE_SUSPENDED = 4;

        private final String id;
        private final String processId;
        private final String processName;
        private final String correlationKey;
        private final String parentProcessInstanceId;
        private final int state;
        private final Map<String, Object> vars;
        private final List<NodeInstance> nodeInstances;
        private final List<PendingAction> pendingActions;

        ProcessInstance(String id, String processId, String processName, String correlationKey,
                         String parentProcessInstanceId, int state, Map<String, Object> vars,
                         List<NodeInstance> nodeInstances, List<PendingAction> pendingActions) {
            this.id = id;
            this.processId = processId;
            this.processName = processName;
            this.correlationKey = correlationKey;
            this.parentProcessInstanceId = parentProcessInstanceId;
            this.state = state;
            this.vars = vars;
            this.nodeInstances = nodeInstances;
            this.pendingActions = pendingActions;
        }

        public long getId() { return stableLong(id); }
        /** this engine's own (string) id */
        public String getIdString() { return id; }
        public String getProcessId() { return processId; }
        public String getProcessName() { return processName; }
        public String getCorrelationKey() { return correlationKey; }
        /** null if this instance has no parent (real jBPM: -1 as a long; this engine's ids are
         *  strings throughout, so null is the natural "none" value here instead). */
        public String getParentProcessInstanceId() { return parentProcessInstanceId; }
        public int getState() { return state; }
        /** the live variables map — mutating it has the same effect as calling setVariable for each
         *  key, matching real jBPM's own getVariables() (also a live-backed map in practice). */
        public Map<String, Object> getVariables() { return vars; }
        /** currently-active node instances, a SNAPSHOT at the time this method is called — matches
         *  real jBPM's own Collection-snapshot semantics (not a live view that updates itself). */
        public List<NodeInstance> getNodeInstances() { return nodeInstances; }
        /** self-scoped signal — real jBPM's ProcessInstance implements EventListener, so this is
         *  delivered to THIS instance only, distinct from kcontext.getKieRuntime().signalEvent(type,
         *  event) (a session-wide broadcast to whichever instances are currently waiting on it). */
        public void signalEvent(String type, Object event) { pendingActions.add(PendingAction.signal(type, event, id)); }
    }

    public static final class NodeInstance {
        private final String id;
        private final String nodeId;
        private final String nodeName;
        NodeInstance(String id, String nodeId, String nodeName) { this.id = id; this.nodeId = nodeId; this.nodeName = nodeName; }
        /** the node-*instance* id (real jBPM: NodeInstance.getId()) — distinct from getNodeId()
         *  below, the node *definition* id (real jBPM: NodeInstance.getNode().getId()). This engine
         *  used to conflate the two into one field; they're genuinely different things. */
        public long getId() { return stableLong(id); }
        /** this engine's own (string) id */
        public String getIdString() { return id; }
        public String getNodeId() { return nodeId; }
        public String getNodeName() { return nodeName; }
    }

    public static final class KieRuntime {
        private final Map<String, String> env;
        private final List<PendingAction> pendingActions;
        KieRuntime(Map<String, String> env, List<PendingAction> pendingActions) { this.env = env; this.pendingActions = pendingActions; }
        public Environment getEnvironment() { return new Environment(env); }
        /** session-wide broadcast — delivered to whichever OTHER instances are currently waiting on
         *  this signal type (matches real jBPM's KieRuntime.signalEvent(type,event)). */
        public void signalEvent(String type, Object event) { pendingActions.add(PendingAction.signal(type, event, null)); }
        /** targeted delivery to exactly one process instance by id (matches real jBPM's
         *  KieRuntime.signalEvent(type,event,processInstanceId) overload). */
        public void signalEvent(String type, Object event, String processInstanceId) { pendingActions.add(PendingAction.signal(type, event, processInstanceId)); }
        /** real jBPM's id is a long (see ProcessInstance.getId()) */
        public void signalEvent(String type, Object event, long processInstanceId) { pendingActions.add(PendingAction.signal(type, event, String.valueOf(processInstanceId))); }
        /** matches real jBPM's KieRuntime.abortProcessInstance(id) — works for this instance's own
         *  id (self-abort) or any other instance id the script names. */
        public void abortProcessInstance(String processInstanceId) { pendingActions.add(PendingAction.abort(processInstanceId)); }
        public void abortProcessInstance(long processInstanceId) { pendingActions.add(PendingAction.abort(String.valueOf(processInstanceId))); }
    }

    public static final class Environment {
        private final Map<String, String> env;
        Environment(Map<String, String> env) { this.env = env; }
        public Object get(String key) { return env == null ? null : env.get(key); }
    }

    /** A signal or abort a script queued via kcontext during this execution, resolved by the Node-side
     *  caller (which owns the real instance store) once the script returns — the sidecar itself is
     *  stateless per request and has no store access of its own. */
    public static final class PendingAction {
        public final String kind; // "signal" | "abort"
        public final String type; // signal name; null for abort
        public final Object payload; // signal payload; null for abort
        /** signal: null = session-wide broadcast (KieRuntime.signalEvent(type,event)), non-null =
         *  targeted delivery to this instance id. abort: always the instance id to abort. */
        public final String targetInstanceId;
        private PendingAction(String kind, String type, Object payload, String targetInstanceId) {
            this.kind = kind; this.type = type; this.payload = payload; this.targetInstanceId = targetInstanceId;
        }
        static PendingAction signal(String type, Object payload, String targetInstanceId) {
            return new PendingAction("signal", type, payload, targetInstanceId);
        }
        static PendingAction abort(String targetInstanceId) {
            return new PendingAction("abort", null, null, targetInstanceId);
        }
    }
}
