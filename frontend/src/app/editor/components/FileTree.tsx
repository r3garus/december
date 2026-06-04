import { ChevronRight, GitBranch } from "lucide-react";
import React, { useState } from "react";
import { Directory, File, sortDir, sortFile } from "../utils/FileManager";
import { getIcon } from "./Icon";

interface FileTreeProps {
  rootDir: Directory;
  selectedFile: File | undefined;
  onSelect: (file: File) => void;
  isDark?: boolean;
  labels?: Partial<Record<string, string>>;
}

interface SubTreeProps extends FileTreeProps {
  directory: Directory;
  isRoot?: boolean;
}

interface TreeRowProps {
  item: File | Directory;
  isDirectory?: boolean;
  isOpen?: boolean;
  isSelected?: boolean;
  onClick: () => void;
  isDark?: boolean;
}

const fileChangeBadges: Record<string, string> = {
  "footer.tsx": "+4",
  "header.tsx": "+126",
  "hero.tsx": "+37",
  "pricing.tsx": "+40",
  "page.tsx": "+18",
  "layout.tsx": "+8",
  "index.tsx": "+12",
  "globals.css": "+22",
};

export const FileTree = (props: FileTreeProps) => {
  const fileCount = countFiles(props.rootDir);
  const label = (key: string, fallback: string) => props.labels?.[key] || fallback;
  const [rootOpen, setRootOpen] = useState(false);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setRootOpen((current) => !current)}
        className={`motion-list-item mx-0.5 flex w-[calc(100%-0.25rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
          props.isDark
            ? "bg-[#171c22]/72"
            : "bg-slate-100/58"
        }`}
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform duration-200 ${
            rootOpen ? "rotate-90" : ""
          } ${props.isDark ? "text-slate-600" : "text-slate-400"}`}
        />
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
              props.isDark
                ? "bg-[#31577d]/14 text-[#c8e2ff]"
                : "bg-white text-[#31577d]"
            }`}
          >
            <GitBranch className="h-3 w-3" />
          </span>
          <div className="min-w-0 flex-1">
            <div
              className={`truncate text-[12px] font-semibold ${
                props.isDark ? "text-slate-200" : "text-slate-800"
              }`}
            >
              {props.rootDir.name}
            </div>
            <div
              className={`mt-0.5 text-[9px] uppercase tracking-[0.16em] ${
                props.isDark ? "text-slate-500" : "text-slate-400"
              }`}
            >
              {label("workspaceFiles", "Workspace files")}
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
              props.isDark
                ? "bg-[#17191e] text-slate-500"
                : "bg-white text-slate-500"
            }`}
          >
            {fileCount}
          </span>
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ${
          rootOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <SubTree directory={props.rootDir} isRoot {...props} />
        </div>
      </div>
    </div>
  );
};

const SubTree = (props: SubTreeProps) => {
  const directories = [...props.directory.dirs].sort(sortDir);
  const files = [...props.directory.files].sort(sortFile);

  return (
    <div
      className={
        props.isRoot
          ? "space-y-0.5"
          : `relative ml-3 space-y-0.5 border-l pl-2 ${
              props.isDark ? "border-[#343840]" : "border-slate-200/80"
            }`
      }
    >
      {directories.map((dir) => (
        <DirDiv
          key={dir.id}
          directory={dir}
          selectedFile={props.selectedFile}
          onSelect={props.onSelect}
          isDark={props.isDark}
        />
      ))}
      {files.map((file) => (
        <TreeRow
          key={file.id}
          item={file}
          isSelected={Boolean(props.selectedFile && props.selectedFile.id === file.id)}
          onClick={() => props.onSelect(file)}
          isDark={props.isDark}
        />
      ))}
    </div>
  );
};

const TreeRow = ({
  item,
  isDirectory = false,
  isOpen = false,
  isSelected = false,
  onClick,
  isDark = false,
}: TreeRowProps) => {
  const extension = isDirectory
    ? isOpen
      ? "openDirectory"
      : "closedDirectory"
    : item.name.split(".").pop() || "";
  const changeBadge = isDirectory ? undefined : fileChangeBadges[item.name.toLowerCase()];

  return (
    <button
      type="button"
      className={`motion-list-item group relative flex h-6 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border px-1.5 text-left text-[11px] transition-all ${
        isSelected
          ? isDark
            ? "border-transparent bg-[#24364a] text-slate-100"
            : "border-transparent bg-[#edf6ff] text-slate-950"
          : isDirectory
          ? isDark
            ? "border-transparent text-slate-300 hover:bg-[#1d2229] hover:text-slate-100"
            : "border-transparent text-slate-600 hover:bg-slate-100/80 hover:text-slate-950"
          : isDark
          ? "border-transparent text-slate-500 hover:bg-[#1d2229] hover:text-slate-200"
          : "border-transparent text-slate-500 hover:bg-slate-100/70 hover:text-slate-800"
      }`}
      onClick={onClick}
      title={item.name}
    >
      {isSelected && (
        <span
          className={`absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full ${
            isDark ? "bg-[#9cc4ee]" : "bg-sky-500"
          }`}
        />
      )}
      {isDirectory ? (
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-90" : ""
          } ${isDark ? "text-slate-600 group-hover:text-slate-400" : "text-slate-400"}`}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[12px] ${
          isDirectory
            ? isDark
              ? "bg-[#d8bd79]/8"
              : "bg-amber-50"
            : isDark
            ? "bg-[#17191e]"
            : "bg-slate-100"
        }`}
      >
        {getIcon(extension, item.name)}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
      {changeBadge && (
        <span
          className={`shrink-0 rounded-full px-1 py-0.5 text-[9px] font-semibold leading-none ${
            isDark
              ? "bg-[#31577d]/18 text-[#c8e2ff]"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {changeBadge}
        </span>
      )}
      {isDirectory && (
        <span
          className={`shrink-0 rounded-full px-1 py-0.5 text-[9px] transition-opacity ${
            isOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          } ${
            isDark
              ? "bg-[#252932] text-slate-500"
              : "bg-slate-100 text-slate-400"
          }`}
        >
          {(item as Directory).dirs.length + (item as Directory).files.length}
        </span>
      )}
    </button>
  );
};

const DirDiv = ({
  directory,
  selectedFile,
  onSelect,
  isDark = false,
}: {
  directory: Directory;
  selectedFile: File | undefined;
  onSelect: (file: File) => void;
  isDark?: boolean;
}) => {
  const hasSelectedChild = selectedFile ? isChildSelected(directory, selectedFile) : false;
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-0.5">
      <TreeRow
        item={directory}
        isDirectory
        isOpen={open}
        isSelected={hasSelectedChild}
        onClick={() => setOpen((current: boolean) => !current)}
        isDark={isDark}
      />
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <SubTree
            rootDir={directory}
            directory={directory}
            selectedFile={selectedFile}
            onSelect={onSelect}
            isDark={isDark}
          />
        </div>
      </div>
    </div>
  );
};

const isChildSelected = (directory: Directory, selectedFile: File): boolean => {
  if (directory.files.some((file) => file.id === selectedFile.id)) return true;
  return directory.dirs.some((dir): boolean => isChildSelected(dir, selectedFile));
};

const countFiles = (directory: Directory): number =>
  directory.files.length +
  directory.dirs.reduce((total, dir) => total + countFiles(dir), 0);
