// saveAttachments — the receiving counterpart of normalizeAttachments.
//
// The name and base64 tables live in `test-fixtures/attachments/`, shared
// with the Python suite (`tests/test_save_attachments.py`), so both SDKs
// save a reply's files under the same names. The behaviour tests below
// (clashes, links, the limit, I/O errors) run against a real temp dir.

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES as EXPORTED_DEFAULT,
  saveAttachments as exportedSave,
} from "../../src/index.js";
import {
  DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES,
  safeAttachmentName,
  saveAttachments,
} from "../../src/prompt/save-attachments.js";

// Four `..`: `unit/` → `test/` → `typescript/` → `client-sdk/` → repo root.
const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../test-fixtures/attachments/", import.meta.url),
);

interface NameRow {
  readonly input: string;
  readonly expected: string;
  readonly position?: number;
  readonly note: string;
}

interface NamesFile {
  readonly max_name_bytes: number;
  readonly max_extension_chars: number;
  readonly names: ReadonlyArray<NameRow>;
}

interface Base64Row {
  readonly content: string;
  readonly valid: boolean;
  readonly hex?: string;
  readonly note: string;
}

const NAMES = JSON.parse(
  await readFile(join(FIXTURES_DIR, "save-names.json"), "utf8"),
) as NamesFile;
const BASE64 = JSON.parse(await readFile(join(FIXTURES_DIR, "base64-content.json"), "utf8")) as {
  readonly cases: ReadonlyArray<Base64Row>;
};

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agents-save-attachments-"));
});

