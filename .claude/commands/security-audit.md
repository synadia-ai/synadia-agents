# Full Security Audit

You are performing a comprehensive security audit of the codebase in the current working directory. Treat this with the rigor of a professional penetration test. Your job is to find real, exploitable vulnerabilities — not style issues.

## Execution Strategy

You MUST use subagents extensively to avoid context exhaustion. Findings are passed between phases via **files** (in `.security-audit/`), NOT via the main agent's context. The main agent only sees TL;DR summaries.

The audit has 5 phases:

1. **Planning** — Discover project structure, identify attack surface
2. **Deep Investigation** — Parallel subagents per security domain → write full findings to `.security-audit/findings/`
3. **Initial Report & Triage** — Synthesize TL;DR summaries, rank by severity → write triage index to `.security-audit/triage.md`
4. **Verification & Fix** — Parallel subagents read finding files, verify, write PoC tests and fixes → write to `.security-audit/findings/SEC-*-verified.md`
5. **Final Report** — Assemble from all files → write `SECURITY_AUDIT_REPORT.md`

After the report is written, clean up: `rm -rf .security-audit/` (the intermediate files are not meant to be committed).

---

## PHASE 1: PLANNING & DISCOVERY

Before spawning any investigation agents, you must understand what you're auditing. Do this yourself (do NOT delegate):

### Step 1: Discover the project
- Read `CLAUDE.md`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md` if they exist
- Read the primary manifest file(s): `Cargo.toml`, `package.json`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `CMakeLists.txt`, `Makefile`, etc.
- Run `ls` on the root and `src/` (or equivalent) to understand the directory layout
- Identify the **language(s)**, **framework(s)**, **build system**, and **project type** (library, server, CLI tool, web app, etc.)

### Step 2: Identify security-relevant areas
Based on what you discover, identify:
- **Trust boundaries**: Where does external input enter? (network, files, CLI args, environment variables, IPC, database, user input in web forms, API requests)
- **Attack surface**: Which modules handle untrusted data? (parsers, protocol handlers, auth, crypto, serialization/deserialization, file I/O, SQL/query builders, template rendering, HTTP handlers)
- **Threat actors**: Who could attack this? (remote unauthenticated, authenticated user, malicious peer/server, man-in-the-middle, local attacker, supply chain)
- **Security-critical files**: List the specific files/modules that handle auth, crypto, parsing, network I/O, input validation, and access control

### Step 3: Write your threat model
Write down:
1. Project summary (what it is, what language, what it does)
2. The trust boundaries you identified
3. The attack surface map (module → what untrusted input it handles)
4. The threat actors relevant to this project
5. Which of the 8 investigation domains below are applicable (skip domains that don't apply — e.g., skip "TLS & Crypto" for a pure CLI tool that doesn't do networking)

Then proceed to Phase 2, adapting the agent prompts based on your discovery.

---

## PHASE 2: DEEP INVESTIGATION

Before launching agents, create the output directory:
```
mkdir -p .security-audit/findings
```

Launch the applicable subagents **in parallel**. For each agent, you MUST customize the prompt based on what you learned in Phase 1 — replace the `[PLACEHOLDERS]` with actual file paths, module names, and project-specific details. Do not send generic prompts.

Each agent must be thorough — read every relevant file, trace data flows end-to-end, check edge cases.

### Output protocol for ALL Phase 2 agents

Each agent MUST:
1. **Write full findings to a file**: Write all findings (with full detail, reproduction examples, and code references) to `.security-audit/findings/[domain].md` — e.g., `.security-audit/findings/network-parser.md`, `.security-audit/findings/crypto.md`, etc.
2. **Return only a TL;DR summary**: The agent's return message to the main agent should contain ONLY a brief summary — one line per finding with severity, location, and title. No reproduction examples, no detailed descriptions. This keeps the main agent's context light.

Example file content (`.security-audit/findings/network-parser.md`):
```markdown
# Network Protocol & Parser Security Findings

