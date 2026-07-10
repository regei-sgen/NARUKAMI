// Wires Monaco to run FULLY offline (Vite-bundled workers, no CDN) and registers
// the red/black "narukami" theme. Imported for side-effects before <Editor> mounts.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// --- TypeScript / JavaScript language service tuning ---
// The full `monaco-editor` build (module entry = editor.main.js) already registers
// every basic-language tokenizer (php, python, go, ruby, …) plus the ts/js/css/html/json
// language services, so highlighting works out of the box. Two defaults still bite:
//   1. JSX is OFF by default → every .tsx/.jsx file flags valid JSX as syntax errors.
//   2. This is a single-file editor with no project graph, so semantic validation
//      reports false "Cannot find module 'react'" / "Cannot find name" errors everywhere.
// Enable JSX and disable semantic (not syntactic) validation so highlighting + real
// syntax checks stay, without the red-squiggle spam.
for (const defaults of [
  monaco.languages.typescript.typescriptDefaults,
  monaco.languages.typescript.javascriptDefaults,
]) {
  defaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.React,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    noEmit: true,
  });
  defaults.setDiagnosticsOptions({
    noSemanticValidation: true, // no project graph here → module/type errors are all false positives
    noSyntaxValidation: false, // keep real syntax errors (unbalanced braces, bad JSX, …)
  });
}

monaco.editor.defineTheme('narukami', {
  base: 'vs-dark',
  inherit: true,
  // Tempered Glass v2 syntax mapping: keywords wear the blade (--accent-2), comments
  // take the chrome ink (--text-dim), and identifiers/types/strings/numbers borrow the
  // graph families (--g-func/--g-file/--g-class/--g-project) on the --bg-well ground.
  rules: [
    { token: '', foreground: 'e8e8ee', background: '050506' },
    { token: 'comment', foreground: '8a8a97', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff5561' },
    { token: 'keyword.control', foreground: 'ff5561' },
    { token: 'string', foreground: '3ed9a6' },
    { token: 'number', foreground: 'f3c969' },
    { token: 'regexp', foreground: 'f3c969' },
    { token: 'type', foreground: '58b7ff' },
    { token: 'type.identifier', foreground: '58b7ff' },
    { token: 'function', foreground: 'b28dff' },
    { token: 'variable', foreground: 'e8e8ee' },
    { token: 'variable.predefined', foreground: '7d83ff' },
    { token: 'constant', foreground: 'f3c969' },
    { token: 'tag', foreground: 'ff5561' },
    { token: 'attribute.name', foreground: 'b28dff' },
    { token: 'attribute.value', foreground: '3ed9a6' },
    { token: 'delimiter', foreground: '8a8a97' },
    // JSON emits language-specific tokens; vs-dark's own rules for these are more
    // specific than the generic `string` rule above, so pin them to the v2 palette.
    { token: 'string.key.json', foreground: 'b28dff' },
    { token: 'string.value.json', foreground: '3ed9a6' },
    { token: 'keyword.json', foreground: 'ff5561' },
  ],
  colors: {
    'editor.background': '#050506',
    'editor.foreground': '#e8e8ee',
    'editorGutter.background': '#050506',
    'editorLineNumber.foreground': '#3a3a44',
    'editorLineNumber.activeForeground': '#ff5561',
    'editorCursor.foreground': '#ff2d3c',
    'editor.selectionBackground': '#ff2d3c44',
    'editor.inactiveSelectionBackground': '#ff2d3c22',
    'editor.lineHighlightBackground': '#121218',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#1c1c22',
    'editorIndentGuide.activeBackground1': '#3a1418',
    'editorWhitespace.foreground': '#1c1c22',
    'editorWidget.background': '#0d0d11',
    'editorWidget.border': '#26262f',
    'input.background': '#08080a',
    'focusBorder': '#ff2d3c',
    'scrollbarSlider.background': '#26262f88',
    'scrollbarSlider.hoverBackground': '#b0061488',
    'scrollbarSlider.activeBackground': '#ff2d3caa',
    'minimap.background': '#050506',
  },
});

// Tell @monaco-editor/react to use this locally-bundled instance (no CDN fetch).
loader.config({ monaco });

export { monaco };
