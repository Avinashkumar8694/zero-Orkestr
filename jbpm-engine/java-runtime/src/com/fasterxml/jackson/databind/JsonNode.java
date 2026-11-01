package com.fasterxml.jackson.databind;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Source-compatible shim for {@code com.fasterxml.jackson.databind.JsonNode} — not the real
 * upstream Jackson class, but the same package/class name and the accessor surface real jBPM
 * scripts actually call (has/get/path/asText/asBoolean/asInt/asLong/asDouble/isArray/isObject/
 * isNull/size/elements/fieldNames/toString), backed by plain JDK types (Map/List/String/Number/
 * Boolean) so it round-trips cleanly with {@link ObjectMapper}.
 */
public class JsonNode implements Iterable<JsonNode> {
    /** shared sentinel for a missing path — path() never returns null, matching real Jackson. */
    public static final JsonNode MISSING = new JsonNode(MissingMarker.INSTANCE);

    private static final class MissingMarker {
        static final MissingMarker INSTANCE = new MissingMarker();
        private MissingMarker() { }
    }

    protected final Object raw;

    protected JsonNode(Object raw) { this.raw = raw; }

    /** wraps a raw parsed value with its real Jackson-equivalent polymorphic type: object/array
     *  children come back as actual ObjectNode/ArrayNode instances (not a plain JsonNode), exactly
     *  like real Jackson, so scripts that do e.g. {@code (ArrayNode) node.get("items")} or
     *  {@code ((ObjectNode) node.get("address")).put(...)} work unmodified. The wrapper holds the
     *  SAME map/list instance, so mutations through the child are visible via the parent tree too. */
    @SuppressWarnings("unchecked")
    public static JsonNode wrap(Object raw) {
        if (raw == null) return null;
        if (raw instanceof JsonNode) return (JsonNode) raw;
        if (raw instanceof Map) return new com.fasterxml.jackson.databind.node.ObjectNode((Map<String, Object>) raw);
        if (raw instanceof List) return new com.fasterxml.jackson.databind.node.ArrayNode((List<Object>) raw);
        return new JsonNode(raw);
    }

    @SuppressWarnings("unchecked")
    public JsonNode get(String field) {
        if (raw == MissingMarker.INSTANCE) return null;
        if (!(raw instanceof Map)) return null;
        Object v = ((Map<String, Object>) raw).get(field);
        return v == null ? null : wrap(v);
    }

    public JsonNode get(int index) {
        if (raw == MissingMarker.INSTANCE) return null;
        if (!(raw instanceof List)) return null;
        List<?> l = (List<?>) raw;
        if (index < 0 || index >= l.size()) return null;
        Object v = l.get(index);
        return v == null ? null : wrap(v);
    }

    @SuppressWarnings("unchecked")
    public JsonNode path(String field) {
        if (raw == MissingMarker.INSTANCE) return MISSING;
        if (!(raw instanceof Map)) return MISSING;
        Object v = ((Map<String, Object>) raw).get(field);
        return v == null ? MISSING : wrap(v);
    }

    public JsonNode path(int index) {
        if (raw == MissingMarker.INSTANCE) return MISSING;
        if (!(raw instanceof List)) return MISSING;
        List<?> l = (List<?>) raw;
        if (index < 0 || index >= l.size()) return MISSING;
        Object v = l.get(index);
        return v == null ? MISSING : wrap(v);
    }

    @SuppressWarnings("unchecked")
    public boolean has(String field) {
        return raw instanceof Map && ((Map<String, Object>) raw).containsKey(field);
    }

    /** true when the field exists and is not JSON null (Jackson's hasNonNull). */
    public boolean hasNonNull(String field) { return has(field) && !path(field).isNull(); }

    public boolean has(int index) {
        return raw instanceof List && index >= 0 && index < ((List<?>) raw).size();
    }

    public String asText() { return asText(null); }
    public String asText(String defaultValue) {
        if (raw == null || raw == MissingMarker.INSTANCE) return defaultValue;
        return String.valueOf(raw);
    }

    public boolean asBoolean() { return asBoolean(false); }
    public boolean asBoolean(boolean defaultValue) {
        if (raw instanceof Boolean) return (Boolean) raw;
        if (raw instanceof String) return Boolean.parseBoolean((String) raw);
        if (raw == null || raw == MissingMarker.INSTANCE) return defaultValue;
        return defaultValue;
    }

    public int asInt() { return asInt(0); }
    public int asInt(int defaultValue) {
        if (raw instanceof Number) return ((Number) raw).intValue();
        if (raw instanceof String) { try { return Integer.parseInt((String) raw); } catch (NumberFormatException e) { return defaultValue; } }
        return defaultValue;
    }

    public long asLong() { return asLong(0L); }
    public long asLong(long defaultValue) {
        if (raw instanceof Number) return ((Number) raw).longValue();
        if (raw instanceof String) { try { return Long.parseLong((String) raw); } catch (NumberFormatException e) { return defaultValue; } }
        return defaultValue;
    }

    public double asDouble() { return asDouble(0d); }
    public double asDouble(double defaultValue) {
        if (raw instanceof Number) return ((Number) raw).doubleValue();
        if (raw instanceof String) { try { return Double.parseDouble((String) raw); } catch (NumberFormatException e) { return defaultValue; } }
        return defaultValue;
    }

    public boolean isNull() { return raw == null; }
    public boolean isMissingNode() { return raw == MissingMarker.INSTANCE; }
    public boolean isArray() { return raw instanceof List; }
    public boolean isObject() { return raw instanceof Map; }
    public boolean isTextual() { return raw instanceof String; }
    public boolean isNumber() { return raw instanceof Number; }
    public boolean isBoolean() { return raw instanceof Boolean; }

    public int size() {
        if (raw instanceof Map) return ((Map<?, ?>) raw).size();
        if (raw instanceof List) return ((List<?>) raw).size();
        return 0;
    }

    @SuppressWarnings("unchecked")
    public Iterator<String> fieldNames() {
        if (!(raw instanceof Map)) return Collections.<String>emptyList().iterator();
        return new ArrayList<String>(((Map<String, Object>) raw).keySet()).iterator();
    }

    public Iterator<JsonNode> elements() {
        List<JsonNode> out = new ArrayList<JsonNode>();
        if (raw instanceof List) for (Object o : (List<?>) raw) out.add(wrap(o));
        return out.iterator();
    }

    /** real Jackson's JsonNode implements Iterable<JsonNode> over its array elements, which is what
     *  lets scripts write {@code for (JsonNode item : arrayNode)} directly instead of .elements(). */
    @Override
    public Iterator<JsonNode> iterator() { return elements(); }

    /** underlying raw value (Map/List/String/Number/Boolean/null) — used internally by ObjectMapper
     *  and the node/ subpackage's mutable node types; public since Java access control has no
     *  concept of "package + subpackages" as one unit. */
    public Object rawValue() { return raw == MissingMarker.INSTANCE ? null : raw; }

    @Override
    public String toString() {
        return raw == MissingMarker.INSTANCE ? "null" : JsonIO.write(raw);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof JsonNode)) return false;
        Object a = rawValue(), b = ((JsonNode) o).rawValue();
        return a == null ? b == null : a.equals(b);
    }

    @Override
    public int hashCode() { Object v = rawValue(); return v == null ? 0 : v.hashCode(); }
}