## Finding 1: Unbounded allocation from attacker-controlled length field
- **Severity**: High
- **Location**: src/parser.rs:142
- **Description**: The `read_message` function allocates a buffer sized by the `content-length` header without checking bounds. A malicious peer can send a 4GB length value to OOM the process.
- **Exploitation**: Send a crafted message with `content-length: 4294967295` to trigger allocation.
- **Reproduction**:
  ```rust
  // Crafted input: a message frame with a huge content-length
  let malicious_frame = b"MSG foo 1 4294967295\r\n";
  let result = parser.parse(malicious_frame);
  // This will attempt to allocate ~4GB
  ```
- **Impact**: Denial of service (OOM kill)
```

Example return message to main agent:
```
Wrote 3 findings to .security-audit/findings/network-parser.md
- HIGH: Unbounded allocation from attacker-controlled length field (src/parser.rs:142)
- MEDIUM: Missing UTF-8 validation on subject field (src/parser.rs:87)
- LOW: Unchecked unwrap in error path (src/parser.rs:203)
```

**CRITICAL**: When writing each agent's prompt, prepend this context block (filled in from Phase 1):
```
PROJECT CONTEXT:
- Language: [language]
- Type: [library/server/CLI/web app/etc.]
- Key files for this domain: [list the specific files this agent should read]
- Trust boundaries relevant to this domain: [which boundaries apply]
- Output file: .security-audit/findings/[domain].md
```

### Agent 1: Network Protocol & Parser Security
*Skip if the project does no network I/O or protocol parsing.*

```
[PROJECT CONTEXT block]

Audit all network protocol parsing and serialization code for memory safety and correctness.

Focus areas:
- Buffer/stream handling — can a malicious peer send crafted input that causes:
  - Buffer overflows, unbounded allocation (OOM / DoS)
  - Integer overflow in length/size fields
  - Incomplete frame/message handling that corrupts parser state
- Message/frame parsing — for each message type the code can receive:
  - Malformed messages: missing delimiters, truncated data, extra fields
  - Oversized payloads: are size limits enforced?
  - Nested structure parsing: can malformed inner data cause panics?
  - Encoding issues: UTF-8 validation, charset handling
- Serialization/output:
  - Can user-controlled input inject protocol commands or escape framing? (e.g., CRLF injection in text protocols, length confusion in binary protocols)
  - Are outputs correctly delimited/length-prefixed?
- Language-specific:
  - [Rust] Look for unwrap(), expect(), panic!(), unreachable!() in parsing paths; unchecked `as usize` casts; unchecked arithmetic on network-derived sizes
  - [Go] Look for unchecked slice indexing, integer truncation, ignored error returns in I/O paths
  - [C/C++] Look for buffer overflows, format strings, integer overflows, use-after-free
  - [Python/JS/Java] Look for regex DoS, deserialization of untrusted data, type confusion

Discover which files handle protocol/network I/O by searching for: socket, connect, read, write, parse, decode, encode, serialize, deserialize, frame, packet, buffer, stream, recv, send

For each finding, include in the output file:
- Severity: Critical / High / Medium / Low / Info
- Location: file:line_number
- Description: What the issue is
- Exploitation: How an attacker could trigger it
- Reproduction: A concrete example that demonstrates the issue — this is MANDATORY for every finding rated Medium or above. Provide whichever is most appropriate:
  - A crafted malicious input (hex bytes, protocol message, JSON payload, etc.)
  - A code snippet showing the vulnerable call with attacker-controlled values
  - A curl/CLI command that triggers the issue
  - A minimal script/test case that demonstrates the behavior
  For Low/Info findings, a one-line description of how to trigger is acceptable.
- Impact: What happens (DoS, info leak, code execution, etc.)

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 2: TLS, Crypto & Secrets Management
*Skip if the project has no cryptographic operations or TLS.*

