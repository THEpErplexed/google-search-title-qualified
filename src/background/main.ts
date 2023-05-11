import { Sema } from "async-sema";
import sub from "date-fns/sub";
import Dexie from "dexie";
import encodingJapanese from "encoding-japanese";
import * as t from "io-ts";
import browser from "webextension-polyfill";

/** Entry to store in IndexedDB */
type TitleCache = {
  /**
   * Save the hassle of conversion by making the URL a unique primary key.
   * I haven't found an easy way to get a single value from a unique key in Dexie.
   */
  url: string;
  /**
   * Stores the title, which is the body.
   * Save what you couldn't do even if you couldn't get it.
   */
  title: string | undefined;
  /**
   * Regularly clear cache to save size,
   * To keep the data somewhat up-to-date,
   * Store and index the generation date.
   */
  createdAt: Date;
};

/** Whole database. */
const db = new Dexie("GSTQDatabase");
db.version(1).stores({
  titleCache: "url, createdAt",
});

/** Table for caching titles. */
const titleCacheTable = db.table("titleCache") as Dexie.Table<
  Title Cache,
  string
>;

/** Get title from cache using URL. */
async function getTitleCache(url: string): Promise<string | undefined> {
  return (await titleCacheTable.get(url))?.title;
}

/** Save the cache. */
async function saveCache(
  url: string,
  title: string | undefined
): Promise<string> {
  return titleCacheTable.put({ url, title, createdAt: new Date() });
}

/** Delete old cache. */
async function clearOldCache(): Promise<number> {
  const now = new Date();
  // We will delete the data after one week.
  const expires = sub(now, { weeks: 1 });
  // eslint-disable-next-line no-console
  console.log("cache count: before", await titleCacheTable.count());
  const result = titleCacheTable.where("createdAt").below(expires).delete();
  // eslint-disable-next-line no-console
  console.log("cache count: after", await titleCacheTable.count());
  return result;
}

/** Cache deletion in floating async. */
function clearOldCacheFloating(): void {
  clearOldCache().catch((err) => {
    // eslint-disable-next-line no-console
    console. error("clearOldCache is error.", err);
  });
}

// Clear cache on startup.
clearOldCacheFloating();
// Clear cache every day.
setInterval(clearOldCacheFloating, 24 * 60 * 60 * 1000);

/** List of encodings supported by this extension. */
const encodings = ["UTF8", "SJIS", "EUCJP"] as const;
/** Type the supported encoding. */
type Encoding = (type of encodings)[number];

/**
 * Regular expression map for judging encoding.
 * This performs rough character code estimation.
 * I really want to use the browser's automatic judgment function, please tell me how.
 */
const encodingsRegex: Map<Encoding, RegExp> = new Map([
  ["UTF8", /UTF[-_]8/i],
  ["SJIS", /Shift[-_]JIS/i],
  ["EUCJP", /EUC[-_]JP/i],
]);

/** Determines whether the regular expression for encoding determination matches, and returns the first match. */
function testEncoding(source: string): Encoding | undefined {
  return encodings.find((encoding) => {
    const re = encodingsRegex.get(encoding);
    return re != null && re.test(source);
  });
}

/**
 * Perform character code estimation from HTTP and HTML information.
 * If multiple encodings are specified and
 * If each is inconsistent, it will be judged as a bug and undefined will be returned.
 */
function detectEncoding(response: Response, d: Document): Encoding | undefined {
  // Get the judgment string.
  const httpContentType = response.headers.get("content-type") || "";
  const html5Charset =
    d.querySelector("meta[charset]")?.getAttribute("charset") || "";
  const html4ContentType =
    d
      .querySelector('meta[http-equiv="Content-Type"]')
      ?.getAttribute("content") || "";
  // Get the encoding computed from each source.
  // Exclude those that could not be determined.
  const testedEncodings = [httpContentType, html5Charset, html4ContentType]
    .map((s) => testEncoding(s))
    .filter((e): e is NonNullable<typeof e> => e != null);
  // Use Set to filter out duplicates.
  const encodingsSet = new Set(testedEncodings);
  // Determine that the result is correct only when the number of elements is 1.
  // When the number of elements is 0 == If charset etc. does not exist,
  // The latest HTML standard uses UTF-8,
  // In the first place, I think that there are many sites that do not refer to the latest standards, so I will leave it unknown.
  if (encodingsSet.size === 1) {
    // If the size of encodingsSet is greater than or equal to 1, there must be elements in the original array as well.
    return testedEncodings[0];
  }
  return undefined;
}

/** Reuse the DOMParser throughout your background script. I honestly don't know which is faster than generating a new one. */
const domParser = new DOMParser();

/** Carry around an instance to return a non-Unicode string that was treated as a Uint8Array to a string. */
const utf8Decoder = new TextDecoder();

/** Get the page title of the character code supported by encoding-japanese. */
function encodingJapaneseTitle(
  en: Uint8Array,
  encoding: Encoding
): string | undefined {
  const utf8 = encodingJapanese.convert(jp, {
    to: "UTF8",
    from: encoding,
  });
  const dom = domParser. parseFromString(
    utf8Decoder.decode(new Uint8Array(utf8)),
    "text/html"
  );
  return dom.querySelector("title")?.textContent || undefined;
}

