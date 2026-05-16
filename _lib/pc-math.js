// Shared math + markdown utilities. Used by the main paperchat UI and by
// generated chapter-site pages, which inline this file into a self-contained
// HTML bundle. Depends on globals loaded via <script> in the host page:
//   - marked          (for stashMathAndRunMarked)
//   - renderMathInElement  (KaTeX auto-render, for renderMathIn)

const mathEscape = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Pull math regions out of text before running marked, then drop them back
// in afterwards so KaTeX can render them. Without this, a bare `=` line
// inside $$...$$ becomes a setext-heading underline, `_x_` becomes <em>, etc.
export function stashMathAndRunMarked(text) {
  const stash = [];
  const ph = (i) => `MATHSTASH${i}ENDX`;
  const codeRe = /```[\s\S]*?```|`[^`\n]+`/g;
  let processed = '';
  let last = 0;
  const protect = (chunk) => chunk
    .replace(/\$\$[\s\S]*?\$\$/g, m => {
      stash.push(m);
      return `\n\n${ph(stash.length - 1)}\n\n`;
    })
    .replace(/(?<!\\)\$([^\$\n]+?)\$/g, m => {
      stash.push(m);
      return ph(stash.length - 1);
    });
  for (let m; (m = codeRe.exec(text)); ) {
    processed += protect(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  processed += protect(text.slice(last));
  let html = marked.parse(processed);
  html = html.replace(/MATHSTASH(\d+)ENDX/g, (_, i) => mathEscape(stash[+i]));
  return html;
}

// Pre-marked normalizer for LLM math output. Two rules from gpt2md:
//   - postfix-operator merge:  $z$^2  → $z^2$   /   $z$_k → $z_k$
//   - whole-line promotion:     $x = y$  alone on a line → $$x = y$$
export function preprocessMarkdownMath(md) {
  if (!md || !md.includes('$')) return md;
  const re = /```[\s\S]*?```|`[^`\n]+`/g;
  let out = '', last = 0;
  for (let m; (m = re.exec(md)); ) {
    out += applyMathPreFixes(md.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + applyMathPreFixes(md.slice(last));
}

function applyMathPreFixes(s) {
  // Postfix arg must be braced, a \command, or a single alnum NOT followed
  // by another word char — that lookahead avoids clobbering markdown italic
  // like _word_.
  s = s.replace(
    /\$([^$\n]+)\$([_^])(\{[^{}]+\}|\\[A-Za-z]+|[A-Za-z0-9](?![A-Za-z0-9_]))/g,
    '$$$1$2$3$$'
  );
  // Up to 3 leading spaces (any more and markdown treats it as a code block).
  s = s.replace(/^( {0,3})\$([^$\n]+)\$[ \t]*$/gm, '$1$$$$$2$$$$');
  return s;
}

// Apply LaTeX repairs only inside math regions so we don't touch prose that
// happens to contain backslashes.
export function autoFixMathSyntax(text) {
  if (!text || (!text.includes('$') && !text.includes('\\['))) return text;
  return text.replace(
    /(\$\$[\s\S]*?\$\$|\$[^\$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g,
    (block) => block
      .replace(/(\\(?:mathcal|mathbb|mathbf|mathrm|mathit|mathfrak|mathsf|mathtt)\{[^{}]+\})\s*\{/g, '$1_{')
      .replace(/\\(sum|prod|int|oint|iint|iiint|coprod|max|min|sup|inf|lim|liminf|limsup|bigcup|bigcap|bigotimes|bigoplus|bigsqcup)\s*\{/g, '\\$1_{')
  );
}

// Walk text nodes (skipping <pre>/<code>) and apply autoFixMathSyntax.
export function fixMathInDom(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== root) {
        const tag = p.nodeType === 1 ? p.tagName : '';
        if (tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const fixed = autoFixMathSyntax(n.nodeValue);
    if (fixed !== n.nodeValue) n.nodeValue = fixed;
  }
}

// KaTeX defaults to output='htmlAndMathml' which emits a hidden mathml span.
// If page CSS interferes with the clip, the mathml leaks through and users
// see the formula twice. Force 'html' only — accessibility tools still read
// the surrounding alt text.
export function renderMathIn(el) {
  if (typeof window === 'undefined' || !window.renderMathInElement) return false;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'style', 'pre', 'code'],
      output: 'html',
      strict: false,
    });
    return true;
  } catch {
    return false;
  }
}

// One-shot: markdown text → fully-rendered HTML inside `el`. Handles math
// pre-fixes, marked, in-DOM math repair, and KaTeX rendering.
export function renderMarkdownWithMath(el, text) {
  el.innerHTML = stashMathAndRunMarked(preprocessMarkdownMath(text || ''));
  fixMathInDom(el);
  renderMathIn(el);
}

// Expose on window for chapter-site pages that inline this module as a
// classic <script> rather than importing it.
if (typeof window !== 'undefined') {
  window.pcMath = {
    renderMathIn,
    renderMarkdownWithMath,
    stashMathAndRunMarked,
    preprocessMarkdownMath,
    fixMathInDom,
    autoFixMathSyntax,
  };
}