```
[PROJECT CONTEXT block]

Audit TLS configuration, cryptographic operations, and secrets handling.

Focus areas:
- TLS configuration:
  - Certificate validation: enabled by default? Can it be accidentally disabled?
  - TLS version constraints: are old versions (TLS 1.0, 1.1) allowed?
  - Cipher suite configuration: weak ciphers possible?
  - Hostname verification: performed? Bypassable?
  - Client certificate / mTLS: correctly validated?
- Cryptographic operations:
  - Key generation: sufficient entropy? Proper CSPRNG?
  - Signing/verification: correct algorithm usage? Signature malleability?
  - Encryption: proper IV/nonce handling? Authenticated encryption?
  - Hashing: appropriate algorithm for use case? (e.g., not MD5/SHA1 for security)
  - Comparison: constant-time comparisons for secrets/MACs/signatures?
  - Key derivation: proper KDF? Sufficient iterations?
- Secrets in memory:
  - Are private keys, passwords, tokens zeroized after use?
  - Are secrets logged? (check all logging/tracing calls)
  - Are secrets passed via command line? (visible in /proc)
  - Credential file handling: path traversal? Permission checks?
- Token/JWT handling:
  - Expiry checked? Audience/issuer validated?
  - Algorithm confusion attacks possible?
  - Token replay protections?

Discover relevant files by searching for: tls, ssl, certificate, crypto, encrypt, decrypt, sign, verify, hash, hmac, key, secret, password, token, jwt, credential, nonce, iv, salt, pbkdf, scrypt, argon

For each finding, include in the output file: Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: a code snippet showing the vulnerable configuration, a demonstration of the weak crypto operation, crafted input that exploits the issue, or a minimal script. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 3: Authentication & Authorization
*Skip if the project has no auth mechanisms.*

```
[PROJECT CONTEXT block]

Audit authentication and authorization mechanisms.

Focus areas:
- Authentication flows:
  - What auth methods are supported? (password, token, API key, OAuth, mTLS, SSO, etc.)
  - Are credentials transmitted securely?
  - Are credentials stored securely? (hashing, encryption at rest)
  - Session management: secure token generation? Expiry? Invalidation?
  - Multi-factor: is it bypassable?
  - Password reset: secure flow? Account enumeration?
- Credential lifecycle:
  - Are credentials zeroized from memory after use?
  - Are credentials ever logged? (search ALL log/print/debug statements)
  - Reconnection/retry: are stale credentials reused? Is there a window where connection is unauthenticated?
  - Credential refresh: race conditions in token refresh?
- Authorization:
  - Are access controls enforced server-side (not just client-side)?
  - Can authorization checks be bypassed? (IDOR, privilege escalation, path traversal)
  - Are permission errors handled correctly? (fail-open vs fail-closed)
  - Role/scope validation: is it consistent across all code paths?
- Session/state:
  - CSRF protections?
  - Session fixation?
  - Concurrent session handling?

Discover relevant files by searching for: auth, login, password, credential, token, session, permission, role, access, authorize, middleware, guard, policy, jwt, oauth, saml, api_key, bearer

