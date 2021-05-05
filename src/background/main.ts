import { browser } from "webextension-polyfill-ts";

/**
 * 雑に文字コード推定を行います。
 * 本当はブラウザの自動判定機能が使いたいです、誰か方法を教えてください。
 */
function detectIsUtf8(response: Response, d: Document): boolean {
  const re = /UTF[-_]8/i;
  return (
    // HTTP header
    re.test(response.headers.get("content-type") || "") ||
    // HTML5
    re.test(d.querySelector("meta[charset]")?.getAttribute("charset") || "") ||
    // HTML4
    re.test(
      d
        .querySelector('meta[http-equiv="Content-Type"]')
        ?.getAttribute("content") || ""
    ) ||
    // charsetが存在しない場合、規格上UTF-8になりますが、規格を守ってるサイトも多いと思うので、安全側に倒してfalseをfallbackにします。
    false
  );
}

/** バックグラウンドプロセス全体のメッセージパッシングを受け取ります */
async function listener(message: unknown): Promise<string | undefined> {
  // メッセージ内容がおかしい場合はエラー
  if (typeof message !== "string") {
    throw new Error(`message is not URL: ${JSON.stringify(message)}`);
  }
  // PDFは読み込まない
  if (message.endsWith(".pdf")) {
    return undefined;
  }
  const response = await fetch(message, {
    // 妙なリクエストを送らないように制限を加えます(こちらで書かないと変なこと起きないと思いますが)
    mode: "no-cors",
    // 認証情報が不用意に送られないようにします。サイトの誤動作防止の意味が強い。
    credentials: "omit",
    // 出来るだけブラウザのキャッシュを使っていきます
    cache: "force-cache",
    // リダイレクトを追うことを明示的に指定
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`response is not ok ${JSON.stringify(response)}`);
  }
  // htmlを直接要求できないのでtextで取得してDOMParserに送り込みます
  const text = await response.text();
  const dom = new DOMParser().parseFromString(text, "text/html");
  // UTF-8でない場合取得を諦める
  if (detectIsUtf8(response, dom)) {
    return dom.querySelector("title")?.textContent || undefined;
  }
  return undefined;
}

browser.runtime.onMessage.addListener(listener);
