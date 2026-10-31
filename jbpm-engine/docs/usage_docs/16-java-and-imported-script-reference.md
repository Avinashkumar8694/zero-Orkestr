# Java & Imported Script Node Reference Manual

A comprehensive developer reference for all Java-supported methods, classes, constructors, variable bindings, and execution contexts used in **imported Java and legacy script nodes**.

> [!NOTE]
> **Scope of this Document**:
> This reference is specifically for:
> 1. Workflows imported from legacy jBPM / KIE systems containing Java dialect scripts (`lang: "java"` / `http://www.java.com/java`).
> 2. Imported legacy JavaScript nodes utilizing Nashorn/GraalVM Java interoperability (`Java.type(...)` / `java.util.*`).
> 
> *For native JavaScript and TypeScript workflows authored directly in this engine, refer to `15-javascript-and-flow-variables-cheatsheet.md`.*

---

## 1. Execution Architecture for Imported Java Nodes

Imported processes with Java code execute through two distinct, fully-supported execution pathways:

```mermaid
flowchart TD
    subgraph ImportWorkflow["Imported Workflow Node Execution"]
        direction TB
        Node["Imported Script / Condition Node"]
        
        Node -->|lang: 'java'| Sidecar["JVM Sidecar (Java 17)<br/>bpmscript.ScriptRunner"]
        Node -->|lang: 'js' (Nashorn style)| V8Sandbox["Node.js V8 Sandbox<br/>Engine JS-Compat Layer"]
        
        subgraph Sidecar["JVM Sidecar Capabilities"]
            J1["Real javac Compilation (Cached)"]
            J2["Typed Variable Bindings (BigDecimal, etc.)"]
            J3["Full Jackson ObjectMapper & ObjectNode"]
            J4["Standard JDK java.util Collections"]
            J5["bpmscript.KContext Binding"]
        end
        
        subgraph V8Sandbox["V8 Compatibility Shims"]
            S1["Jackson ObjectNode & ArrayNode Shims"]
            S2["java.util Collection Shims"]
            S3["kcontext & KieFunctions Shims"]
            S4["System.out & System.getenv Shims"]
        end
    end
```

1. **Native JVM Sidecar (`lang: "java"`)**:
   - Compiled with real `javac` (JDK 17) and cached per distinct script.
   - Executes with real Java classes, true static typing, and high throughput.
   - Bound with `bpmscript.KContext`, matching `org.kie.api.runtime.process.ProcessContext`.
2. **Compatibility V8 Sandbox (`lang: "js"` with Java interop)**:
   - For imported legacy scripts that used Nashorn or GraalVM `Java.type(...)` syntax.
   - Runs in isolated V8 with non-enumerable prototype shims and object wrappers.

---

## 2. The `kcontext` API & Sub-Method Catalog

In every Java script task, on-entry script, on-exit script, and condition expression, the engine pre-binds `kcontext` (`org.kie.api.runtime.process.ProcessContext` parity).

### 2.1 Root `kcontext` Methods

| Method Signature | Return Type | Description |
|---|---|---|
| `kcontext.getVariable(String name)` | `Object` | Retrieves a process variable value. Automatically coerces to declared numeric types (including `BigDecimal`). |
| `kcontext.setVariable(String name, Object value)` | `void` | Writes or updates a process variable. Automatically unwraps `JsonNode` to plain JSON-serializable values. |
| `kcontext.getProcessInstance()` | `ProcessInstance` | Returns the process instance handle for metadata and self-signals. |
| `kcontext.getNodeInstance()` | `NodeInstance` | Returns the current active node instance metadata. |
| `kcontext.getKieRuntime()` | `KieRuntime` | Returns the runtime execution handle for environment and broadcast signals. |

```java
// Example: Reading and writing process variables in Java
String caseId = (String) kcontext.getVariable("caseId");
kcontext.setVariable("status", "VALIDATED");
```

---

