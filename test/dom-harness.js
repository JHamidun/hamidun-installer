'use strict';
/**
 * dom-harness.js — стенд для экранов установщика.
 *
 * ЗАЧЕМ. `src/renderer/app.js` — 2500 строк, которые рисуют ВСЁ, что видит
 * человек: приветствие, выбор компонентов, прогресс, финиш. Тестов на него не
 * было ни одного, потому что он browser-скрипт: `require` его не берёт, а
 * выковыривать функции из текста регуляркой — это проверять пересказ вместо кода.
 *
 * КАК. Настоящий файл целиком исполняется в `vm`-контексте с маленьким DOM, а
 * дальше его функции просто зовутся по имени. `vm.runInContext` сохраняет
 * лексическое окружение скрипта между вызовами, поэтому видны и `let STATE`, и
 * объявленные функции — ничего экспортировать из app.js не пришлось.
 *
 * DOM здесь ровно такой, какой трогает renderer: id, классы, дерево, обработчики
 * событий и `offsetWidth` (renderer читает его ради reflow перед анимацией).
 * Селекторы поддерживаются те, что реально встречаются: `#id`, `.class`,
 * перечисление через запятую и потомок `#id .class`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createElement(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _id: '', className: '', innerHTML: '', textContent: '', src: '', alt: '',
    title: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {}, children: [], parentNode: null,
    _events: new Map(),
    // renderer читает offsetWidth ради принудительного reflow — значение не важно,
    // важно что чтение не падает.
    offsetWidth: 1,
    classList: {
      _s: new Set(),
      add(...c) { c.filter(Boolean).forEach((x) => this._s.add(x)); },
      remove(...c) { c.filter(Boolean).forEach((x) => this._s.delete(x)); },
      contains(x) { return this._s.has(x); },
      toggle(x, on) {
        if (on === undefined) { if (this._s.has(x)) this._s.delete(x); else this._s.add(x); }
        else if (on) this._s.add(x); else this._s.delete(x);
      },
      get length() { return this._s.size; },
      toString() { return Array.from(this._s).join(' '); },
    },
    setAttribute(k, v) {
      if (k === 'id') this.id = v;
      else if (k === 'class') this.className = v;
      else if (k === 'src') this.src = v;
      else this.dataset[k] = v;
    },
    getAttribute(k) {
      if (k === 'id') return this.id || null;
      if (k === 'class') return this.className || null;
      if (k === 'src') return this.src || null;
      return Object.prototype.hasOwnProperty.call(this.dataset, k) ? this.dataset[k] : null;
    },
    addEventListener(type, fn) {
      if (!this._events.has(type)) this._events.set(type, []);
      this._events.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._events.get(type) || [];
      this._events.set(type, l.filter((f) => f !== fn));
    },
    /** Ручной запуск события — тест «нажимает» на элемент. */
    fire(type, ev) { (this._events.get(type) || []).slice().forEach((f) => f.call(this, ev || { type })); },
    click() { this.fire('click'); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    },
    insertAdjacentElement(where, c) {
      const parent = this.parentNode || this;
      c.parentNode = parent;
      const i = parent.children.indexOf(this);
      if (where === 'afterend' && i >= 0) parent.children.splice(i + 1, 0, c);
      else if (where === 'beforebegin' && i >= 0) parent.children.splice(i, 0, c);
      else if (where === 'afterbegin') this.children.unshift(c);
      else parent.children.push(c);
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    },
    querySelector(sel) { return doc._find(sel, this)[0] || null; },
    querySelectorAll(sel) { return doc._find(sel, this); },
    closest(sel) {
      let n = this;
      while (n) { if (doc._matches(n, sel)) return n; n = n.parentNode; }
      return null;
    },
    focus() {}, blur() {}, scrollIntoView() {},
  };
  Object.defineProperty(el, 'id', {
    get() { return el._id; },
    set(v) { el._id = v; if (v) doc._ids.set(v, el); },
    enumerable: true, configurable: true,
  });
  return el;
}

