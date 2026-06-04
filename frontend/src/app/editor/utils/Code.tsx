import Editor from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import { File } from "../utils/FileManager";

interface CodeProps {
  selectedFile: File | undefined;
  onChange: (value: string | undefined) => void;
  isDark?: boolean;
  isVisible?: boolean;
  labels?: Partial<Record<string, string>>;
}

export const Code = ({
  selectedFile,
  onChange,
  isDark = false,
  isVisible = true,
  labels = {},
}: CodeProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const editorTheme = isDark ? "meshfire-dark" : "meshfire-light";
  const label = (key: string, fallback: string) => labels[key] || fallback;

  const scheduleEditorLayout = () => {
    if (!editorRef.current) return;

    requestAnimationFrame(() => {
      editorRef.current?.layout();
      requestAnimationFrame(() => editorRef.current?.layout());
    });
  };

  const configureMonaco = (monaco: any) => {
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });

    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });

    monaco.languages.html.htmlDefaults.setOptions({
      validate: false,
    });

    monaco.languages.css.cssDefaults.setOptions({
      validate: false,
    });

    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: false,
    });

    const meshfireDarkTheme = {
      base: "vs-dark",
      inherit: false,
      rules: [
        { token: "", foreground: "c8ccd4" },
        { token: "comment", foreground: "747a84", fontStyle: "italic" },
        { token: "keyword", foreground: "86a8c9" },
        { token: "string", foreground: "b9a77c" },
        { token: "string.key.json", foreground: "a9bdcf" },
        { token: "identifier", foreground: "c8ccd4" },
        { token: "number", foreground: "c0a77a" },
        { token: "delimiter", foreground: "848b95" },
        { token: "operator", foreground: "8f98a5" },
        { token: "type", foreground: "acb7c5" },
        { token: "tag", foreground: "9eb7cc" },
        { token: "attribute.name", foreground: "acb7c5" },
        { token: "attribute.value", foreground: "b9a77c" },
        { token: "variable", foreground: "c8ccd4" },
        { token: "function", foreground: "a9bdcf" },
      ],
      colors: {
        "editor.background": "#222223",
        "editor.foreground": "#c8ccd4",
        "editorLineNumber.foreground": "#6f7782",
        "editorLineNumber.activeForeground": "#a7b0bd",
        "editorCursor.foreground": "#8fb2d4",
        "editor.selectionBackground": "#31577d4d",
        "editor.selectionHighlightBackground": "#31577d1f",
        "editor.lineHighlightBackground": "#ffffff06",
        "editor.lineHighlightBorder": "#ffffff0a",
        "editorGutter.background": "#222223",
        "editorIndentGuide.background1": "#ffffff08",
        "editorIndentGuide.activeBackground1": "#8fb2d426",
        "editorBracketPairGuide.background1": "#ffffff06",
        "editorBracketPairGuide.background2": "#ffffff06",
        "editorBracketPairGuide.background3": "#ffffff06",
        "editorBracketPairGuide.background4": "#ffffff06",
        "editorBracketPairGuide.background5": "#ffffff06",
        "editorBracketPairGuide.background6": "#ffffff06",
        "editorBracketPairGuide.activeBackground1": "#8fb2d426",
        "editorBracketPairGuide.activeBackground2": "#8fb2d426",
        "editorBracketPairGuide.activeBackground3": "#8fb2d426",
        "editorBracketPairGuide.activeBackground4": "#8fb2d426",
        "editorBracketPairGuide.activeBackground5": "#8fb2d426",
        "editorBracketPairGuide.activeBackground6": "#8fb2d426",
        "editorBracketMatch.background": "#31577d1f",
        "editorBracketMatch.border": "#8fb2d440",
        "scrollbarSlider.background": "#ffffff10",
        "scrollbarSlider.hoverBackground": "#ffffff1c",
        "scrollbarSlider.activeBackground": "#ffffff28",
        "editorError.foreground": "#00000000",
        "editorError.background": "#00000000",
        "editorWarning.foreground": "#00000000",
        "editorWarning.background": "#00000000",
        "editorInfo.foreground": "#00000000",
        "editorInfo.background": "#00000000",
        "editorSquiggles.error": "#00000000",
        "editorSquiggles.warning": "#00000000",
        "editorSquiggles.info": "#00000000",
      },
    };

    monaco.editor.defineTheme("meshfire-light", {
      base: "vs",
      inherit: false,
      rules: [
        { token: "", foreground: "334155" },
        { token: "comment", foreground: "8b97a8", fontStyle: "italic" },
        { token: "keyword", foreground: "31577d" },
        { token: "string", foreground: "7a6240" },
        { token: "string.key.json", foreground: "315f89" },
        { token: "identifier", foreground: "334155" },
        { token: "number", foreground: "80643c" },
        { token: "delimiter", foreground: "7c8797" },
        { token: "operator", foreground: "64748b" },
        { token: "type", foreground: "475569" },
        { token: "tag", foreground: "315f89" },
        { token: "attribute.name", foreground: "475569" },
        { token: "attribute.value", foreground: "7a6240" },
        { token: "variable", foreground: "334155" },
        { token: "function", foreground: "315f89" },
      ],
      colors: {
        "editor.background": "#fbfdff",
        "editor.foreground": "#334155",
        "editorLineNumber.foreground": "#a5afbd",
        "editorLineNumber.activeForeground": "#64748b",
        "editorCursor.foreground": "#31577d",
        "editor.selectionBackground": "#31577d24",
        "editor.selectionHighlightBackground": "#31577d12",
        "editor.lineHighlightBackground": "#edf4fb",
        "editor.lineHighlightBorder": "#dce7f2",
        "editorGutter.background": "#fbfdff",
        "editorIndentGuide.background1": "#94a3b824",
        "editorIndentGuide.activeBackground1": "#31577d33",
        "editorBracketPairGuide.background1": "#94a3b818",
        "editorBracketPairGuide.background2": "#94a3b818",
        "editorBracketPairGuide.background3": "#94a3b818",
        "editorBracketPairGuide.background4": "#94a3b818",
        "editorBracketPairGuide.background5": "#94a3b818",
        "editorBracketPairGuide.background6": "#94a3b818",
        "editorBracketPairGuide.activeBackground1": "#31577d30",
        "editorBracketPairGuide.activeBackground2": "#31577d30",
        "editorBracketPairGuide.activeBackground3": "#31577d30",
        "editorBracketPairGuide.activeBackground4": "#31577d30",
        "editorBracketPairGuide.activeBackground5": "#31577d30",
        "editorBracketPairGuide.activeBackground6": "#31577d30",
        "editorBracketMatch.background": "#31577d12",
        "editorBracketMatch.border": "#31577d30",
        "scrollbarSlider.background": "#94a3b826",
        "scrollbarSlider.hoverBackground": "#64748b36",
        "scrollbarSlider.activeBackground": "#47556944",
        "editorError.foreground": "#00000000",
        "editorError.background": "#00000000",
        "editorWarning.foreground": "#00000000",
        "editorWarning.background": "#00000000",
        "editorInfo.foreground": "#00000000",
        "editorInfo.background": "#00000000",
        "editorSquiggles.error": "#00000000",
        "editorSquiggles.warning": "#00000000",
        "editorSquiggles.info": "#00000000",
      },
    });

    monaco.editor.defineTheme("meshfire-dark", meshfireDarkTheme);
    monaco.editor.defineTheme("no-errors", meshfireDarkTheme);

    monaco.editor.setTheme(editorTheme);
  };

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    configureMonaco(monaco);
    scheduleEditorLayout();
  };

  useEffect(() => {
    if (monacoRef.current) {
      configureMonaco(monacoRef.current);
      monacoRef.current.editor.setTheme(editorTheme);
    }
    scheduleEditorLayout();
  }, [editorTheme]);

  useEffect(() => {
    if (!isVisible) return;
    scheduleEditorLayout();
  }, [isVisible, selectedFile?.id, selectedFile?.content]);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(() => {
      scheduleEditorLayout();
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  if (!selectedFile) {
    return (
      <div
        className={`relative flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden ${
          isDark ? "bg-[#222223]" : "bg-white"
        }`}
      >
        <div
          className={`rounded-2xl border px-7 py-6 text-center ${
            isDark
              ? "border-[#3a3a3c] bg-[#222223]"
              : "border-slate-200 bg-white shadow-sm"
          }`}
        >
          <div className={`mb-2 text-lg ${isDark ? "text-zinc-300" : "text-slate-700"}`}>
            {label("noFileSelected", "No file selected")}
          </div>
          <div className={`text-sm ${isDark ? "text-zinc-500" : "text-slate-400"}`}>
            {label("selectFileToEdit", "Select a file from the sidebar to start editing")}
          </div>
        </div>
      </div>
    );
  }

  let language = selectedFile.name.split(".").pop();

  if (language === "js" || language === "jsx") language = "javascript";
  else if (language === "ts" || language === "tsx") language = "typescript";

  return (
    <div
      ref={containerRef}
      className={`relative m-0 flex h-full min-h-0 min-w-0 flex-1 overflow-hidden text-base ${
        isDark ? "bg-[#222223]" : "bg-white"
      }`}
    >
      <Editor
        className="meshfire-monaco-editor"
        height="100%"
        width="100%"
        language={language}
        value={selectedFile.content}
        theme={editorTheme}
        onChange={onChange}
        beforeMount={configureMonaco}
        onMount={handleEditorDidMount}
        options={{
          minimap: { enabled: false },
          fontSize: 15,
          fontFamily:
            "JetBrains Mono, Geist Mono, Menlo, Monaco, Consolas, monospace",
          lineNumbers: "on",
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: "on",
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          guides: {
            indentation: true,
            bracketPairs: false,
            bracketPairsHorizontal: false,
            highlightActiveIndentation: true,
          },
          smoothScrolling: true,
          cursorBlinking: "smooth",
          folding: true,
          foldingHighlight: true,
          showFoldingControls: "mouseover",
          padding: { top: 20, bottom: 20 },
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
        }}
      />
    </div>
  );
};
