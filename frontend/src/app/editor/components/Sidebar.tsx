import { ReactNode } from "react";

export const Sidebar = ({
  children,
  isDark = false,
}: {
  children: ReactNode;
  isDark?: boolean;
}) => {
  return (
    <aside
      className={`relative flex h-full w-[248px] flex-col overflow-hidden border-r ${
        isDark
          ? "border-[#262b33] bg-[#12161b]"
          : "border-slate-200/70 bg-[#fbfdff]"
      }`}
    >
      {children}
    </aside>
  );
};

export default Sidebar;
