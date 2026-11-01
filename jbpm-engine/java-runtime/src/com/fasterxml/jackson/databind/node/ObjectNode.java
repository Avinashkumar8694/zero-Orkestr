package com.fasterxml.jackson.databind.node;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Source-compatible shim for {@code com.fasterxml.jackson.databind.node.ObjectNode} — a mutable
 * {@link JsonNode} backed by a {@code LinkedHashMap<String,Object>}, matching the builder-style
 * usage (put/putPOJO/set/remove) real jBPM REST/script wrapper code uses to build request payloads.
 */
public class ObjectNode extends JsonNode {
    @SuppressWarnings("unchecked")
    public ObjectNode() { super(new LinkedHashMap<String, Object>()); }

    /** wraps an already-parsed map by reference, so mutations here are visible through the parent
     *  tree too — used by JsonNode.wrap() to give object children their real polymorphic type,
     *  matching real Jackson (a node's object-typed child IS an ObjectNode, not a plain JsonNode). */
    public ObjectNode(Map<String, Object> raw) { super(raw); }

    @SuppressWarnings("unchecked")
    private Map<String, Object> map() { return (Map<String, Object>) raw; }

    public ObjectNode put(String field, String value) { map().put(field, value); return this; }
    public ObjectNode put(String field, int value) { map().put(field, Long.valueOf(value)); return this; }
    public ObjectNode put(String field, long value) { map().put(field, Long.valueOf(value)); return this; }
    public ObjectNode put(String field, double value) { map().put(field, Double.valueOf(value)); return this; }
    public ObjectNode put(String field, boolean value) { map().put(field, Boolean.valueOf(value)); return this; }

    /** putPOJO — store any value as-is (JsonNode is unwrapped to its raw form, matching real Jackson). */
    public ObjectNode putPOJO(String field, Object value) {
        map().put(field, value instanceof JsonNode ? ((JsonNode) value).rawValue() : value);
        return this;
    }

    public ObjectNode set(String field, JsonNode value) {
        map().put(field, value == null ? null : value.rawValue());
        return this;
    }

    public ObjectNode putNull(String field) { map().put(field, null); return this; }

    public ObjectNode remove(String field) { map().remove(field); return this; }

    /** Creates a new empty array, attaches it under `field`, and returns THAT array (not `this`) — a
     *  live reference: further `.add(...)` calls on the returned node ARE reflected here too, since it
     *  wraps the identical backing list this map now also holds. Confirmed needed against a real
     *  onEntry script in the bundled sample project (pru-verification-process.bpmn) this session. */
    public ArrayNode putArray(String field) {
        ArrayNode arr = new ArrayNode();
        map().put(field, arr.rawValue());
        return arr;
    }

    /** Same idea as {@link #putArray}, for a nested object field. */
    public ObjectNode putObject(String field) {
        ObjectNode obj = new ObjectNode();
        map().put(field, obj.rawValue());
        return obj;
    }
}
