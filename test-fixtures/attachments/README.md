# `test-fixtures/attachments/` — shared attachment-saving test fixtures

Repo-level fixtures for the receiving side of attachments: `saveAttachments`
in `client-sdk/typescript` and `save_attachments` in `client-sdk/python`.
Both suites read the same files, so the two helpers name and decode a
reply's files the same way.

| File                  | What                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `save-names.json`     | Untrusted name in → safe name out. `position` (default 1) is the attachment's 1-based place in the input, used by the `attachment-<n>` fallback. |
| `base64-content.json` | Strict RFC 4648 §4 base64 (§5.2 of the protocol): `valid` and, for valid rows, the decoded bytes as `hex`. Invalid content is never written. |

The expected values are spelled out per row, never computed by either SDK.
The files are ASCII: non-ASCII characters are `\u` escapes, including a lone
surrogate (`\ud800`), which both JSON parsers keep as one.
