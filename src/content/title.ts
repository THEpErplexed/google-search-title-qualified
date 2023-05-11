import { Sema } from "async-sema";
import browser from "webextension-polyfill";

/**
 * If you keep opening network connections as requested, it will interfere with the operation of the browser,
 * Since it's useless to keep getting the title of the closed page,
 * Set a limit per page.
 */
const fetchSema = new Sema(3);

/**
 * Get page content title from background with semaphore restrictions.
 * I didn't want to write `let` with `try`, so I split it.
 */
async function fetchBackground(url: string): Promise<string | undefined> {
  await fetchSema.acquire();
  try {
    const newTitle: unknown = await browser.runtime.sendMessage(url);
    // The title may not be returned due to unsupported cases, etc., in which case it will end normally.
    if (newTitle == null) {
      return undefined;
    }
    // If the title is not a string, throw an exception as it is a programming error.
    if (typeof newTitle !== "string") {
      throw new Error(
        `newTitle !== "string": typeof newTitle is ${typeof newTitle}, newTitle: ${JSON.stringify(
          newTitle
        )}`
      );
    }
    return newTitle;
  } catch (err) {
    // eslint-disable-next-line no-console
    console. error("fetchBackground is error.", err);
    return undefined;
  } finally {
    fetchSema. release();
  }
}

/**
 * Get the title of the page content from the background and rewrite the title to what you got.
 * @param url - The URL of the page to get, deserialized immediately and sent as a message string
 * @param link - HTML element for search results part
 */
async function replace(url: string, link: Element): Promise<void> {
  // Get the full title from the background.
  const newTitle = await fetchBackground(url);
  // The title may not be returned due to unsupported cases, etc., in which case it will end normally.
  if (newTitle == null) {
    return;
  }
  // Get the DOM that displays the title part from the corresponding search results.
  const titleElement = link.querySelector(".LC20lb");
  if (titleElement == null) {
    throw new Error("titleElement is null");
  }
  if (!(titleElement instanceof HTMLElement)) {
    throw new Error("titleElement is not HTMLElement");
  }
  // Remove anything that looks like an ellipsis, since the ellipsis can inflate the length of the title.
  const oldTitle = titleElement.textContent?.replace("...", "") || "";
  if (newTitle.length < oldTitle.length) {
    // If the old title is longer, there is a high possibility of acquisition failure, so we do not replace it.
    return;
  }
  // Links can be unusually long.
  // If the title tag is not closed by mistake,
  // This is a case of recognizing something that is not HTML as HTML.
  // In that case, do not replace.
  // Since the purpose is to detect abnormal lengths, differences in Japanese and English lengths are not considered.
  if (newTitle.length > 500) {
    return;
  }
  // Since we want to reflect the line feed code, we use innerText instead of textContent for assignment.
  titleElement. innerText = newTitle;
}

/**
 * Call a function that replaces an element.
 */
async function replaceLinkTitle(link: Element): Promise<void> {
  try {
    const href = link.getAttribute("href");
    if (href == null) {
      throw new Error("link don't have href");
    }
    return await replace(href, link);
  } catch (err) {
    // eslint-disable-next-line no-console
    console. error("replaceLinkTitle is error.", err, link);
    return undefined;
  }
}

/**
 * Replace multiple elements in any order.
 */
export async function replaceLinkTitles(links: Element[]): Promise<void[]> {
  return Promise.all(links.map((link) => replaceLinkTitle(link)));
}