For each finding, provide structured output with Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: a crafted request that bypasses auth, a code snippet showing the privilege escalation path, a curl command demonstrating the bypass, or a minimal script. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 4: Denial of Service Vectors
```
[PROJECT CONTEXT block]

Audit for denial-of-service vulnerabilities.

Focus areas:
- Memory exhaustion:
  - Unbounded collections: buffers, queues, caches, maps that grow without limit from external input
  - Large allocation from attacker-controlled size fields
  - Memory leaks: resources not freed on error paths
- CPU exhaustion:
  - Algorithmic complexity: O(n²) or worse on attacker-controlled input (hash collision, regex backtracking, sorting)
  - Regex: catastrophic backtracking on crafted input (search for all regex patterns)
  - Recursive parsing: stack overflow on deeply nested input (JSON, XML, ASN.1, etc.)
  - Retry storms: can a peer force tight retry loops without backoff?
- Resource exhaustion:
  - File descriptors: unbounded connections/file handles?
  - Disk: unbounded log/temp file growth from attacker input?
  - Threads/goroutines/tasks: can an attacker spawn unbounded concurrent work?
- Deadlocks and livelocks:
  - Lock ordering issues?
  - Channel/queue full: does it block forever or timeout?
  - Graceful shutdown: can it hang indefinitely?
- Slowloris-style:
  - Timeout enforcement: are there read/write/connection timeouts on all I/O?
  - Partial input: does the system handle slow/incomplete data?
  - Keep-alive abuse?

Discover relevant files by searching for: buffer, queue, cache, channel, timeout, retry, backoff, limit, capacity, pool, spawn, thread, goroutine, tokio::spawn, async, worker

For each finding, provide structured output with Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: a crafted payload that causes unbounded growth, a script showing resource exhaustion with specific input sizes, a code snippet demonstrating the tight loop or missing timeout. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 5: Input Validation & Injection
```
[PROJECT CONTEXT block]

Audit all input validation and injection attack surfaces.

Focus areas:
- Injection attacks (check ALL that apply to this codebase):
  - SQL injection: parameterized queries or string concatenation?
  - Command injection: shell execution with user input? (search for exec, system, popen, subprocess, child_process)
  - Path traversal: file operations with user-controlled paths? (../ sequences, symlink following, null bytes)
  - LDAP/NoSQL/XML/XPath injection
  - Template injection (SSTI)
  - Header injection: CRLF injection in HTTP headers, email headers, protocol frames
  - Log injection: can user input forge log entries?
- Cross-site scripting (XSS) — if web-facing:
  - Reflected, stored, DOM-based XSS
  - Content-Type sniffing
  - CSP headers
- Deserialization:
  - Is untrusted data deserialized? (pickle, yaml.load, Java ObjectInputStream, JSON with type hints, protobuf, msgpack)
  - Can deserialization trigger code execution or type confusion?
- Input validation consistency:
  - Is validation applied at the boundary or scattered throughout?
  - Are there code paths that skip validation?
  - Is validation consistent between different entry points for the same data?
  - Maximum size/length enforcement on all inputs?
- Output encoding:
  - Is output properly encoded for its context? (HTML, URL, JSON, SQL, shell)

Discover relevant files by searching for: validate, sanitize, escape, encode, decode, parse, input, query, exec, system, command, path, file, open, read_file, write_file, template, render, serialize, deserialize, marshal, unmarshal, from_str, from_bytes

For each finding, provide structured output with Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: the exact malicious input string, a curl/HTTP request with the injected payload, a code snippet showing unsanitized data reaching a sink, or a minimal script demonstrating the injection. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 6: Dependency & Supply Chain Security
```
[PROJECT CONTEXT block]

Audit dependencies for known vulnerabilities and supply chain risks.

Focus areas:
- Known vulnerabilities:
  - [Rust] Run: cargo audit (if available), review Cargo.lock
  - [Node] Run: npm audit or check package-lock.json
  - [Python] Run: pip audit or check requirements.txt / poetry.lock
  - [Go] Run: govulncheck or check go.sum
  - [Java] Check dependency versions against NVD
  - If audit tools aren't available, manually review key dependencies for known CVEs
- Dependency hygiene:
  - Are versions pinned? (lockfile present and committed?)
  - Are there dependencies with concerning permissions? (build scripts, native code, post-install hooks)
  - Are optional/dev dependencies properly separated?
  - Are there vendored dependencies? Are they up to date?
- Unsafe code review:
  - [Rust] Search for all `unsafe` blocks — is each one necessary? Sound? Documented?
  - [C/C++] Search for dangerous functions: strcpy, sprintf, gets, system, etc.
  - [Go] Search for `unsafe.Pointer`
- Build security:
  - Are there build scripts (build.rs, Makefile, setup.py)? What do they execute?
  - Could a compromised dependency execute arbitrary code at build time?
  - CI configuration: are secrets properly scoped? Are there dangerous permissions?
- License compliance:
  - Check license compatibility
  - Any copyleft licenses in a permissive-licensed project?

For each finding, provide structured output with Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: the specific vulnerable dependency version and CVE, the unsafe code block with an explanation of what memory safety it violates, or the build script command that executes untrusted input. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 7: Recent Git History Security Review
```
[PROJECT CONTEXT block]

