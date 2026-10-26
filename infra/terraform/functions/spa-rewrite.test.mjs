// CloudFront Function 的單元測試：node --test infra/terraform/functions/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// CloudFront Functions 只有頂層的 handler，沒有 export；讀文字後取出 handler
const code = readFileSync(new URL("./spa-rewrite.js", import.meta.url), "utf8");
const handler = new Function(`${code}\nreturn handler;`)();

function run(uri, querystring = {}) {
  return handler({ request: { uri, querystring, headers: {} } });
}

for (const uri of [
  "/",
  "/login",
  "/watches/123",
  "/watches/00000000-0000-0000-0000-000000000001/edit",
]) {
  test(`前端頁面 ${uri} 改成 /index.html`, () => {
    assert.equal(run(uri).uri, "/index.html");
  });
}

for (const uri of ["/assets/index-abc123.js", "/favicon.svg", "/index.html"]) {
  test(`檔案 ${uri} 不改寫`, () => {
    assert.equal(run(uri).uri, uri);
  });
}

test("querystring 原樣保留", () => {
  const qs = { next: { value: "/watches/1" } };
  assert.deepEqual(run("/login", qs).querystring, qs);
});