function createDocument() {
  const doc = {
    _ids: new Map(),
    _listeners: new Map(),
    createElement(tag) { return createElement(tag, doc); },
    createTextNode(t) { const n = createElement('#text', doc); n.textContent = t; return n; },
    getElementById(id) {
      // Как в браузере: находится только то, что РЕАЛЬНО в дереве. Иначе стенд
      // «помнил» бы удалённые элементы, и проверка идемпотентности проходила бы
      // по призраку, а не по коду.
      const el = doc._ids.get(id);
      return el && doc._inTree(el) ? el : null;
    },
    querySelector(sel) { return doc._find(sel, doc.body)[0] || null; },
    querySelectorAll(sel) { return doc._find(sel, doc.body); },
    addEventListener(t, fn) {
      if (!doc._listeners.has(t)) doc._listeners.set(t, []);
      doc._listeners.get(t).push(fn);
    },
    removeEventListener() {},
    fire(t, ev) { (doc._listeners.get(t) || []).slice().forEach((f) => f(ev || { type: t })); },
  };

  doc._inTree = (el) => { let n = el; while (n) { if (n === doc.body) return true; n = n.parentNode; } return false; };

  const walk = (node, out) => {
    for (const c of node.children) { out.push(c); walk(c, out); }
    return out;
  };

  doc._matches = (el, sel) => {
    const s = String(sel).trim();
    if (!s) return false;
    if (s.startsWith('#')) return el.id === s.slice(1);
    if (s.startsWith('.')) {
      return s.slice(1).split('.').every((c) => el.classList.contains(c) ||
        String(el.className).split(/\s+/).includes(c));
    }
    return el.tagName === s.toUpperCase();
  };

  // Поддержаны формы, которые реально встречаются в renderer:
  //   «#id», «.class», «a, b» и потомок «#id .class».
  doc._find = (sel, root) => {
    const out = [];
    for (const part of String(sel).split(',')) {
      const steps = part.trim().split(/\s+/).filter(Boolean);
      if (!steps.length) continue;
      let scope = [root];
      for (const step of steps) {
        const next = [];
        for (const s of scope) for (const n of walk(s, [])) if (doc._matches(n, step)) next.push(n);
        scope = next;
      }
      for (const n of scope) if (!out.includes(n)) out.push(n);
    }
    return out;
  };

  doc.body = createElement('body', doc);
  doc.documentElement = createElement('html', doc);
  return doc;
}

/**
 * Собрать контекст и выполнить настоящий app.js.
 * @param {object} [opts]
 * @param {function} [opts.build] — достроить DOM до запуска: build(document, mk)
 * @param {object}   [opts.installer] — заглушка моста window.installer
 */
function loadRenderer(opts) {
  const o = opts || {};
  const document = createDocument();
  const mk = (tag) => document.createElement(tag);
  if (typeof o.build === 'function') o.build(document, mk);

  const timers = { intervals: new Set(), timeouts: new Set() };
  const sandbox = {
    document,
    navigator: { platform: 'Win32', clipboard: { writeText: async () => {} } },
    location: { href: '', reload() {} },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); timers.intervals.add(id); return id; },
    clearInterval: (id) => { clearInterval(id); timers.intervals.delete(id); },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.timeouts.add(id); return id; },
    clearTimeout: (id) => { clearTimeout(id); timers.timeouts.delete(id); },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: async () => { throw new Error('сеть в стенде запрещена'); },
  };
  sandbox.window = sandbox;
  sandbox.window.installer = o.installer || {};
  sandbox.globalThis = sandbox;

  const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), ctx, { filename: 'renderer/app.js' });

  return {
    ctx, document, mk, timers,
    /** Выполнить код В ТОМ ЖЕ лексическом окружении, что и app.js. */
    run: (code) => vm.runInContext(code, ctx),
    /** Снять все таймеры стенда — иначе прогон тестов не завершится. */
    dispose: () => {
      for (const id of timers.intervals) clearInterval(id);
      for (const id of timers.timeouts) clearTimeout(id);
      timers.intervals.clear(); timers.timeouts.clear();
    },
  };
}

module.exports = { loadRenderer, createDocument, createElement };