Audit recent git history for security-relevant changes and leaked secrets.

Focus areas:
- Review recent commits: git log --oneline -50
  - For security-relevant commits (auth, crypto, parsing, validation, deps), run git show to review the full diff
  - Look for:
    - Security fixes that may be incomplete (partially fixed vuln)
    - Changes that weaken validation, remove checks, or relax error handling
    - New unsafe/dangerous code patterns introduced
    - Dependency updates that might introduce vulnerabilities
    - Changes to CI/CD that weaken security checks (removed linting, test skipping)
    - Reverted security changes
- Secrets in history:
  - Search recent diffs for: password, secret, key, token, credential, API_KEY, AWS_, PRIVATE, BEGIN RSA, BEGIN EC, BEGIN OPENSSH
  - Check .gitignore: does it exclude .env, *.pem, *.key, credentials.*, config/secrets.*?
  - Look for test credentials/keys that might be real (especially in config files, docker-compose, CI configs)
- Open PRs (if gh CLI available):
  - Run `gh pr list` to find open PRs
  - Review any that touch security-sensitive files

Use git commands to explore history. Use `gh` CLI for PR review if available.

For each finding, provide structured output with Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: the exact commit hash and diff showing the weakness, the leaked secret pattern found, or the specific PR change that weakens security. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

### Agent 8: Concurrency & Race Condition Analysis
*Skip if the project is single-threaded with no async/concurrent operations.*

```
[PROJECT CONTEXT block]

Audit for concurrency bugs that could have security implications.

Focus areas:
- Shared mutable state:
  - What state is shared across threads/tasks/goroutines?
  - Are there TOCTOU (time-of-check-time-of-use) bugs? (especially in file operations, permission checks, auth)
  - [Rust] Are Arc<Mutex<T>> patterns used correctly? Any lock poisoning issues?
  - [Go] Are there race conditions on shared maps, slices, or structs? (suggest running with -race flag)
  - [Python] GIL does not protect against logical races — check shared state in async code
  - [Java/C++] Check for data races on shared fields without proper synchronization
- Channel/queue safety:
  - Can messages be lost, duplicated, or reordered in a security-relevant way?
  - What happens when channels/queues are full? (deadlock? drop? block?)
  - What happens on channel close during active operations?
- State machine integrity:
  - Connection/session state machines: can concurrent events cause invalid state transitions?
  - Can auth state become inconsistent? (e.g., authenticated flag set before auth completes)
  - Reconnection/retry: can user operations race with reconnection logic?
- Callback/handler safety:
  - Can user callbacks deadlock the main loop?
  - Are callbacks invoked with locks held?
  - Can callbacks cause re-entrant calls?
- Shutdown races:
  - Can operations proceed after shutdown/drain/close starts?
  - Is cleanup idempotent?
  - Can drop/finalizer/destructor race with active operations?

Discover relevant files by searching for: mutex, lock, rwlock, atomic, sync, channel, mpsc, spawn, thread, goroutine, async, await, concurrent, parallel, Arc, Rc, RefCell, volatile, synchronized

For each finding, provide structured output with Severity, Location, Description, Exploitation, Reproduction, Impact.

Reproduction is MANDATORY for every finding rated Medium or above. Provide a concrete example: a sequence of concurrent operations that triggers the race, a code snippet showing the TOCTOU window, or a minimal multi-threaded test demonstrating the state corruption. For Low/Info findings, a one-line trigger description is acceptable.

Write all findings to the output file specified in PROJECT CONTEXT. Return only a TL;DR summary (one line per finding: severity, location, title).
```

