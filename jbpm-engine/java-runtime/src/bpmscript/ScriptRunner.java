package bpmscript;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UnsupportedEncodingException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Compiles a Java script snippet (the exact text a script node/onEntry/onExit/condition carries —
 * never rewritten) into a real class, entirely in memory (no javac subprocess, no disk writes, no
 * jar), using the JDK's built-in Compiler API. Compiled classes are cached by a hash of the source
 * text, so the same script (run again for another instance, or another step of the same instance)
 * is compiled exactly once. This is intentionally NOT "compile the whole project" — only the one
 * script snippet actually being executed is ever compiled, on first use, at runtime.
 *
 * Concurrency: {@link Server} runs requests on a real thread pool (see its Executor), so this class
 * is built to be safely callable from multiple threads at once:
 *  - Log capture is thread-local, not a per-call {@code System.setOut}/restore swap — a SINGLE
 *    dispatching {@link PrintStream} is installed as {@code System.out} exactly once (static
 *    initializer below), and its writes fan out to a per-thread buffer via {@link #CAPTURE}. Two
 *    scripts running concurrently on different threads each see and fill only their OWN buffer;
 *    there is no shared mutable "current capture" to race on.
 *  - Compilation (the cache-miss path in {@link #exec}/{@link #validate}) is serialized behind
 *    {@link #compileLock} — NOT because concurrent {@code javax.tools.JavaCompiler.getTask(...).
 *    call()} invocations on the shared compiler instance are known to be unsafe, but because it
 *    isn't documented as safe either, and because {@link InMemoryClassLoader#findClass} would throw
 *    {@code LinkageError: duplicate class definition} if two threads both won a cache-miss race for
 *    the identical new script and each tried to define the same generated class. This only affects
 *    the FIRST execution of a distinct script (ever, for the sidecar process's lifetime) — every
 *    subsequent call for that same script/varTypes shape hits the cache and never touches the lock,
 *    so this doesn't reintroduce serialization for the common case.
 *  - Invocation of an already-cached class ({@code cls.getMethod(...).invoke(...)}) runs fully
 *    concurrently, outside any lock — this is what actually matters for many instances concurrently
 *    stepping through the SAME already-published (and therefore already-compiled) process.
 */
public final class ScriptRunner {
    private final JavaCompiler compiler;
    private final Map<String, Class<?>> cache = new ConcurrentHashMap<String, Class<?>>();
    private final InMemoryClassLoader classLoader;
    private final Object compileLock = new Object();

    /** Per-thread capture buffer for {@code System.out} — see the class javadoc's concurrency note. */
    private static final ThreadLocal<ByteArrayOutputStream> CAPTURE = new ThreadLocal<ByteArrayOutputStream>() {
        @Override protected ByteArrayOutputStream initialValue() { return new ByteArrayOutputStream(); }
    };
    static {
        // Installed ONCE, permanently — never swapped again, so there's nothing to race on. Every
        // write real user code makes via System.out.println(...) lands here and is routed to
        // WHICHEVER thread is currently writing, via the ThreadLocal above.
        System.setOut(newUtf8PrintStream(new OutputStream() {
            @Override public void write(int b) { CAPTURE.get().write(b); }
            @Override public void write(byte[] b, int off, int len) { CAPTURE.get().write(b, off, len); }
        }));
    }

    public ScriptRunner() {
        compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("No system Java compiler available — run this sidecar with a JDK, not a JRE.");
        classLoader = new InMemoryClassLoader(ScriptRunner.class.getClassLoader());
    }

    /** script/onEntry/onExit body — statements only, no return value (matches real jBPM). Real
     *  jBPM's own Java script/onEntry/onExit dialect ALSO binds declared process variables as bare
     *  identifiers, via the identical unbound-identifier mechanism {@code JavaActionBuilder}/
     *  {@code createVariableContext} uses for conditions — confirmed against jBPM's own build-time
     *  codegen templates (not just conditions, as an earlier pass through this code assumed). Bare
     *  names there are read-only local copies (mutating the referenced object is visible; reassigning
     *  the bare name itself is not written back) — this implementation matches that exactly, simply
     *  by virtue of never having built a write-back path for Java bare names. {@code kcontext.
     *  getVariable(...)} always still works regardless. This engine also offers a handful of its OWN
     *  meta-locals ({@code instanceId}/{@code processId}/{@code processName}/{@code correlationKey}/
     *  {@code parentInstanceId}/{@code currentNodeId}/{@code currentNodeName}) as a simpler
     *  alternative to the {@code kcontext.getProcessInstance().getX()} chains — NOT a jBPM concept,
     *  bare identifiers this engine synthesizes; see {@link #withVarBindings}. */
    public ExecResult run(String code, Map<String, Object> vars, RequestContext ctx, Map<String, String> varTypes) throws Exception {
        return exec("S", code, false, vars, ctx, varTypes);
    }

    /** sequence-flow / gateway condition — a boolean expression, matching real jBPM's Java condition
     *  dialect: either a full body ending in an explicit {@code return <bool>;}, or (far more common)
     *  a bare boolean expression with no return keyword at all, which is wrapped as one here exactly
     *  like the JS-dialect condition path does (see sandbox.ts evalCondition). {@code varTypes} is the
     *  process's DECLARED variable types (name -> Java type/FQN, from the same structureRef vocabulary
     *  real jBPM uses) — real jBPM's Java dialect binds every declared process variable as a bare,
     *  typed local identifier in scope for scripts and conditions alike (confirmed against this
     *  project's own real conditions, e.g. {@code return retryCount < maxRetryCount;}), in ADDITION to
     *  {@code kcontext.getVariable(...)} still working; see {@link #conditionBody}. */
    public boolean runCondition(String code, Map<String, Object> vars, RequestContext ctx, Map<String, String> varTypes) throws Exception {
        ExecResult r = exec("C", code, true, vars, ctx, varTypes);
        return Boolean.TRUE.equals(r.returnValue);
    }

    /** Publish-time dry compile: real ground truth for whether this exact script text will run,
     *  since it's compiled with the identical wrapper shape {@link #run}/{@link #runCondition} use —
     *  no separate parser/heuristic to drift out of sync with what execution actually does. Throws
     *  (with javac's own diagnostics) on a compile error; does nothing observable on success. Shares
     *  the same cache, so validating a script and then actually running it never compiles it twice. */
    public void validate(String code, boolean asCondition, Map<String, String> varTypes) throws ClassNotFoundException {
        String className = classNameFor(asCondition ? "C" : "S", code, varTypes);
        getOrCompile(className, code, asCondition, varTypes);
    }

    /** Cache-miss path, serialized behind {@link #compileLock} (double-checked: re-reads the cache
     *  once inside the lock, in case another thread finished compiling this exact class while this
     *  one was waiting) — see the class javadoc's concurrency note for why. Never touched again once
     *  a class is cached, so this lock is never contended for anything but a script's/condition's
     *  first-ever compile. */
    private Class<?> getOrCompile(String className, String code, boolean asCondition, Map<String, String> varTypes) throws ClassNotFoundException {
        Class<?> cls = cache.get(className);
        if (cls != null) return cls;
        synchronized (compileLock) {
            cls = cache.get(className);
            if (cls != null) return cls;
            String body = asCondition ? conditionBody(code, varTypes) : withVarBindings(code, varTypes);
            // System.getenv / System.getProperty answer from the deployment's environment (see ScriptEnv), never the host's
            body = body.replaceAll("\\bSystem\\s*\\.\\s*(getenv|getProperty)\\s*\\(", "bpmscript.ScriptEnv.$1(");
            cls = compile(className, body, asCondition);
            cache.put(className, cls);
            return cls;
        }
    }

    private ExecResult exec(String prefix, String code, boolean asCondition, Map<String, Object> vars, RequestContext ctx, Map<String, String> varTypes) throws Exception {
        String className = classNameFor(prefix, code, varTypes);
        Class<?> cls = getOrCompile(className, code, asCondition, varTypes);
        KContext kcontext = new KContext(vars, varTypes, ctx.instanceId, ctx.processId, ctx.processName, ctx.correlationKey,
            ctx.parentInstanceId, ctx.state, ctx.nodeInstanceId, ctx.nodeId, ctx.nodeName, ctx.env, ctx.activeNodeInstances);
        // Thread-local capture (see class javadoc) — reset THIS thread's buffer, run, read back only
        // what THIS thread's execution wrote. No System.out swap/restore: it was installed once, ever.
        ByteArrayOutputStream captured = CAPTURE.get();
        captured.reset();
        Object returnValue = null;
        ScriptEnv.set(ctx.env);
        try {
            Method m = cls.getMethod("run", KContext.class);
            returnValue = m.invoke(null, kcontext);
        } catch (InvocationTargetException ite) {
            Throwable cause = ite.getCause();
            throw cause instanceof Exception ? (Exception) cause : new RuntimeException(cause);
        } finally {
            ScriptEnv.clear();
        }
        String logs = toUtf8String(captured);
        return new ExecResult(vars, logs, kcontext.pendingActions(), returnValue);
    }

    /** real jBPM Java conditions are very often a bare expression with no `return` at all. */
    private static String conditionBody(String code, Map<String, String> varTypes) {
        String body = code.contains("return") ? code : "return (" + code + ");";
        return withVarBindings(body, varTypes);
    }

    /** prepends a typed local declaration for each bindable declared variable ACTUALLY REFERENCED in
     *  the code, THEN each referenced meta-local ({@link #META_LOCALS}) — shared by both scripts
     *  ({@link #run}) and conditions ({@link #conditionBody}). A variable name that isn't a legal
     *  Java identifier (or collides with a keyword) is silently skipped for bare binding; {@code
     *  kcontext.getVariable(name)} still always works regardless, so nothing is unreachable — only
     *  the bare-name convenience is unavailable for that one name.
     *
     *  Usage-gating here is a correctness fix, not just an optimization: binding EVERY declared
     *  process variable unconditionally (regardless of whether the condition/script references it)
     *  means a completely unrelated declared variable whose actual stored value doesn't exactly match
     *  its declared type — e.g. a `double` variable holding a whole number, which this engine's own
     *  JSON parser stores as {@code Integer}, not {@code Double} (see JsonIO.Parser.parseNumber) —
     *  throws a ClassCastException on the auto-generated `(Double) kcontext.getVariable(...)` cast
     *  before the condition/script body ever runs. For a condition, {@code evalCondition}'s catch-all
     *  silently swallows that and returns false; for a script, it surfaces as an opaque SCRIPT_ERROR —
     *  both regardless of whether the condition/script even mentions that variable. Confirmed as a
     *  real, reproducible bug this session: a bare `((Number) kcontext.getVariable("amount")).
     *  doubleValue() > 1000` condition — which never references the bare word `amount` — silently
     *  evaluated to false whenever `amount` was declared `double` but held a whole-number value.
     *  bpmn-sdk's EXPORT-time twin ({@code javaBareNamePreamble}) already gated on usage correctly;
     *  this brings the execution-time binding in line with it. */
    private static String withVarBindings(String code, Map<String, String> varTypes) {
        // Blanked ONCE and reused for every containsWord() check below — a name appearing only
        // inside a string literal (overwhelmingly the common case: kcontext.getVariable("amount")
        // itself contains the word "amount") must NOT count as "referenced as a bare identifier".
        String scan = blankStringsAndComments(code);
        StringBuilder bindings = new StringBuilder();
        if (varTypes != null) {
            for (Map.Entry<String, String> e : varTypes.entrySet()) {
                String name = e.getKey();
                if (!isBindableIdentifier(name)) continue;
                if (!containsWord(scan, name)) continue;
                if (declaresLocal(scan, name)) continue;          // the script declares its own local of that name (valid jBPM Java): do not add a clashing binding
                String type = javaTypeFor(e.getValue());
                bindings.append(type).append(' ').append(name)
                    .append(" = (").append(type).append(") kcontext.getVariable(\"")
                    .append(name.replace("\\", "\\\\").replace("\"", "\\\"")).append("\");\n");
            }
        }
        for (String[] meta : META_LOCALS) {
            String name = meta[0], expr = meta[1];
            // a declared process variable of the same name always wins — the user's own data takes
            // precedence over this engine's synthetic convenience local.
            if (varTypes != null && varTypes.containsKey(name)) continue;
            if (!containsWord(scan, name)) continue;
            if (declaresLocal(scan, name)) continue;
            bindings.append("String ").append(name).append(" = ").append(expr).append(";\n");
        }
        return bindings.toString() + code;
    }

    private static final java.util.Set<String> NOT_A_TYPE = new java.util.HashSet<String>(java.util.Arrays.asList(
        "return", "new", "else", "case", "throw", "instanceof", "assert", "yield", "do", "in", "default", "goto"));
    /** true when the (string/comment-blanked) script declares a local or parameter called `name`: `Type name =`, `Type name;`, `Type name,`, `for (Type name : xs)`, `catch (E name)`. */
    private static boolean declaresLocal(String scan, String name) {
        java.util.regex.Matcher m = java.util.regex.Pattern
            .compile("(?<![\\w$.])([A-Za-z_][\\w$.]*(?:<[^>;()]*>)?(?:\\[\\])*)\\s+" + java.util.regex.Pattern.quote(name) + "\\s*(?==|;|,|\\)|:)")
            .matcher(scan);
        while (m.find()) if (!NOT_A_TYPE.contains(m.group(1))) return true;
        return false;
    }

    /** Blanks out string/char literals and comments (replacing their contents with spaces, preserving
     *  length/newlines) so a bare-word scan never fires on an incidental match inside a string literal
     *  — e.g. {@code kcontext.getVariable("amount")} contains the word "amount" too, but that's a
     *  string argument, not a reference to the bare identifier. A simple char-scan, not a full lexer —
     *  matches java-compat.ts's blankStringsAndComments (the TS-side denylist scanner) exactly, since
     *  both need only find literal/comment BOUNDARIES, not parse expressions. */
    private static String blankStringsAndComments(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            char c2 = i + 1 < n ? src.charAt(i + 1) : '\0';
            if (c == '/' && c2 == '/') {
                int j = i;
                while (j < n && src.charAt(j) != '\n') j++;
                blankInto(out, src, i, j);
                i = j;
            } else if (c == '/' && c2 == '*') {
                int j = i + 2;
                while (j < n - 1 && !(src.charAt(j) == '*' && src.charAt(j + 1) == '/')) j++;
                j = Math.min(j + 2, n);
                blankInto(out, src, i, j);
                i = j;
            } else if (c == '"' || c == '\'') {
                char quote = c;
                int j = i + 1;
                while (j < n && src.charAt(j) != quote && src.charAt(j) != '\n') { if (src.charAt(j) == '\\') j++; j++; }
                j = Math.min(j + 1, n);
                blankInto(out, src, i, j);
                i = j;
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }
    private static void blankInto(StringBuilder out, String src, int from, int to) {
        for (int k = from; k < to; k++) out.append(src.charAt(k) == '\n' ? '\n' : ' ');
    }

    /** This engine's own additive sugar for Java scripts/conditions — same idea as the JS dialect's
     *  `instance`/`node` globals (see sandbox.ts), but as flat, read-only, typed local identifiers
     *  instead of an object, since Java has no ad hoc object-literal syntax. Real jBPM has no concept
     *  of these names at all, so exporting a script/condition that references one of them prepends
     *  the identical declaration text (see bpmn-sdk/src/engine.ts's javaMetaLocalsPreamble) so the
     *  exported source is plain, self-contained Java with no dependency on this engine. Deliberately
     *  String-only (matches every underlying getter's real return type) — no `state`/`activeNodes`
     *  meta-local is offered here, unlike the JS `instance` object, because real jBPM's own Java
     *  idiom already expects the STATE_* int constants and a List<NodeInstance>; a Java author
     *  targeting jBPM export is expected to use `kcontext.getProcessInstance().getState()`/
     *  `.getNodeInstances()` directly for those, not a Node-engine reinterpretation of them. */
    private static final String[][] META_LOCALS = {
        { "instanceId", "String.valueOf(kcontext.getProcessInstance().getId())" },
        { "processId", "kcontext.getProcessInstance().getProcessId()" },
        { "processName", "kcontext.getProcessInstance().getProcessName()" },
        { "correlationKey", "kcontext.getProcessInstance().getCorrelationKey()" },
        { "parentInstanceId", "kcontext.getProcessInstance().getParentProcessInstanceId()" },
        { "currentNodeId", "kcontext.getNodeInstance().getNodeId()" },
        { "currentNodeName", "kcontext.getNodeInstance().getNodeName()" },
    };

    private static boolean containsWord(String code, String name) {
        return java.util.regex.Pattern.compile("\\b" + java.util.regex.Pattern.quote(name) + "\\b").matcher(code).find();
    }

    private static final java.util.Set<String> JAVA_RESERVED = new java.util.HashSet<String>(java.util.Arrays.asList(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
        "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
        "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
        "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
        "volatile", "while", "true", "false", "null", "var", "yield", "record", "kcontext"
    ));

    private static boolean isBindableIdentifier(String name) {
        if (name == null || name.isEmpty() || JAVA_RESERVED.contains(name)) return false;
        if (!Character.isJavaIdentifierStart(name.charAt(0))) return false;
        for (int i = 1; i < name.length(); i++) if (!Character.isJavaIdentifierPart(name.charAt(i))) return false;
        return true;
    }

    /** Maps a declared structureRef (real jBPM's variable-type vocabulary — see
     *  docs/bpm-nodes/_mappings-reference.md §6) to a Java reference type safe to declare here.
     *  Always a boxed/reference type (never a bare primitive) so a null value still compiles and
     *  assigns cleanly; operators auto-unbox at point of use. An unrecognized type (a custom
     *  project-specific POJO FQN — never resolvable on this classpath, no Maven, no application
     *  classes) falls back to Object rather than failing to compile the whole condition. */
    /** Package-private (not private) — also called by {@link KContext#getVariable} to coerce a
     *  declared variable's value to its proper type on every read, not just for the bare-name
     *  binding preamble. See STRUCTURE_REF_TO_JAVA's javadoc for why that coercion is needed. */
    static String javaTypeFor(String declared) {
        String d = declared == null ? null : declared.trim();
        String mapped = d == null ? null : STRUCTURE_REF_TO_JAVA.get(d);
        // the engine's own type names (what an imported or authored process declares: string, int, bool, long, double, date, object, list, map)
        if (mapped == null && d != null) mapped = ENGINE_TYPE_TO_JAVA.get(d.toLowerCase());
        return mapped != null ? mapped : "Object";
    }

    static final Map<String, String> ENGINE_TYPE_TO_JAVA = new HashMap<String, String>();
    static {
        ENGINE_TYPE_TO_JAVA.put("string", "String"); ENGINE_TYPE_TO_JAVA.put("int", "Integer"); ENGINE_TYPE_TO_JAVA.put("integer", "Integer");
        ENGINE_TYPE_TO_JAVA.put("long", "Long"); ENGINE_TYPE_TO_JAVA.put("double", "Double"); ENGINE_TYPE_TO_JAVA.put("float", "Float");
        ENGINE_TYPE_TO_JAVA.put("bool", "Boolean"); ENGINE_TYPE_TO_JAVA.put("boolean", "Boolean");
        ENGINE_TYPE_TO_JAVA.put("date", "java.util.Date"); ENGINE_TYPE_TO_JAVA.put("object", "Object");
        ENGINE_TYPE_TO_JAVA.put("list", "java.util.List"); ENGINE_TYPE_TO_JAVA.put("map", "java.util.Map");
    }
    static final Map<String, String> STRUCTURE_REF_TO_JAVA = new HashMap<String, String>();
    static {
        for (String s : new String[] { "String", "java.lang.String" }) STRUCTURE_REF_TO_JAVA.put(s, "String");
        for (String s : new String[] { "Integer", "java.lang.Integer", "int" }) STRUCTURE_REF_TO_JAVA.put(s, "Integer");
        for (String s : new String[] { "Long", "java.lang.Long", "long" }) STRUCTURE_REF_TO_JAVA.put(s, "Long");
        for (String s : new String[] { "Double", "java.lang.Double", "double" }) STRUCTURE_REF_TO_JAVA.put(s, "Double");
        for (String s : new String[] { "Float", "java.lang.Float", "float" }) STRUCTURE_REF_TO_JAVA.put(s, "Float");
        for (String s : new String[] { "Boolean", "java.lang.Boolean", "boolean" }) STRUCTURE_REF_TO_JAVA.put(s, "Boolean");
        for (String s : new String[] { "Object", "java.lang.Object", "" }) STRUCTURE_REF_TO_JAVA.put(s, "Object");
        for (String s : new String[] { "BigDecimal", "java.math.BigDecimal" }) STRUCTURE_REF_TO_JAVA.put(s, "java.math.BigDecimal");
        for (String s : new String[] { "BigInteger", "java.math.BigInteger" }) STRUCTURE_REF_TO_JAVA.put(s, "java.math.BigInteger");
        STRUCTURE_REF_TO_JAVA.put("List", "java.util.List"); STRUCTURE_REF_TO_JAVA.put("java.util.List", "java.util.List");
        STRUCTURE_REF_TO_JAVA.put("Map", "java.util.Map"); STRUCTURE_REF_TO_JAVA.put("java.util.Map", "java.util.Map");
        STRUCTURE_REF_TO_JAVA.put("Set", "java.util.Set"); STRUCTURE_REF_TO_JAVA.put("java.util.Set", "java.util.Set");
        STRUCTURE_REF_TO_JAVA.put("Date", "java.util.Date"); STRUCTURE_REF_TO_JAVA.put("java.util.Date", "java.util.Date");
    }

    /** the compiled class depends on the condition text AND (for conditions) the bound-variable
     *  schema, so both must be part of the cache key — two processes sharing identical condition
     *  text but different declared variable types must not share a compiled class. */
    private static String classNameFor(String prefix, String code, Map<String, String> varTypes) {
        int h = code.hashCode();
        if (varTypes != null && !varTypes.isEmpty()) {
            java.util.List<String> keys = new ArrayList<String>(varTypes.keySet());
            Collections.sort(keys);
            StringBuilder shape = new StringBuilder();
            for (String k : keys) shape.append(k).append(':').append(varTypes.get(k)).append(';');
            h = h * 31 + shape.toString().hashCode();
        }
        return prefix + Integer.toHexString(h);
    }

    private static PrintStream newUtf8PrintStream(OutputStream target) {
        try { return new PrintStream(target, true, "UTF-8"); }
        catch (UnsupportedEncodingException e) { throw new RuntimeException(e); } // UTF-8 is always available
    }

    private static String toUtf8String(ByteArrayOutputStream bytes) {
        try { return bytes.toString("UTF-8"); }
        catch (UnsupportedEncodingException e) { throw new RuntimeException(e); }
    }

    private Class<?> compile(String className, String userCode, boolean asCondition) throws ClassNotFoundException {
        String qualified = "bpmscript.generated." + className;
        String returnType = asCondition ? "boolean" : "void";
        String source = "package bpmscript.generated;\n"
            + "import bpmscript.KieFunctions;\n"
            + "import org.json.*;\n"
            + "public class " + className + " {\n"
            + "  public static " + returnType + " run(bpmscript.KContext kcontext) throws Exception {\n"
            + userCode + "\n"
            + "  }\n"
            + "}\n";
        JavaFileObject file = new StringSource(qualified, source);
        InMemoryFileManager fileManager = new InMemoryFileManager(compiler.getStandardFileManager(null, null, null), classLoader);
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();
        JavaCompiler.CompilationTask task = compiler.getTask(null, fileManager, diagnostics, null, null, Collections.singletonList(file));
        boolean ok = task.call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("script does not compile:\n");
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                sb.append(d.getKind()).append(": ").append(d.getMessage(null));
                if (d.getLineNumber() >= 0) sb.append(" (line ").append(d.getLineNumber()).append(')');
                sb.append('\n');
            }
            throw new RuntimeException(sb.toString());
        }
        return classLoader.loadClass(qualified);
    }

    // ---- in-memory compilation plumbing (no disk I/O for the generated class) ----

    private static final class StringSource extends SimpleJavaFileObject {
        final String code;
        StringSource(String qualifiedName, String code) {
            super(URI.create("string:///" + qualifiedName.replace('.', '/') + Kind.SOURCE.extension), Kind.SOURCE);
            this.code = code;
        }
        @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return code; }
    }

    private static final class BytesClassFile extends SimpleJavaFileObject {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        BytesClassFile(String qualifiedName, Kind kind) {
            super(URI.create("bytes:///" + qualifiedName.replace('.', '/') + kind.extension), kind);
        }
        @Override public OutputStream openOutputStream() { return bytes; }
    }

    private static final class InMemoryFileManager extends ForwardingJavaFileManager<JavaFileManager> {
        private final InMemoryClassLoader loader;
        InMemoryFileManager(JavaFileManager fileManager, InMemoryClassLoader loader) { super(fileManager); this.loader = loader; }
        @Override
        public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind, FileObject sibling) throws IOException {
            BytesClassFile file = new BytesClassFile(className, kind);
            loader.addClass(className, file);
            return file;
        }
    }

    private static final class InMemoryClassLoader extends ClassLoader {
        private final Map<String, BytesClassFile> classFiles = new HashMap<String, BytesClassFile>();
        InMemoryClassLoader(ClassLoader parent) { super(parent); }
        void addClass(String name, BytesClassFile file) { classFiles.put(name, file); }
        @Override
        protected Class<?> findClass(String name) throws ClassNotFoundException {
            BytesClassFile file = classFiles.get(name);
            if (file == null) return super.findClass(name);
            byte[] bytes = file.bytes.toByteArray();
            return defineClass(name, bytes, 0, bytes.length);
        }
    }

    public static final class ExecResult {
        public final Map<String, Object> vars;
        public final String logs;
        public final List<KContext.PendingAction> pendingActions;
        public final Object returnValue;
        ExecResult(Map<String, Object> vars, String logs, List<KContext.PendingAction> pendingActions, Object returnValue) {
            this.vars = vars;
            this.logs = logs;
            this.pendingActions = pendingActions == null ? new ArrayList<KContext.PendingAction>() : pendingActions;
            this.returnValue = returnValue;
        }
    }
}
