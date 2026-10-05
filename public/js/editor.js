// Embedded WYSIWYG email editor (contentEditable + execCommand), with merge variables, spintax and live preview.
import { esc, api, modal, toast } from './ui.js';

export const VARIABLES = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['full_name', 'Full name'], ['company', 'Company'],
  ['title', 'Job title'], ['website', 'Website'], ['phone', 'Phone'], ['email', 'Lead email'],
  ['sender_name', 'Sender name'], ['sender_email', 'Sender email'],
];
const BTN = [
  ['bold', '<b>B</b>', 'Bold (Ctrl+B)'], ['italic', '<i>I</i>', 'Italic (Ctrl+I)'], ['underline', '<u>U</u>', 'Underline (Ctrl+U)'], ['strikeThrough', '<s>S</s>', 'Strikethrough'],
  '|', ['insertUnorderedList', '• List', 'Bullet list'], ['insertOrderedList', '1. List', 'Numbered list'], ['outdent', '⇤', 'Outdent'], ['indent', '⇥', 'Indent'],
  '|', ['createLink', '🔗', 'Insert link'], ['unlink', 'Unlink', 'Remove link'], ['removeFormat', 'Tx', 'Clear formatting'],
  '|', ['undo', '↶', 'Undo'], ['redo', '↷', 'Redo'],
];

/** Basic client-side cleanup of pasted/edited HTML (server sanitizes again). */
export function cleanHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('script,style,iframe,object,embed,form,link,meta').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (['href', 'src'].includes(a.name) && /^\s*(javascript|data|vbscript):/i.test(a.value))) n.removeAttribute(a.name);
    }
  });
  return t.innerHTML;
}

export function createEditor(host, { value = '', placeholder = 'Write your email…', onChange, withSubject = null } = {}) {
  host.classList.add('editor');
  host.innerHTML = `
    <div class="editor-bar">
      ${BTN.map((b) => (b === '|' ? '<span class="sep"></span>' : `<button type="button" data-cmd="${b[0]}" title="${esc(b[2])}">${b[1]}</button>`)).join('')}
      <span class="sep"></span>
      <select data-role="vars" title="Insert variable"><option value="">{{ Variable }}</option>${VARIABLES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <button type="button" data-role="spin" title="Insert spintax {option A|option B}">{A|B}</button>
      <select data-role="size" title="Text size"><option value="">Size</option><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option><option value="6">Huge</option></select>
      <span class="grow"></span>
      <button type="button" data-role="preview" title="Preview with a sample lead">👁 Preview</button>
      <button type="button" data-role="src" title="Edit HTML source">&lt;/&gt;</button>
    </div>
    <div class="editor-body" contenteditable="true" data-placeholder="${esc(placeholder)}" spellcheck="true"></div>
    <textarea class="editor-src" style="display:none" spellcheck="false"></textarea>`;
  const body = host.querySelector('.editor-body');
  const src = host.querySelector('.editor-src');
  let srcMode = false;
  body.innerHTML = cleanHtml(value);

  const emit = () => onChange?.(api_.getHTML());
  const api_ = {
    getHTML: () => (srcMode ? src.value : body.innerHTML).replace(/^(<br>|\s)+$/, ''),
    setHTML: (h) => { body.innerHTML = cleanHtml(h); src.value = h; },
    focus: () => body.focus(),
    insertText(text) {
      if (srcMode) { const s = src.selectionStart; src.setRangeText(text, s, src.selectionEnd, 'end'); }
      else { body.focus(); document.execCommand('insertText', false, text); }
      emit();
    },
    el: host,
  };

  host.addEventListener('mousedown', (e) => { if (e.target.closest('.editor-bar button')) e.preventDefault(); }); // keep selection
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.cmd) {
      if (srcMode) return;
      body.focus();
      if (b.dataset.cmd === 'createLink') {
        const url = prompt('Link URL (https://…)');
        if (url && /^(https?:\/\/|mailto:)/i.test(url)) document.execCommand('createLink', false, url);
        else if (url) toast('Links must start with http://, https:// or mailto:', 'bad');
      } else document.execCommand(b.dataset.cmd, false, null);
      emit();
    } else if (b.dataset.role === 'spin') {
      api_.insertText('{Option A|Option B}');
    } else if (b.dataset.role === 'src') {
      if (!srcMode) { src.value = body.innerHTML; src.style.display = ''; body.style.display = 'none'; b.classList.add('on'); srcMode = true; }
      else { body.innerHTML = cleanHtml(src.value); src.style.display = 'none'; body.style.display = ''; b.classList.remove('on'); srcMode = false; }
    } else if (b.dataset.role === 'preview') preview();
  });
  host.addEventListener('change', (e) => {
    const s = e.target.closest('select'); if (!s || !s.value) return;
    if (s.dataset.role === 'vars') api_.insertText(`{{${s.value}}}`);
    if (s.dataset.role === 'size') { body.focus(); document.execCommand('fontSize', false, s.value); emit(); }
    s.value = '';
  });
  body.addEventListener('input', emit);
  src.addEventListener('input', emit);
  body.addEventListener('paste', (e) => { // paste cleaned HTML only
    const html = e.clipboardData.getData('text/html');
    if (html) { e.preventDefault(); document.execCommand('insertHTML', false, cleanHtml(html.replace(/<\/?(html|body|meta|!--)[^>]*>/gi, ''))); emit(); }
  });

  async function preview() {
    const subject = withSubject?.() ?? '';
    let out;
    try { out = await api('POST', '/preview', { subject, body: api_.getHTML() }); } catch (e) { return toast(e.message, 'bad'); }
    const m = modal({ title: 'Preview', subtitle: 'Rendered for a sample lead (Alex Morgan, Acme Inc). Spintax picks a random variant.', wide: true, actions: false,
      body: `<div class="mt-s"><b>Subject:</b> ${esc(out.subject)}</div><iframe class="preview mt-s" sandbox="" srcdoc="${esc('<body style="font-family:Arial,sans-serif;font-size:14px;color:#222">' + out.html + '</body>')}"></iframe><div class="actions"><button data-x="cancel">Close</button></div>` });
    return m;
  }
  return api_;
}