---

## PHASE 3: INITIAL REPORT & TRIAGE

After ALL Phase 2 agents complete, work from the **TL;DR summaries they returned** — do NOT read the full finding files yourself (that would defeat the purpose of offloading to files).

1. **Deduplicate** — Multiple agents may report the same issue. Use the TL;DR lines to identify overlaps. Note which finding files contain duplicate entries.
2. **Classify** each unique finding:
   - **Severity**: Critical / High / Medium / Low / Informational
   - **Confidence**: Confirmed / Likely / Possible / Theoretical
   - **Category**: Memory Safety / Injection / DoS / Crypto / Auth / Race Condition / Supply Chain / Info Leak
3. **Rank** by severity × confidence (Critical+Confirmed first, Informational+Theoretical last)
4. **Filter**: Drop "Informational" findings with "Theoretical" confidence — they add noise, not signal
5. Assign each finding an ID: `SEC-001`, `SEC-002`, etc.
6. **Write the triage index** to `.security-audit/triage.md` — a table mapping each SEC-ID to its source file and finding number, severity, confidence, and title. This is what Phase 4 agents will reference.
7. Present the triage summary table to the user.

You do NOT need to carry reproduction examples in your context — they live in the finding files and Phase 4 agents will read them directly.

---

## PHASE 4: VERIFICATION & FIX PROPOSALS

For each finding rated **Medium or above** AND **Possible confidence or above**, launch a subagent. Batch them in groups of 4-6 if there are many.

Each agent gets a **lightweight prompt** — the detailed finding data lives in files, not in the prompt:

```
You are verifying a specific security finding and proposing a fix for a [LANGUAGE] project.

## Finding Reference
- ID: [SEC-NNN]
- Source file: [.security-audit/findings/DOMAIN.md], Finding #[N]
- Title: [TITLE] (one line from triage)
- Location: [FILE:LINE]

**Start by reading the full finding** from the source file above. It contains the description, exploitation scenario, and reproduction example from the investigation phase.

## Your Tasks

### 1. Verify
- Read the source code at the specified location
- Use the reproduction example from the finding file as your starting point — reason through or run it to confirm it triggers the issue
- Check if existing defenses already mitigate this
- Rate: Confirmed / Likely / Possible / False Positive

### 2. Write a PoC Test
Convert the reproduction example into a proper test:
- Place it in the project's existing test structure
- Name it: `test_security_[id]_[short_description]`
- The test should PASS when the vulnerability EXISTS (so it fails once fixed)
- Fallback hierarchy — use the first level that's feasible:
  1. **Unit test** in the project's test framework `[unit-test]`
  2. **Integration test** or standalone script `[integration-test]`
  3. **Detailed manual reproduction steps** with exact inputs and expected outputs `[manual-steps]`

### 3. Propose a Fix
- Minimal code change with before/after
- Correctness argument, compat and perf notes

### 4. Write Output
Write your results to `.security-audit/findings/[SEC-NNN]-verified.md` with:
- **Verified**: Yes / No / Partial — with explanation
- **Confidence Adjustment**: Same / Upgraded / Downgraded to [level] — why?
- **PoC Test**: [the test code or manual steps, marked with level]
- **Proposed Fix**: [the code change]
- **Fix Explanation**: [correctness, compat, perf]
- **Breaking Change**: Yes/No

Return only a one-line summary: `SEC-NNN: Verified/FalsePositive — [one sentence]`
```

---

## PHASE 5: FINAL REPORT

