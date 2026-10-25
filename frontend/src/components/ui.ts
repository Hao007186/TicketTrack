// 共用的 Tailwind class，讓按鈕、輸入框在各頁看起來一致

export const buttonPrimary =
  "inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300";

export const buttonSecondary =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400";

export const buttonDanger =
  "inline-flex items-center justify-center rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-400";

export const input =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 focus:outline-none";

export const label = "mb-1 block text-sm font-medium text-slate-700";

export const card = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm";

export const errorBox = "rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700";
