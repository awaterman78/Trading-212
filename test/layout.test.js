import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile first document has viewport, card layout and no forced portfolio table", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /width=device-width/);
  assert.match(html, /holdings-list/);
  assert.doesNotMatch(html, /<table/i);
  assert.match(css, /grid-template-columns:\s*repeat\(5,\s*1fr\)/);
  assert.match(css, /@media \(min-width: 720px\)/);
});
