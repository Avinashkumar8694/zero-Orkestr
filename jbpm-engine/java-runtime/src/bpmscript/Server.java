package bpmscript;

import com.fasterxml.jackson.databind.JsonIO;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal HTTP sidecar (JDK built-in server, no external dependencies) that lets the Node.js engine
 * hand off a single Java script snippet for real JVM execution, instead of transpiling it to
 * JavaScript. Runs a real thread-pool Executor (sized to available CPUs) so concurrent {@code
 * /execute} calls — many process instances stepping through Java script/condition nodes at once —
 * actually run in parallel instead of queuing one-at-a-time behind {@code HttpServer}'s single-thread
 * default. {@link ScriptRunner} is built to be safely callable from multiple threads (see its own
 * concurrency note): log capture is thread-local, not a per-call {@code System.out} swap, and only
 * a script/condition's first-ever compile (a cache miss) is serialized — already-cached execution
 * never blocks on anything shared. Confirmed via a real timing test: 10 concurrent ~200ms script
 * calls used to take ~2000ms total (fully serialized); with this Executor they overlap properly.
 *
 * POST /execute  { code, vars, env, instanceId, nodeInstanceId, nodeId, nodeName, processId,
 *                  processName, correlationKey, parentInstanceId, state, activeNodeInstances }
 *              -> { ok, vars, logs, pendingActions } | { ok:false, error }
 * GET  /health   -> { ok:true }
 */
public final class Server {
    private final ScriptRunner runner = new ScriptRunner();