After Phase 4 completes, assemble the final report. Read the data you need from files:
- **Phase 2 findings**: `.security-audit/findings/[domain].md` — full descriptions, reproduction examples
- **Phase 3 triage**: `.security-audit/triage.md` — severity, confidence, IDs, ranking
- **Phase 4 verification**: `.security-audit/findings/SEC-*-verified.md` — PoC tests, fixes, verification status

Write the report to `SECURITY_AUDIT_REPORT.md` in the working directory. For large audits with many findings, use a subagent for report assembly to avoid context exhaustion.

Structure:

```markdown
# Security Audit Report

**Project**: [project name and brief description]
**Date**: [today's date]
**Scope**: Full codebase audit + last 50 commits
**Language**: [language(s)]
**Auditor**: Claude Code automated security audit

## Executive Summary
[2-4 sentences: overall security posture, key statistics, most critical recommendations]

## Threat Model
[Summarize the threat model from Phase 1: what the project is, trust boundaries, key threat actors]

## Findings Summary

| # | ID | Severity | Confidence | Category | Title | Location | Verified |
|---|----|----------|------------|----------|-------|----------|----------|
| 1 | SEC-001 | Critical | Confirmed | ... | ... | file:line | Yes |
| ...

## Detailed Findings

### SEC-001: [Title]

**Severity**: [Critical/High/Medium/Low]
**Confidence**: [Confirmed/Likely/Possible]
**Category**: [Category]
**Location**: `file_path:line_number`
**Verified**: [Yes/No/Partial]

#### Description
[What the vulnerability is]

#### Root Cause
[Why it exists — the specific code pattern or missing check]

#### Exploitation Scenario
[Step-by-step how an attacker would exploit this]

#### Reproduction Example
[Concrete, runnable reproduction — crafted input, curl command, code snippet, or minimal script. This must be specific enough that a developer can copy-paste it to see the issue.]

#### Impact
[What happens if exploited — DoS, info leak, auth bypass, RCE, etc.]

#### Proof of Concept `[unit-test|integration-test|manual-steps]`
```[language]
[Test code or reproduction steps from Phase 4 verification]
```

#### Proposed Fix
```[language]
[Code change]
```

#### Fix Explanation
[Why this fix is correct, performance considerations, backwards compatibility]

---

[Repeat for each finding, ordered by severity]

## Recommendations
[Prioritized action items, including any architectural concerns that aren't individual findings]

## Scope Limitations
[What was NOT checked, known blind spots, areas that need manual review]
[e.g., "Binary dependencies were not decompiled", "Integration test coverage of auth flows was not assessed", "Fuzz testing was not performed"]
```

---

## Important Guidelines

- **Be thorough but precise**: False positives waste maintainer time. If you're unsure, mark confidence as "Possible" — never inflate to "Confirmed" without evidence.
- **Language-aware analysis**: Understand what your language's type system / runtime prevents. Rust's borrow checker prevents use-after-free — don't report those. Go's GC prevents double-free — don't report those. Focus on what CAN go wrong in each language.
- **Real-world exploitability**: Prioritize findings that a real attacker could exploit over theoretical concerns about code style or "best practices". A confirmed Medium beats a theoretical Critical.
- **Every finding needs a reproduction example**: A vulnerability without a reproduction example is just an opinion. Phase 2 agents produce the initial example (they have the deepest code context) and write it to files. Phase 4 agents read those files and refine the example into a proper test. If Phase 4 is cut short, Phase 5 can still pull reproduction examples directly from Phase 2 finding files — nothing is lost.
- **Don't skip phases**: Even if Phase 2 finds nothing critical, still run Phase 4 verification on Medium findings — initial analysis might have missed mitigating context.
- **Adapt to the project**: Not every domain applies to every project. A pure computation library won't have auth issues. A CLI tool won't have XSS. Skip irrelevant agents but document what you skipped and why in the final report.
- **Check cross-language equivalents**: If NATS MCP tools are available, use `find_equivalent` to check how other implementations of the same protocol handle the same security concern — this reveals whether an issue is protocol-level or implementation-specific.