### 2.2 `ProcessInstance` Interface (`kcontext.getProcessInstance()`)

Represents the executing process instance:

| Method Signature | Return Type | Description |
|---|---|---|
| `.getId()` | `String` | Returns the unique process instance ID (PIID). |
| `.getProcessId()` | `String` | Returns the process definition ID (e.g. `"claims-adjudication"`). |
| `.getProcessName()` | `String` | Returns the human-readable display name of the process. |
| `.getCorrelationKey()` | `String` | Returns the business correlation key (e.g. Policy #, Order ID). |
| `.getParentProcessInstanceId()` | `String` | Returns parent PIID if inside a Subprocess or Call Activity; `null` otherwise. |
| `.getState()` | `int` | Returns process state constant (`STATE_ACTIVE`, `STATE_COMPLETED`, etc.). |
| `.getVariables()` | `Map<String, Object>` | Returns the live map of all process variables. |
| `.getNodeInstances()` | `List<NodeInstance>` | Returns snapshot of currently active node instances and tokens. |
| `.signalEvent(String type, Object event)` | `void` | Delivers an event signal specifically to **THIS** process instance. |

#### Process State Constants:
```java
ProcessInstance.STATE_PENDING   = 0;
ProcessInstance.STATE_ACTIVE    = 1;
ProcessInstance.STATE_COMPLETED = 2;
ProcessInstance.STATE_ABORTED   = 3;
ProcessInstance.STATE_SUSPENDED = 4;
```

```java
// Example: Checking state and signaling self
if (kcontext.getProcessInstance().getState() == 1) {
    kcontext.getProcessInstance().signalEvent("PAYMENT_CONFIRMED", "TX-8921");
}
```

---

### 2.3 `NodeInstance` Interface (`kcontext.getNodeInstance()`)

Represents the active node token currently executing:

| Method Signature | Return Type | Description |
|---|---|---|
| `.getId()` | `String` | Returns the unique node execution token ID. |
| `.getNodeId()` | `String` | Returns the node definition ID configured on the canvas. |
| `.getNodeName()` | `String` | Returns the human-readable label of the node. |

```java
// Example: Auditing node execution
System.out.println("Executing node " + kcontext.getNodeInstance().getNodeName() 
    + " [" + kcontext.getNodeInstance().getNodeId() + "]");
```

---

### 2.4 `KieRuntime` Interface (`kcontext.getKieRuntime()`)

Engine session runtime handle for cross-instance coordination:

| Method Signature | Return Type | Description |
|---|---|---|
| `.getEnvironment()` | `Environment` | Returns environment dictionary (`.get(String key)`). |
| `.signalEvent(String type, Object event)` | `void` | Session-wide broadcast: delivers event to **all** listening instances. |
| `.signalEvent(String type, Object event, String processInstanceId)` | `void` | Targeted delivery: delivers signal to a specific process instance ID. |
| `.abortProcessInstance(String processInstanceId)` | `void` | Terminates and aborts a process instance by ID. |

```java
// Example: Targeted signal delivery and instance abort
String targetId = (String) kcontext.getVariable("childInstanceId");
kcontext.getKieRuntime().signalEvent("APPROVE_CLAIM", true, targetId);

if (kcontext.getVariable("isFraudulent") == Boolean.TRUE) {
    kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId());
}
```

---

## 3. Declared Process Variables & Type Coercion

In Java script nodes and conditions, all declared process variables are bound automatically as bare typed local identifiers:

| Declared `structureRef` | Bound Java Type | Coercion Behavior |
|---|---|---|
| `String` | `java.lang.String` | String value |
| `Integer` / `java.lang.Integer` | `java.lang.Integer` | Number coerced to 32-bit Integer |
| `Long` / `java.lang.Long` | `java.lang.Long` | Number coerced to 64-bit Long |
| `Double` / `Float` | `java.lang.Double` / `Float` | Floating point number |
| `Boolean` | `java.lang.Boolean` | `Boolean.TRUE` or `Boolean.FALSE` |
| `BigDecimal` / `java.math.BigDecimal` | `java.math.BigDecimal` | Unwrapped from String/Double to precise `BigDecimal` |
| `BigInteger` / `java.math.BigInteger` | `java.math.BigInteger` | Unwrapped to `BigInteger` |
| `Object` / `java.lang.Object` | `com.fasterxml.jackson.databind.JsonNode` | Parsed JSON tree |
| `List` / `java.util.List` | `java.util.List` | Java List collection |
| `Map` / `java.util.Map` | `java.util.Map` | Java Map dictionary |

```java
// Example: Using bare declared variables directly without kcontext.getVariable()
if (claimAmount.compareTo(new java.math.BigDecimal("50000.00")) > 0) {
    approvalRequired = Boolean.TRUE;
    reviewTier = "SENIOR_UNDERWRITER";
}
```

---

## 4. Jackson Tree API (`com.fasterxml.jackson.databind`)

Standard library for JSON construction, safe navigation, and serialization in imported Java scripts:

### 4.1 `ObjectMapper`
```java
com.fasterxml.jackson.databind.ObjectMapper mapper = 
    new com.fasterxml.jackson.databind.ObjectMapper();

// 1. Create an empty ObjectNode
com.fasterxml.jackson.databind.node.ObjectNode root = mapper.createObjectNode();

// 2. Create an empty ArrayNode
com.fasterxml.jackson.databind.node.ArrayNode list = mapper.createArrayNode();

// 3. Parse JSON string into JsonNode / ObjectNode
com.fasterxml.jackson.databind.JsonNode parsed = mapper.readTree(resPayload);

// 4. Serialize ObjectNode / Java Object to JSON string
String jsonText = mapper.writeValueAsString(root);
```

### 4.2 `ObjectNode` Methods
- `.put(String fieldName, String value)`
- `.put(String fieldName, int/long/double value)`
- `.put(String fieldName, boolean value)`
- `.putPOJO(String fieldName, Object pojo)`
- `.putNull(String fieldName)`
- `.putArray(String fieldName)` — creates and attaches a new child `ArrayNode`
- `.set(String fieldName, JsonNode node)`
- `.get(String fieldName)` — returns child `JsonNode` (or `null`)
- `.path(String fieldName)` — **safe chained navigation**: returns `MissingNode` instead of throwing `NullPointerException`
- `.has(String fieldName)` — returns `boolean`
- `.hasNonNull(String fieldName)` — returns `boolean`
- `.asText()` / `.asText(String defaultValue)`
- `.asBoolean()` / `.asBoolean(boolean defaultValue)`
- `.asInt()` / `.asInt(int defaultValue)`
- `.isNull()` — checks if node represents JSON `null`
- `.isMissingNode()` — checks if property was absent
- `.size()` — field count
- `.toString()` — outputs JSON string

### 4.3 Practical Jackson Pattern in Imported REST Tasks:
```java
// Building outgoing REST payload in on-entry script:
com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
com.fasterxml.jackson.databind.node.ObjectNode payload = mapper.createObjectNode();
payload.put("claimId", (String) kcontext.getVariable("claimId"));
payload.put("amount", ((Number) kcontext.getVariable("amount")).doubleValue());

com.fasterxml.jackson.databind.node.ArrayNode items = payload.putArray("treatments");
items.add("CONSULTATION").add("BLOOD_TEST");

kcontext.setVariable("reqPayload", payload.toString());

// Parsing response in on-exit script:
com.fasterxml.jackson.databind.JsonNode res = mapper.readTree((String) kcontext.getVariable("resPayload"));
String authCode = res.path("data").path("authorizationCode").asText("");
boolean approved = res.path("data").path("approved").asBoolean(false);

kcontext.setVariable("authCode", authCode);
kcontext.setVariable("status", approved ? "CONFIRMED" : "REJECTED");
```

---

## 5. Java Collections (`java.util.*`)

Fully supported in both the JVM sidecar and the V8 JS-compat shim:

### 5.1 `java.util.ArrayList` / `LinkedList`
```java
java.util.List<String> list = new java.util.ArrayList<String>();
list.add("First");
list.add("Second");

int count = list.size();
String firstItem = list.get(0);
boolean containsItem = list.contains("First");
list.remove(0);
list.clear();
```

### 5.2 `java.util.HashMap` / `LinkedHashMap`
```java
java.util.Map<String, Object> map = new java.util.HashMap<String, Object>();
map.put("key1", "val1");
map.put("key2", 100);

Object val = map.get("key1");
boolean hasKey = map.containsKey("key1");
java.util.Set<String> keys = map.keySet();
java.util.Collection<Object> values = map.values();
int mapSize = map.size();
```

### 5.3 `java.util.HashSet` / `LinkedHashSet`
```java
java.util.Set<String> tags = new java.util.HashSet<String>();
tags.add("VIP");
tags.add("PRIORITY");

boolean isVip = tags.contains("VIP");
tags.remove("PRIORITY");
```

---

## 6. `org.json` Library Compatibility

Supported for legacy processes using `org.json` constructs:

```java
org.json.JSONObject obj = new org.json.JSONObject();
obj.put("policyNumber", "POL-9921");
obj.put("active", true);
obj.put("premium", 450.75);

String policyNum = obj.getString("policyNumber");
boolean isActive = obj.optBoolean("active", false);
String jsonOutput = obj.toString();
```

---

## 7. System Calls & Environment Variables

| Call | Behavior |
|---|---|
| `System.out.println(...)` | Appends message directly into the workflow execution audit log timeline. |
| `System.out.print(...)` | Appends message into execution audit log. |
| `System.getenv(String name)` | Reads an environment variable from the host execution environment. |
| `System.getProperty(String key)`| Reads a system property or tenant configuration setting. |
| `System.currentTimeMillis()` | Returns current epoch timestamp in milliseconds (`long`). |

```java
// Example: Logging execution progress
System.out.println("Processing claim for correlation key: " + kcontext.getProcessInstance().getCorrelationKey());
String integrationUrl = System.getProperty("INTEGRATION_URL");
if (integrationUrl == null || integrationUrl.isEmpty()) {
    integrationUrl = "https://api.internal";
}
kcontext.setVariable("serviceUrl", integrationUrl);
```

---

## 8. Primitive Wrappers & Boxed Types

All standard boxed primitive utilities are available:
- `Integer.valueOf(int/String)` / `Integer.parseInt(String)`
- `Long.valueOf(long/String)` / `Long.parseLong(String)`
- `Double.valueOf(double/String)` / `Double.parseDouble(String)`
- `Float.valueOf(float/String)` / `Float.parseFloat(String)`
- `Boolean.valueOf(boolean/String)` / `Boolean.TRUE` / `Boolean.FALSE`
- `String.valueOf(Object o)`

---

## 9. Gateway Condition Syntax in Java

Conditions on sequence flows exiting Exclusive or Inclusive gateways must evaluate to a `boolean`:

```java
// Single-expression condition:
return ((java.math.BigDecimal) kcontext.getVariable("claimAmount")).compareTo(new java.math.BigDecimal("10000.00")) > 0;

// Or using bare declared variables:
return amount > 5000 && "APPROVED".equals(status);
```

---

## 10. Security & Execution Boundaries

To preserve stability and isolation within the workflow engine:
1. **No Multithreading**: Spawning threads (`new Thread(...)`, `ExecutorService`) is prohibited and blocked at publish validation.
2. **Deterministic Execution**: Avoid non-durable blocking I/O (e.g. `Thread.sleep`); use BPMN Timer Intermediate Catch events or Timer Boundary events instead.
3. **HTTP REST Calls**: Perform external network operations using standard Service Tasks (`service`) rather than arbitrary socket calls inside script nodes.
