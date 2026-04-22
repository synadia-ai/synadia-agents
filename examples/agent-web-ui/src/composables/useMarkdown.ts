import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";

import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("go", go);
hljs.registerLanguage("golang", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c++", cpp);

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function highlightCode(code: string, lang: string | undefined): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch (e) {
      console.warn("highlight failed:", e);
    }
  }
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }) {
  const langLabel = lang || "text";
  const highlighted = highlightCode(text, lang);
  const encodedCode = encodeURIComponent(text);
  return (
    `<div class="md-code-block" data-language="${escapeHtml(langLabel)}">` +
    `<div class="md-code-header">` +
    `<span class="md-code-lang">${escapeHtml(langLabel)}</span>` +
    `<button class="md-code-copy" data-code="${encodedCode}">Copy</button>` +
    `</div>` +
    `<pre><code class="hljs">${highlighted}</code></pre>` +
    `</div>`
  );
};

renderer.link = function ({ href, title, text }) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return (
    `<a href="${escapeHtml(href)}"${titleAttr} ` +
    `target="_blank" rel="noopener noreferrer">${text}</a>`
  );
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer,
});

const purifyConfig = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote",
    "pre", "code",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "strong", "em", "s", "del",
    "div", "span", "button",
  ],
  ALLOWED_ATTR: [
    "class", "style", "href", "target", "rel", "title",
    "data-language", "data-code",
  ],
  ALLOW_DATA_ATTR: true,
};

export function useMarkdown() {
  function renderMarkdown(content: string): string {
    if (!content) return "";
    const html = marked.parse(content);
    if (typeof html !== "string") {
      // marked.parse returns Promise<string> only when `async: true`; we don't
      // set that, so this branch never runs. Just guard the types.
      return "";
    }
    return DOMPurify.sanitize(html, purifyConfig);
  }

  return { renderMarkdown };
}
