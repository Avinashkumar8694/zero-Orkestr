package bpmscript;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * What {@code System.getenv(..)} / {@code System.getProperty(..)} answer inside a script. In jBPM they read the server's environment; here the equivalent is the
 * deployment's environment settings (what the importer / the deploy dialog stores), so a project that resolves its service URLs from the environment behaves the same.
 * The host process's own environment is never exposed (it holds server secrets): an unset name is {@code null}, like the real thing.
 * ScriptRunner rewrites the calls in script text to this class; the values are set per execution, per thread.
 */
public final class ScriptEnv {
    private static final ThreadLocal<Map<String, String>> CURRENT = new ThreadLocal<Map<String, String>>();
    private ScriptEnv() {}

    static void set(Map<String, String> env) { CURRENT.set(env == null ? Collections.<String, String>emptyMap() : env); }
    static void clear() { CURRENT.remove(); }

    private static Map<String, String> env() { Map<String, String> e = CURRENT.get(); return e == null ? Collections.<String, String>emptyMap() : e; }

    public static String getenv(String name) { return env().get(name); }
    public static Map<String, String> getenv() { return new HashMap<String, String>(env()); }
    public static String getProperty(String name) { return env().get(name); }
    public static String getProperty(String name, String dflt) { String v = env().get(name); return v != null ? v : dflt; }
}