    public static void main(String[] args) throws IOException {
        // Captured BEFORE anything touches ScriptRunner (whose static initializer permanently
        // redirects System.out to the per-thread script-log capture — see its class javadoc): this
        // reference is the ONLY way this method's own startup line still reaches the real process
        // stdout afterward, since `System.out` itself points somewhere else by the time `new Server()`
        // returns.
        PrintStream realOut = System.out;
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8089;
        Server server = new Server();
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        int threads = Math.max(4, Runtime.getRuntime().availableProcessors());
        http.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(threads));
        http.createContext("/execute", server.new ExecuteHandler());
        http.createContext("/health", server.new HealthHandler());
        http.start();
        // The engine that spawned this JVM owns it. It holds our stdin pipe open; when it exits or crashes the pipe closes and we exit too, so an engine that
        // dies (or a test that calls process.exit) never leaves an orphan JVM behind. Only when the engine asks (BPMSCRIPT_EXIT_WITH_PARENT), so a hand-started
        // sidecar with no stdin keeps running.
        if ("1".equals(System.getenv("BPMSCRIPT_EXIT_WITH_PARENT"))) {
            Thread watchdog = new Thread(() -> {
                try { while (System.in.read() != -1) { /* ignore */ } } catch (IOException ignored) { /* pipe gone */ }
                System.exit(0);
            }, "parent-watchdog");
            watchdog.setDaemon(true);
            watchdog.start();
        }
        // Printed once at startup, before any script can capture System.out — the Node.js parent
        // watches stdout for this line to know the sidecar is ready to accept requests. Read back the
        // actually-bound port (not the requested one) since port 0 means "OS picks an ephemeral port".
        realOut.println("BPMSCRIPT_LISTENING " + http.getAddress().getPort());
    }

    private final class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            writeJson(exchange, 200, singletonOk());
        }
    }

    private final class ExecuteHandler implements HttpHandler {
        @Override
        @SuppressWarnings("unchecked")
        public void handle(HttpExchange exchange) throws IOException {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                writeJson(exchange, 405, errorResponse("only POST is supported"));
                return;
            }
            Map<String, Object> req;
            try {
                req = (Map<String, Object>) JsonIO.parse(readBody(exchange));
            } catch (RuntimeException e) {
                writeJson(exchange, 400, errorResponse("malformed request JSON: " + e.getMessage()));
                return;
            }
            if (req == null) req = new LinkedHashMap<String, Object>();

            String code = (String) req.get("code");
            if (code == null || code.trim().isEmpty()) {
                writeJson(exchange, 400, errorResponse("missing required field: code"));
                return;
            }
            Map<String, Object> vars = (Map<String, Object>) req.get("vars");
            if (vars == null) vars = new LinkedHashMap<String, Object>();
            Map<String, String> env = coerceEnv((Map<String, Object>) req.get("env"));
            String mode = (String) req.get("mode");
            boolean asCondition = "condition".equals(mode);
            Map<String, String> varTypes = coerceEnv((Map<String, Object>) req.get("varTypes"));
            RequestContext ctx = new RequestContext(
                (String) req.get("instanceId"),
                (String) req.get("processId"),
                (String) req.get("processName"),
                (String) req.get("correlationKey"),
                (String) req.get("parentInstanceId"),
                stateFor((String) req.get("state")),
                (String) req.get("nodeInstanceId"),
                (String) req.get("nodeId"),
                (String) req.get("nodeName"),
                env,
                toNodeInstanceList((List<Object>) req.get("activeNodeInstances"))
            );

            try {
                Map<String, Object> resp = new LinkedHashMap<String, Object>();
                resp.put("ok", Boolean.TRUE);
                if ("validate".equals(mode)) {
                    runner.validate(code, Boolean.TRUE.equals(req.get("asCondition")), varTypes);
                } else if (asCondition) {
                    boolean result = runner.runCondition(code, vars, ctx, varTypes);
                    resp.put("result", Boolean.valueOf(result));
                    resp.put("vars", vars);
                } else {
                    ScriptRunner.ExecResult result = runner.run(code, vars, ctx, varTypes);
                    resp.put("vars", result.vars);
                    resp.put("logs", result.logs);
                    resp.put("pendingActions", toActionList(result.pendingActions));
                }
                writeJson(exchange, 200, resp);
            } catch (Exception e) {
                writeJson(exchange, 200, errorResponse(describe(e)));
            }
        }
    }

    private static Map<String, String> coerceEnv(Map<String, Object> raw) {
        Map<String, String> env = new LinkedHashMap<String, String>();
        if (raw != null) {
            for (Map.Entry<String, Object> e : raw.entrySet()) {
                env.put(e.getKey(), e.getValue() == null ? null : String.valueOf(e.getValue()));
            }
        }
        return env;
    }

    /** matches real jBPM's org.kie.api.runtime.process.ProcessInstance state constants — see
     *  KContext.ProcessInstance's STATE_* fields. Node.js sends its own status strings ("running",
     *  "waiting", "completed", "aborted", "suspended", "failed"); "waiting" maps to ACTIVE because
     *  real jBPM's top-level instance state doesn't distinguish "active" from "blocked at a node" —
     *  that's a per-node-instance concept, not a whole-instance one. "failed" maps to ABORTED — real
     *  jBPM has no distinct persisted state for an unrecoverable failure; abort is the closest analog. */
    @SuppressWarnings("unchecked")
    private static int stateFor(String status) {
        if (status == null) return KContext.ProcessInstance.STATE_ACTIVE;
        if (status.equals("running") || status.equals("waiting")) return KContext.ProcessInstance.STATE_ACTIVE;
        if (status.equals("completed")) return KContext.ProcessInstance.STATE_COMPLETED;
        if (status.equals("aborted") || status.equals("failed")) return KContext.ProcessInstance.STATE_ABORTED;
        if (status.equals("suspended")) return KContext.ProcessInstance.STATE_SUSPENDED;
        return KContext.ProcessInstance.STATE_ACTIVE;
    }

    @SuppressWarnings("unchecked")
    private static List<KContext.NodeInstance> toNodeInstanceList(List<Object> raw) {
        List<KContext.NodeInstance> out = new ArrayList<KContext.NodeInstance>();
        if (raw == null) return out;
        for (Object o : raw) {
            if (!(o instanceof Map)) continue;
            Map<String, Object> m = (Map<String, Object>) o;
            out.add(new KContext.NodeInstance((String) m.get("id"), (String) m.get("nodeId"), (String) m.get("nodeName")));
        }
        return out;
    }

    private static List<Object> toActionList(List<KContext.PendingAction> actions) {
        List<Object> out = new ArrayList<Object>();
        for (KContext.PendingAction a : actions) {
            Map<String, Object> entry = new LinkedHashMap<String, Object>();
            entry.put("kind", a.kind);
            entry.put("type", a.type);
            entry.put("payload", a.payload);
            entry.put("targetInstanceId", a.targetInstanceId);
            out.add(entry);
        }
        return out;
    }

    /** exception class name + message; for compile failures ScriptRunner's message already has
     *  full javac diagnostics (kind/text/line), which is the useful part for the caller. */
    private static String describe(Throwable t) {
        String msg = t.getMessage();
        return msg != null && !msg.isEmpty() ? msg : t.getClass().getName();
    }

    private static Map<String, Object> errorResponse(String message) {
        Map<String, Object> resp = new LinkedHashMap<String, Object>();
        resp.put("ok", Boolean.FALSE);
        resp.put("error", message);
        return resp;
    }

    private static Map<String, Object> singletonOk() {
        Map<String, Object> resp = new LinkedHashMap<String, Object>();
        resp.put("ok", Boolean.TRUE);
        return resp;
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        InputStream in = exchange.getRequestBody();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
        return buf.toString("UTF-8");
    }

    private static void writeJson(HttpExchange exchange, int status, Map<String, Object> body) throws IOException {
        byte[] bytes = JsonIO.write(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        OutputStream os = exchange.getResponseBody();
        os.write(bytes);
        os.close();
    }
}
