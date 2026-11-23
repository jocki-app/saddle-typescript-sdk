import { expect, it } from "vitest";
import * as A from "@automerge/automerge";
import {
  rewriteHistory,
  type RewriteShape,
} from "../src/units/history-rewrite";
const token = "12345678-1234-1234-1234-123456789012";
type Note = { text: string; tags: string[]; metadata: Record<string, string> };
const shape: RewriteShape<Note> = {
  created: "File created",
  empty: () => ({ text: "", tags: [], metadata: {} }),
  envelope: (value) => value,
};
it("drops a middle edit, replaying later text and metadata edits without restoring the dropped delta", () => {
  let doc = A.from<Note>({
    text: "hello",
    tags: ["one"],
    metadata: { owner: "old" },
  });
  doc = A.change(doc, { message: "Remove me", time: 1 }, (d) => {
    A.updateText(d, ["text"], "hello!");
    d.tags.push("removed");
    d.metadata.owner = "removed";
  });
  const hash = A.getHeads(doc)[0];
  doc = A.change(doc, { message: "Keep me", time: 2 }, (d) => {
    A.updateText(d, ["text"], "hello! world");
    d.tags.push("kept");
    d.metadata.note = "kept";
  });
  const result = rewriteHistory(doc, { kind: "drop", hash }, token, shape);
  expect(A.toJS(result)).toEqual({
    text: "hello world",
    tags: ["one", "kept"],
    metadata: { owner: "old", note: "kept" },
  });
  expect(A.getAllChanges(result)).toHaveLength(2);
  expect(A.getHistory(result).at(-1)!.change.message).toBe("Keep me");
  expect(
    A.getHeads(rewriteHistory(doc, { kind: "drop", hash }, token, shape)),
  ).toEqual(A.getHeads(result));
});
it("reset keeps current contents as one creation version", () => {
  let doc = A.from<Note>({ text: "first", tags: [], metadata: {} });
  doc = A.change(doc, (d) => {
    d.text = "saved";
  });
  const result = rewriteHistory(
    doc,
    { kind: "reset", time: 100 },
    token,
    shape,
  );
  expect(A.toJS(result)).toEqual(A.toJS(doc));
  expect(A.getAllChanges(result)).toHaveLength(1);
  expect(A.getHistory(result)[0].change).toMatchObject({
    message: "File created",
    time: 100,
  });
});
it("keeps later named no-op versions and leaves the original document untouched", () => {
  let doc = A.from<Note>({ text: "first", tags: [], metadata: {} });
  doc = A.change(doc, (d) => {
    d.text = "removed";
  });
  const hash = A.getHeads(doc)[0];
  doc = A.emptyChange(doc, { message: "Named milestone", time: 2 });
  const result = rewriteHistory(doc, { kind: "drop", hash }, token, shape);
  expect(result.text).toBe("first");
  expect(A.getAllChanges(result)).toHaveLength(2);
  expect(doc.text).toBe("removed");
});
