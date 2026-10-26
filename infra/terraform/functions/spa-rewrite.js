// CloudFront Function（cloudfront-js-2.0，viewer request），只掛在 S3 的 behavior。
// 前端是單頁應用：/watches/123 這類網址在 S3 沒有檔案，改成回 index.html 讓 React 接手；
// 最後一段有副檔名的（/assets/x.js、/favicon.svg）是真的檔案，原樣交給 S3。
function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.split("/").pop();
  if (lastSegment.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