afterEach(async () => {
  await chmod(tmp, 0o700).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

describe("safeAttachmentName — test-fixtures/attachments/save-names.json", () => {
  it("covers the fixture's limits", () => {
    expect(NAMES.max_name_bytes).toBe(200);
    expect(NAMES.max_extension_chars).toBe(16);
    expect(NAMES.names.length).toBeGreaterThanOrEqual(20);
  });

  it.each(NAMES.names.map((row) => [row.note, row] as const))("%s", (_note, row) => {
    const name = safeAttachmentName(row.input, row.position ?? 1);
    expect(name).toBe(row.expected);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(NAMES.max_name_bytes);
  });

  it("saves every fixture name under its expected name", async () => {
    for (const [i, row] of NAMES.names.entries()) {
      const dir = join(tmp, `row-${i}`);
      const position = row.position ?? 1;
      const inputs = [
        ...Array.from({ length: position - 1 }, (_, k) => ({ filename: "", content: "!" + k })),
        { filename: row.input, content: b64("x") },
      ];
      const result = await saveAttachments(inputs, dir);
      const entry = result[position - 1]!;
      expect(entry.filename).toBe(row.input);
      expect(entry.path).not.toBeNull();
      expect(basename(entry.path!)).toBe(row.expected);
      expect(await readdir(dir)).toEqual([row.expected]);
    }
  });
});

describe("saveAttachments — test-fixtures/attachments/base64-content.json", () => {
  it.each(BASE64.cases.map((row) => [JSON.stringify(row.content), row] as const))(
    "%s",
    async (_label, row) => {
      const [entry] = await saveAttachments([{ filename: "f.bin", content: row.content }], tmp);
      if (row.valid) {
        const expected = Buffer.from(row.hex!, "hex");
        expect(entry).toEqual({
          filename: "f.bin",
          sizeBytes: expected.length,
          path: join(tmp, "f.bin"),
        });
        expect(Buffer.compare(await readFile(entry!.path!), expected)).toBe(0);
      } else {
        expect(entry).toEqual({
          filename: "f.bin",
          sizeBytes: 0,
          path: null,
          skipped: "invalid_content",
        });
        expect(await readdir(tmp)).toEqual([]);
      }
    },
  );
});

describe("saveAttachments — behaviour", () => {
  it("is exported from the package root with a 64 MiB default", () => {
    expect(exportedSave).toBe(saveAttachments);
    expect(EXPORTED_DEFAULT).toBe(64 * 1024 * 1024);
    expect(DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES).toBe(EXPORTED_DEFAULT);
  });

  it("creates the directory recursively and returns absolute paths inside it", async () => {
    const dir = join(tmp, "a", "b", "c");
    const result = await saveAttachments([{ filename: "hello.txt", content: b64("hi") }], dir);
    expect(result).toEqual([{ filename: "hello.txt", sizeBytes: 2, path: join(dir, "hello.txt") }]);
    const path = result[0]!.path!;
    expect(isAbsolute(path)).toBe(true);
    expect(dirname(path)).toBe(dir);
    expect(await readFile(path, "utf8")).toBe("hi");
  });

  it("resolves a relative directory to an absolute path", async () => {
    const dir = relative(process.cwd(), join(tmp, "rel"));
    expect(isAbsolute(dir)).toBe(false);
    const [entry] = await saveAttachments([{ filename: "r.txt", content: b64("r") }], dir);
    expect(entry!.path).toBe(join(tmp, "rel", "r.txt"));
  });

  it("returns [] for no attachments and still creates the directory", async () => {
    const dir = join(tmp, "empty");
    expect(await saveAttachments([], dir)).toEqual([]);
    expect((await lstat(dir)).isDirectory()).toBe(true);
  });

  it("suffixes duplicate names: a.txt, a (2).txt, a (3).txt", async () => {
    const result = await saveAttachments(
      [
        { filename: "a.txt", content: b64("one") },
        { filename: "a.txt", content: b64("two") },
        { filename: "dir/a.txt", content: b64("three") },
        { filename: "README", content: b64("r1") },
        { filename: "README", content: b64("r2") },
      ],
      tmp,
    );
    expect(result.map((r) => basename(r.path!))).toEqual([
      "a.txt",
      "a (2).txt",
      "a (3).txt",
      "README",
      "README (2)",
    ]);
    expect(result.map((r) => r.filename)).toEqual([
      "a.txt",
      "a.txt",
      "dir/a.txt",
      "README",
      "README",
    ]);
    expect(await readFile(join(tmp, "a (2).txt"), "utf8")).toBe("two");
  });

  it("never overwrites a file already on disk", async () => {
    await writeFile(join(tmp, "a.txt"), "original");
    const [entry] = await saveAttachments([{ filename: "a.txt", content: b64("new") }], tmp);
    expect(entry!.path).toBe(join(tmp, "a (2).txt"));
    expect(await readFile(join(tmp, "a.txt"), "utf8")).toBe("original");
    expect(await readFile(entry!.path!, "utf8")).toBe("new");
  });

  it("never follows a symlink already on disk, live or dangling", async () => {
    const outside = join(tmp, "outside");
    await mkdir(outside);
    const target = join(outside, "target.txt");
    await writeFile(target, "original");
    const dangling = join(outside, "never-created.txt");
    const dir = join(tmp, "inbox");
    await mkdir(dir);
    await symlink(target, join(dir, "a.txt"));
    await symlink(dangling, join(dir, "b.txt"));

    const result = await saveAttachments(
      [
        { filename: "a.txt", content: b64("evil") },
        { filename: "b.txt", content: b64("evil") },
      ],
      dir,
    );
    expect(result.map((r) => basename(r.path!))).toEqual(["a (2).txt", "b (2).txt"]);
    expect(await readFile(target, "utf8")).toBe("original");
    await expect(lstat(dangling)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(dir, "a.txt"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, "b.txt"))).toBe(dangling);
  });

  it.skipIf(process.platform === "win32")(
    "creates files 0600 and the directories it makes 0700; an existing one keeps its mode",
    async () => {
      const mode = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;
      await chmod(tmp, 0o755);
      const dir = join(tmp, "a", "b");
      const result = await saveAttachments(
        [
          { filename: "f.txt", content: b64("f") },
          { filename: "f.txt", content: b64("g") },
        ],
        dir,
      );
      expect(await Promise.all(result.map((r) => mode(r.path!)))).toEqual([0o600, 0o600]);
      expect(await mode(join(tmp, "a"))).toBe(0o700);
      expect(await mode(dir)).toBe(0o700);
      expect(await mode(tmp)).toBe(0o755);

      const existing = join(tmp, "existing");
      await mkdir(existing);
      await chmod(existing, 0o755);
      const [entry] = await saveAttachments([{ filename: "e.txt", content: b64("e") }], existing);
      expect(await mode(entry!.path!)).toBe(0o600);
      expect(await mode(existing)).toBe(0o755);
    },
  );

  it("skips an attachment over the limit and still saves a later smaller one", async () => {
    const result = await saveAttachments(
      [
        { filename: "six.bin", content: b64("123456") },
        { filename: "five.bin", content: b64("12345") },
        { filename: "four.bin", content: b64("1234") },
      ],
      tmp,
      { maxTotalBytes: 10 },
    );
    expect(result).toEqual([
      { filename: "six.bin", sizeBytes: 6, path: join(tmp, "six.bin") },
      { filename: "five.bin", sizeBytes: 5, path: null, skipped: "over_limit" },
      { filename: "four.bin", sizeBytes: 4, path: join(tmp, "four.bin") },
    ]);
    expect((await readdir(tmp)).sort()).toEqual(["four.bin", "six.bin"]);
  });

  it("counts only written bytes; invalid content costs nothing", async () => {
    const result = await saveAttachments(
      [
        { filename: "bad.bin", content: "aGVsbG8" },
        { filename: "ok.bin", content: b64("12345") },
      ],
      tmp,
      { maxTotalBytes: 5 },
    );
    expect(result).toEqual([
      { filename: "bad.bin", sizeBytes: 0, path: null, skipped: "invalid_content" },
      { filename: "ok.bin", sizeBytes: 5, path: join(tmp, "ok.bin") },
    ]);
  });

  it("maxTotalBytes: 0 saves only empty files; Infinity disables the limit", async () => {
    const zero = await saveAttachments(
      [
        { filename: "empty", content: "" },
        { filename: "one", content: b64("1") },
      ],
      join(tmp, "zero"),
      { maxTotalBytes: 0 },
    );
    expect(zero.map((r) => r.skipped)).toEqual([undefined, "over_limit"]);
    const big = await saveAttachments(
      [{ filename: "big.bin", content: Buffer.alloc(1024).toString("base64") }],
      join(tmp, "big"),
      { maxTotalBytes: Infinity },
    );
    expect(big[0]!.sizeBytes).toBe(1024);
  });

  it("lists invalid content without writing it, in input order", async () => {
    const result = await saveAttachments(
      [
        { filename: "a.txt", content: b64("a") },
        { filename: "url-safe.txt", content: "aGVsbG8-" },
        // A JavaScript caller may pass anything.
        { filename: "not-a-string.txt", content: 1234 as unknown as string },
        { filename: "b.txt", content: b64("b") },
      ],
      tmp,
    );
    expect(result.map((r) => [r.filename, r.skipped ?? "saved"])).toEqual([
      ["a.txt", "saved"],
      ["url-safe.txt", "invalid_content"],
      ["not-a-string.txt", "invalid_content"],
      ["b.txt", "saved"],
    ]);
    expect((await readdir(tmp)).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("throws after 1000 names are taken", async () => {
    await writeFile(join(tmp, "x.txt"), "");
    for (let n = 2; n <= 1000; n++) await writeFile(join(tmp, `x (${n}).txt`), "");
    await expect(saveAttachments([{ filename: "x.txt", content: b64("x") }], tmp)).rejects.toThrow(
      /no free name for "x\.txt".*1000 attempts/,
    );
  });

  it("rejects a negative or NaN limit", async () => {
    await expect(saveAttachments([], tmp, { maxTotalBytes: -1 })).rejects.toThrow(RangeError);
    await expect(saveAttachments([], tmp, { maxTotalBytes: Number.NaN })).rejects.toThrow(
      RangeError,
    );
  });

  it("throws a real I/O error: the directory is a file", async () => {
    const file = join(tmp, "file");
    await writeFile(file, "");
    await expect(
      saveAttachments([{ filename: "a.txt", content: b64("a") }], file),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/) as unknown });
  });

  it.skipIf(process.getuid?.() === 0)(
    "throws a real I/O error: the directory is read-only",
    async () => {
      await chmod(tmp, 0o500);
      await expect(
        saveAttachments([{ filename: "a.txt", content: b64("a") }], tmp),
      ).rejects.toMatchObject({ code: "EACCES" });
    },
  );
});