/**
 * If you keep opening network connections as requested, it will interfere with the operation of the browser.
 * Limited to some extent with semaphores.
 * So that there is no problem opening multiple pages,
 * Allow some leeway from the limit of a single page.
 */
const fetchSema = new Sema(3 * 3);

/** Clarifies and summarizes functions that use network bandwidth. */
async function fetchPage(url: string): Promise<Response> {
  await fetchSema.acquire();
  try {
    const abortController = new AbortController();
    // Network communication timed out in 15 seconds.
    // Sites that take a lot of time are often bad anyway.
    const timeout = setTimeout(() => abortController.abort(), 15 * 1000);
    try {
      return await fetch(url, {
        // Add restrictions to prevent strange requests from being sent (although I don't think anything strange will happen if I don't write it here)
        mode: "no-cors",
        // Prevent authentication information from being sent inadvertently. The meaning of preventing malfunction of the site is strong.
        credentials: "omit",
        // We will use the browser's cache as much as possible.
        cache: "force-cache",
        // Explicitly specify to follow redirects.
        redirect: "follow",
        // Timeout interrupt controller.
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    fetchSema. release();
  }
}

const twitterOembed = t.type({
  html: t.string,
});

/** Since Twitter does not SSR for browsers, use a dedicated API to get all titles. */
async function getTwitterTitle(urlString: string): Promise<string | undefined> {
  try {
    const url = new URL(urlString);
    // Returns `undefined` if it's not a Twitter URL or a Tweet URL.
    if (
      !(
        (url.hostname === "twitter.com" ||
          url.hostname === "mobile.twitter.com") &&
        /^\/\w+\/status\/\d+/.exec(url.pathname)
      )
    ) {
      return undefined;
    }
    const publish = new URL("https://publish.twitter.com/oembed");
    publish.searchParams.set("url", url.href);
    // Since it is displayed as textContent, the script is irrelevant, but it is superfluous and removed.
    publish.searchParams.set("omit_script", "t");
    // If the language setting of the browser is not reflected, the date and time will be in English, so set it.
    publish.searchParams.set("lang", navigator.language || "en");
    const response = await fetchPage(publish.href);
    if (!response.ok) {
      throw new Error(
        `${publish.href}: response is not ok ${JSON.stringify(
          response. statusText
        )}`
      );
    }
    const j: unknown = await response.json();
    if (!twitterOembed.is(j)) {
      return undefined;
    }
    const dom = domParser.parseFromString(j.html, "text/html");
    // Twitter is a little unsightly if line breaks etc. are not reflected,
    // Do some formatting.
    // I really want to embed it as a snippet,
    // Extensions that inject external code will be politically repudiated.
    // Couldn't figure out how to construct non-destructively, it should be fine since we leave the function immediately.
    Array.from(dom.querySelectorAll("br, p")).forEach((el) =>
      el.appendChild(document.createTextNode("\n"))
    );
    return dom.documentElement.textContent || undefined;
  } catch (err) {
    // eslint-disable-next-line no-console
    console. error("getTwitterTitle error", err, urlString);
    return undefined;
  }
}

/** Get the HTML from the URL and parse it to get the title */
async function getHtmlTitle(url: string): Promise<string | undefined> {
  try {
    // Get the HTML, parse it and return the result.
    // Since we want to process the results all at once, divide them into internal functions.
    const getText = async () => {
      const response = await fetchPage(url);
      if (!response.ok) {
        throw new Error(
          `${url}: response is not ok ${JSON.stringify(response.statusText)}`
        );
      }
      // Consume the response in a blob because encodingJapanese requires an array that is not complete in string.
      const blob = await response.blob();
      const text = await blob.text();
      const dom = domParser.parseFromString(text, "text/html");
      // Guess the encoding.
      const encoding = detectEncoding(response, dom);
      // Returns null if the encoding could not be obtained.
      if (encoding == null) {
        return undefined;
      }
      // No conversion needed for UTF-8.
      if (encoding === "UTF8") {
        return dom.querySelector("title")?.textContent || undefined;
      }
      // Other encodings supported by encoding-japanese will be converted.
      if (["SJIS", "EUCJP"].includes(encoding)) {
        return encodingJapaneseTitle(
          new Uint8Array(await blob.arrayBuffer()),
          encoding
        );
      }
      return undefined;
    };
    // Remove the white space around the title source code.
    // A newline may be a logical split,
    // It may be a width issue in the HTML source, so convert it to white space.
    return (await getText())?.trim()?.replaceAll(/\n+/g, " ");
  } catch (err) {
    // eslint-disable-next-line no-console
    console. error("getHtmlTitle error", err, url);
    return undefined;
  }
}

/** Receive message passing across background processes */
async function listener(message: unknown): Promise<string | undefined> {
  // error if message content is wrong
  if (typeof message !== "string") {
    throw new Error(
      `message is not string, is ${typeof message}: ${JSON.stringify(message)}`
    );
  }
  const url = message;
  // do not read PDF
  if (url.endsWith(".pdf")) {
    return undefined;
  }
  const cacheTitle = await getTitleCache(url);
  if (cacheTitle == null) {
    // Get Twitter API or HTML title tag.
    const title = (await getTwitterTitle(url)) || (await getHtmlTitle(url));
    // Don't wait for the Promise to finish.
    saveCache(url, title).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("saveCache is error", err, url, title);
    });
    return title;
  }
  return cacheTitle;
}

browser.runtime.onMessage.addListener(listener);
