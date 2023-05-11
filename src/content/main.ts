import { replaceLinkTitles } from "./title";

/**
 * Even if you are careful with CSS selectors, unnecessary URLs such as Google's web cache will inevitably gather, so filter them.
 */
function isValidURL(el: Element): boolean {
  const href = el.getAttribute("href");
  if (href == null) {
    return false;
  }
  // I feel like it's useless to convert a string to a URL and return it,
  // There are too many situations where you have to pass the Element itself to rewrite the element, so it can't be helped.
  const url = new URL(href);
  if (url.hostname === "webcache.googleusercontent.com") {
    return false;
  }
  return true;
}

/**
 * Get the list of search result elements to replace.
 * The part that is most likely to be influenced by Google's specification change.
 */
function selectLinkElements(el: Element): Element[] {
  return Array.from(
    el.querySelectorAll('.g .yuRUbf a[href^="http"]:not(.fl)')
  ).filter(isValidURL);
}

/** Entry point. */
async function main(el: Element): Promise<void[]> {
  return replaceLinkTitles(selectLinkElements(el));
}

// Execute the entry point.
main(document.documentElement).catch((e) => {
  throw e;
});

// Corresponds to weAutoPagerize.
document.addEventListener("AutoPagerize_DOMNodeInserted", (event) => {
  if (!(event.target instanceof Element)) {
    throw new Error(
      `AutoPagerize_DOMNodeInserted: event.target is not Element. ${JSON.stringify(
        event
      )}`
    );
  }
  main(event.target).catch((e) => {
    throw e;
  });
});
