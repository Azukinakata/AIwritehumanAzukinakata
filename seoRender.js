'use strict';

// Server-side page content for the content routes.
//
// index.html is a single-page app that holds every content page as a hidden
// modal and opens the matching one in the browser. A crawler therefore saw the
// same homepage markup, with the same <h1>, at every URL. This module lifts the
// matching modal's title and body out of index.html at startup and, per route,
// puts them in the raw HTML response: the route's own <h1> replaces the
// homepage one, and the page body is rendered as a visible article.
// Add a route here when you add a content modal to index.html.

const ROUTE_MODALS = {
  '/terms':                                        'termsModal',
  '/privacy':                                      'privacyModal',
  '/refund':                                       'refundModal',
  '/blog/what-is-an-ai-humanizer':                 'blogHumanizerModal',
  '/ai-humanizer':                                 'aiHumanizerModal',
  '/ai-detector':                                  'aiDetectorModal',
  '/blog/ai-writing-guide':                        'blogWritingGuideModal',
  '/humanize-chatgpt-text':                        'humanizeChatgptModal',
  '/voice-matching':                               'voiceMatchingModal',
  '/api':                                          'apiModal',
  '/ai-humanizer-for-business':                    'aiHumanizerBusinessModal',
  '/ai-humanizer-for-seo':                         'aiHumanizerSeoModal',
  '/ai-humanizer-for-agencies':                    'aiHumanizerAgenciesModal',
  '/blog/how-to-make-ai-writing-sound-human':      'blogSoundHumanModal',
  '/blog/ai-humanizer-vs-ai-detector':             'blogVsModal',
  '/blog/how-to-make-chatgpt-emails-sound-human':  'blogEmailsModal',
  '/blog/how-to-humanize-chatgpt-text':            'blogHumanizeChatgptModal',
  '/blog/ai-humanizer-for-google-business-profile': 'blogGbpModal',
};

// Returns the markup of the <div> that starts at `start`, including its
// closing tag, by counting nested <div> / </div> pairs.
function balancedDiv(html, start) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return null;
}

function extractPage(html, modalId) {
  const at = html.indexOf(`id="${modalId}"`);
  if (at < 0) return null;
  const titleMatch = /<div class="modal-title">([\s\S]*?)<\/div>/.exec(html.slice(at, at + 4000));
  const bodyAt = html.indexOf('<div class="refund-body">', at);
  if (!titleMatch || bodyAt < 0) return null;
  const body = balancedDiv(html, bodyAt);
  if (!body) return null;
  return { h1: titleMatch[1].trim(), body };
}

function buildPages(indexHtml) {
  const pages = {};
  for (const [route, modalId] of Object.entries(ROUTE_MODALS)) {
    const page = extractPage(indexHtml, modalId);
    if (page) pages[route] = page;
  }
  return pages;
}

// Marks the page as server-rendered so the client script does not also pop the
// modal open over the article.
const SSR_FLAG = '<script>window.__SSR_ROUTE = true;</script>';

function injectPage(html, page) {
  return html
    .replace(/<h1 class="hero-title">[\s\S]*?<\/h1>/, () => `<h1 class="hero-title">${page.h1}</h1>`)
    .replace('</head>', () => `${SSR_FLAG}\n</head>`)
    // Article goes straight under the hero so the reader lands on the page's
    // content; the tool follows below it.
    .replace('</header>', () =>
      `</header>\n\n    <section class="seo-article" aria-label="${page.h1.replace(/"/g, '&quot;')}">\n${page.body}\n</section>`);
}

module.exports = { ROUTE_MODALS, buildPages, injectPage };
